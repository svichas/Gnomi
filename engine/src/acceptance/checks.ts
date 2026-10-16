import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { LlmAttempt } from '../seams.ts';

export type Mode = 'scripted' | 'live';
export type Status = 'PASS' | 'FAIL' | 'REVIEW_NEEDED' | 'NOT_RUN';
export type Provider = 'anthropic' | 'deepseek';
export const KEY_ENV: Record<Provider, string> = { anthropic: 'ANTHROPIC_API_KEY', deepseek: 'DEEPSEEK_API_KEY' };
export const FULL_POPULATION = 50;
// personas and seeds shrink a live run to save spend; criteria set at full scale then stay NOT_RUN
export interface Options { mode: Mode; out: string; allowance_usd?: number; m4?: true; m3?: true; provider: Provider; personas: number; seeds?: number }
export interface Criterion { id: string; status: Status; live_required: boolean; detail: string }
export const BILLING_CAVEAT = 'The allowance stops new work at recorded spend. Already-dispatched calls may still be billed; missing provider usage makes the final bill uncertain. This is not a provider billing cap.';

export function parseOptions(args: string[]): Options {
  const { values } = parseArgs({ args, options: { live: { type: 'boolean' }, m4: { type: 'boolean' }, m3: { type: 'boolean' }, out: { type: 'string' }, 'allowance-usd': { type: 'string' }, provider: { type: 'string' }, personas: { type: 'string' }, seeds: { type: 'string' } } });
  const allowance_usd = values['allowance-usd'] === undefined ? undefined : Number(values['allowance-usd']);
  if (allowance_usd !== undefined && (!Number.isFinite(allowance_usd) || allowance_usd <= 0)) throw new Error('--allowance-usd must be a finite positive recorded-spend allowance.');
  if (values.m3 && values.m4) throw new Error('Choose one of --m3 and --m4.');
  const provider = values.provider ?? 'anthropic';
  if (!(provider in KEY_ENV)) throw new Error(`--provider must be one of ${Object.keys(KEY_ENV).join(', ')}.`);
  const whole = (name: string, value: string | undefined, max: number) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`--${name} must be a whole number from 1 to ${max}.`);
    return n;
  };
  return {
    mode: values.live ? 'live' : 'scripted', out: resolve(values.out ?? `acceptance-results/${new Date().toISOString().replaceAll(':', '-')}`), provider: provider as Provider,
    personas: values.personas === undefined ? FULL_POPULATION : whole('personas', values.personas, FULL_POPULATION),
    ...(values.seeds === undefined ? {} : { seeds: whole('seeds', values.seeds, 5) }),
    ...(allowance_usd === undefined ? {} : { allowance_usd }), ...(values.m4 ? { m4: true as const } : {}), ...(values.m3 ? { m3: true as const } : {}),
  };
}

export function validateOptions(options: Options, env: Record<string, string | undefined>): void {
  if (options.mode !== 'live') return;
  if (!Number.isFinite(options.allowance_usd) || !(options.allowance_usd! > 0)) throw new Error('Live acceptance requires --allowance-usd with an explicit positive recorded-spend allowance.');
  if (!env[KEY_ENV[options.provider]]?.trim()) throw new Error(`Live ${options.provider} acceptance requires ${KEY_ENV[options.provider]} in the local environment.`);
}

/** Shared by both cases; late attempts remain counted after cancellation. */
export function createAllowance(limit: number) {
  const controller = new AbortController();
  let spent = 0;
  let unknown = 0;
  return {
    signal: controller.signal,
    spent: () => spent,
    unknown: () => unknown,
    check: () => controller.signal.throwIfAborted(),
    observe(attempt: LlmAttempt) {
      spent += attempt.payload.cost_usd;
      if (attempt.payload.usage_reported !== true) {
        unknown++;
        controller.abort(new Error('Provider usage is missing; stopped further acceptance calls because total billing is uncertain.'));
      } else if (spent >= limit) controller.abort(new Error('The acceptance recorded-spend allowance was reached.'));
    },
  };
}

/** The engine sees its attempt first so its precise budget reason wins; accounting survives an observer error. */
export function observeAttempt(attempt: LlmAttempt, onAttempt: ((attempt: LlmAttempt) => void) | undefined, allowance: ReturnType<typeof createAllowance> | null, write: (attempt: LlmAttempt) => void): void {
  try {
    onAttempt?.(attempt);
  } finally {
    try { allowance?.observe(attempt); } finally { write(attempt); }
  }
}

export interface Facts {
  population: number; terminal: number; goal_completed: number; blocked: number; run_status: string;
  duration_ms: number; cost_usd: number; unknown_usage: number; peak_contexts: number; replay_equal: boolean;
}

/** Structural failures fail even a scripted rehearsal; quality and performance remain separate live claims. */
export function executionCriterion(facts: Facts, expected: number): Criterion {
  return {
    id: 'execution', status: facts.population === expected && facts.terminal === expected && facts.blocked === 0 && facts.run_status === 'finished' ? 'PASS' : 'FAIL', live_required: false,
    detail: `Expected ${expected} personas and terminal episodes; observed ${facts.population} personas, ${facts.terminal} terminal, ${facts.blocked} blocked, run ${facts.run_status}.`,
  };
}

export function assess(mode: Mode, facts: Facts, expected = FULL_POPULATION): Criterion[] {
  const check = (id: string, condition: boolean, detail: string, live_required = true): Criterion => ({
    id, status: live_required && mode !== 'live' ? 'NOT_RUN' : condition ? 'PASS' : 'FAIL', live_required, detail,
  });
  // Time, cost and 12 browsers are targets for fifty people; a smaller run reports its figures without passing or failing them.
  const reduced = (criterion: Criterion): Criterion => expected < FULL_POPULATION && ['duration', 'recorded_cost', 'concurrency'].includes(criterion.id)
    ? { ...criterion, status: 'NOT_RUN', detail: `Reduced scale (${expected} of ${FULL_POPULATION} personas): ${criterion.detail}` } : criterion;
  return ([
    executionCriterion(facts, expected),
    check('population', facts.population === expected && facts.terminal === expected && facts.blocked === 0 && facts.run_status === 'finished', `${facts.terminal}/${facts.population} episodes ended; ${facts.goal_completed} reached their task goal; ${facts.blocked} blocked.`),
    check('duration', facts.duration_ms < 30 * 60_000, `${facts.duration_ms} ms; acceptance requires strictly under 1,800,000 ms.`),
    { ...check('recorded_cost', facts.cost_usd < 5, `$${facts.cost_usd} recorded; ${facts.unknown_usage} attempts have missing usage; acceptance requires under $5 with complete usage.`), ...(mode === 'live' && facts.cost_usd < 5 && facts.unknown_usage > 0 ? { status: 'REVIEW_NEEDED' as const } : {}) },
    check('concurrency', facts.peak_contexts === 12, `Configured for 12; observed peak ${facts.peak_contexts} browser contexts.`, false),
    check('replay', facts.replay_equal, 'The report rebuilt from the reopened SQLite event log matches the saved report.', false),
    { id: 'profile_adherence', status: mode === 'live' ? 'REVIEW_NEEDED' : 'NOT_RUN', live_required: true, detail: 'Review the frozen profiles against recorded thoughts/actions in review.md; no automatic quality judgment is made.' },
    { id: 'live_persona_writer', status: 'NOT_RUN', live_required: true, detail: 'Browsing-only evaluation uses authored fixture prose; no live persona writer was called.' },
  ] satisfies Criterion[]).map(reduced);
}
