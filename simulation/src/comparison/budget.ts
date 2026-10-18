import { costUsd, isPriced } from '../llm/prices.ts';
import type { RunSettings } from '../types.ts';
import type { LlmGateway } from '../seams.ts';

export type ComparisonCallKind = 'navigation' | 'assessment' | 'verification';
/** Comparison requests have explicit output caps and at most one retry. Input bounds include schema/instruction headroom. */
export const COMPARISON_CALL_BOUNDS = {
  navigation: { input: 40_000, output: 4096 },
  assessment: { input: 36_000, output: 9000 },
  verification: { input: 36_000, output: 3000 },
} as const;
export const COMPARISON_MAX_ATTEMPTS = 2;
export const comparisonCallKind = (purpose?: string): ComparisonCallKind => purpose === 'comparison_assessment' ? 'assessment' : purpose === 'comparison_verification' ? 'verification' : 'navigation';

export function comparisonCallCost(settings: RunSettings, kind: ComparisonCallKind, input: number = COMPARISON_CALL_BOUNDS[kind].input, at?: Date): number | null {
  const model = settings.routing[kind === 'navigation' ? 'navigator' : 'judge'];
  return isPriced(model) ? COMPARISON_MAX_ATTEMPTS * costUsd(model, { input_tokens: Math.max(input, COMPARISON_CALL_BOUNDS[kind].input), output_tokens: COMPARISON_CALL_BOUNDS[kind].output, cache_read_tokens: 0, cache_write_tokens: 0 }, at) : null;
}

export function comparisonBlockCost(settings: RunSettings, targets: number, maxSteps: number, at?: Date) {
  const navigation = targets * maxSteps * (comparisonCallCost(settings, 'navigation', undefined, at) ?? 0);
  const assessment = targets * (comparisonCallCost(settings, 'assessment', undefined, at) ?? 0);
  const verification = targets * (comparisonCallCost(settings, 'verification', undefined, at) ?? 0);
  return { navigation, assessment, verification, total: navigation + assessment + verification };
}

/** Pending and active obligations remain reserved; finishing one block cannot release another block's review allowance. */
export function createComparisonBudget(deps: { settings: RunSettings; analysisReserve: number; spent(): number; navigationSpent(): number }) {
  const { settings } = deps;
  type Reservation = Record<ComparisonCallKind, number>;
  const blocks = new Map<string, Reservation>();
  const active = new Set<{ remaining: number; kind: ComparisonCallKind }>();
  let uncertain = 0;
  const sum = (value: Reservation) => value.navigation + value.assessment + value.verification;
  const reserved = () => [...blocks.values()].reduce((n, item) => n + sum(item), uncertain) + [...active].reduce((n, item) => n + item.remaining, 0);
  const navigationReserved = () => [...blocks.values()].reduce((n, item) => n + item.navigation, 0) + [...active].filter((item) => item.kind === 'navigation').reduce((n, item) => n + item.remaining, 0);
  return {
    reserved,
    hasBlock: (id: string) => blocks.has(id),
    admit(id: string, targets: number, maxSteps: number) {
      const cost = comparisonBlockCost(settings, targets, maxSteps);
      if (deps.spent() + reserved() + cost.total > settings.cost_budget_usd + 1e-9 || deps.navigationSpent() + navigationReserved() + cost.navigation > settings.cost_budget_usd * (1 - deps.analysisReserve) + 1e-9) return false;
      blocks.set(id, { navigation: cost.navigation, assessment: cost.assessment, verification: cost.verification });
      return true;
    },
    startCall(id: string, kind: ComparisonCallKind, inputTokens: number) {
      const block = blocks.get(id);
      if (!block) return null;
      const allocation = comparisonCallCost(settings, kind) ?? 0;
      const needed = comparisonCallCost(settings, kind, inputTokens) ?? 0;
      if (deps.spent() + reserved() + Math.max(0, needed - allocation) > settings.cost_budget_usd + 1e-9) return null;
      // Each call takes only its own reservation; the other roles and blocks remain untouched.
      if (block[kind] + 1e-9 < allocation) return null;
      block[kind] = Math.max(0, block[kind] - allocation);
      const held = { remaining: needed, kind };
      active.add(held);
      let unknown = false;
      let charged = 0;
      return {
        attempt(cost: number, usageReported: boolean) {
          charged += cost;
          unknown ||= !usageReported;
          held.remaining = Math.max(0, needed - charged);
          return deps.spent() + reserved() <= settings.cost_budget_usd + 1e-9;
        },
        finish() {
          active.delete(held);
          if (unknown) uncertain += held.remaining;
        },
      };
    },
    finishBlock(id: string) { blocks.delete(id); },
  };
}

/** Enforce the reserved retry/output policy at the gateway boundary, including provider retries. */
export function comparisonBudgetGateway(ledger: ReturnType<typeof createComparisonBudget>, blockId: string, llm: LlmGateway, onOverrun: () => void): LlmGateway {
  return { async call(req) {
    const kind = comparisonCallKind(req.purpose);
    const chars = req.system.length + (req.shared?.length ?? 0) + req.user.reduce((n, item) => n + (item.type === 'text' ? item.text.length : 0), 0);
    const input = Math.ceil(chars / 3) + req.user.filter((item) => item.type === 'image').length * 2000 + 4000;
    const reservation = ledger.startCall(blockId, kind, input);
    if (!reservation) throw new Error('The remaining allowance cannot cover this request without spending another task’s reserved evidence review.');
    const retryStop = new AbortController();
    let attempts = 0;
    let returned = false;
    try {
      const result = await llm.call({ ...req, max_output_tokens: COMPARISON_CALL_BOUNDS[kind].output,
        signal: req.signal ? AbortSignal.any([req.signal, retryStop.signal]) : retryStop.signal,
        onAttempt(attempt) {
          attempts++;
          const fits = reservation.attempt(attempt.payload.cost_usd, attempt.payload.usage_reported === true);
          if (!fits) { onOverrun(); retryStop.abort(new Error('Recorded charges exceeded the reserved comparison allowance.')); }
          if (attempt.payload.status !== 'ok' && (attempts >= COMPARISON_MAX_ATTEMPTS || attempt.payload.usage_reported !== true)) retryStop.abort(new Error('The comparison request exhausted its reserved attempts or has unknown billed usage.'));
          req.onAttempt?.(attempt);
        },
      });
      returned = true;
      // Custom recorded gateways may omit attempt notifications; their returned aggregate still reconciles the reservation.
      if (!attempts && !reservation.attempt(result.cost_usd, true)) onOverrun();
      return result;
    } finally {
      if (!attempts && !returned) reservation.attempt(0, false);
      reservation.finish();
    }
  } };
}
