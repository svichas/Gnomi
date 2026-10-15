import type { LlmAttempt, LlmGateway, LlmRequest, LlmResult, Recorder, Responder } from '../seams.ts';
import type { LlmRole } from '../types.ts';
import { InvalidOutputError, retryParts, transcriptRequest } from './gateway.ts';

/** One entry per model call: the raw output object, or a function of the request that returns it. */
export type Script = Array<object | ((req: LlmRequest<unknown>) => unknown)>;

/** Page-independent, so GNOMI_FAKE_LLM=1 works on any site; every text says plainly that no model ran. */
const DEMO_STEPS = [
  {
    thought: 'Scripted demo, no model is running. Scrolling to look the page over.',
    feeling: 0,
    action: { type: 'scroll', ref: null, text: 'down' },
    friction: null,
  },
  {
    thought: 'Scripted demo: logging a sample friction so the report has one to show.',
    feeling: -1,
    action: { type: 'scroll', ref: null, text: 'up' },
    friction: {
      severity: 1,
      what: 'Sample friction from the scripted demo persona; no model looked at this page',
      expected: 'A run with a model API key, which reports real frictions',
    },
    opinion: {
      sentiment: -1,
      confidence: 0.5,
      likes: ['Sample like from the scripted demo: clear navigation; no model assessed this page'],
      frictions: ['Sample friction from the scripted demo persona; no model looked at this page'],
    },
  },
  {
    thought: 'Scripted demo: stopping here.',
    feeling: 0,
    action: { type: 'abandon', ref: null, text: 'Scripted demo run: no model was called' },
    friction: null,
  },
];

export const DEMO_SCRIPT: Script = DEMO_STEPS;

/** Every persona of every run plays the three demo steps in turn; counted per run, so the next run starts over. */
export const DEMO_NAVIGATOR: Responder = (() => {
  const calls = new Map<string, number>();
  return (req) => {
    const key = `${req.run_id}/${req.persona_id}`;
    const n = calls.get(key) ?? 0;
    calls.set(key, n + 1);
    return DEMO_STEPS[Math.min(n, DEMO_STEPS.length - 1)];
  };
})();

/** The ref of the first `- role "name" … [ref=eN]` line in the request's page snapshot, for scripts that walk a known site. */
export function findRef(req: LlmRequest<unknown>, role: string, name: string): string | null {
  const text = req.user.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`- ${role} "${quoted}".*?\\[ref=([^\\]\\s]+)\\]`).exec(text)?.[1] ?? null;
}

/**
 * A gateway with no model behind it. `script` is either an array that answers the calls one after another whatever their
 * role, or a responder per role. Each attempt costs `costPerCall`, so budget tests can spend fake money.
 */
export function createScriptedGateway(script: Script | Partial<Record<LlmRole, Responder>>, record: Recorder, opts: { costPerCall?: number } = {}): LlmGateway {
  const costPerCall = opts.costPerCall ?? 0;
  let next = 0;
  const respond = (req: LlmRequest<unknown>): unknown => {
    if (!Array.isArray(script)) {
      const responder = script[req.role];
      if (!responder) throw new Error(`The script has no responder for the ${req.role} role`);
      return responder(req);
    }
    if (next >= script.length) throw new Error(`The script ran out after ${script.length} model calls`);
    const entry = script[next++];
    return typeof entry === 'function' ? entry(req) : entry;
  };

  return {
    async call<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      let user = req.user;
      let spent = 0;
      for (let attemptNo = 1; ; attemptNo++) {
        req.signal?.throwIfAborted();
        const output = respond({ ...req, user });
        const parsed = req.schema.safeParse(output);
        const error = parsed.success ? null : parsed.error.message;
        spent += costPerCall;
        const attempt: LlmAttempt = {
          payload: {
            role: req.role, provider: 'scripted', model: req.model.model,
            input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
            cost_usd: costPerCall, latency_ms: 0, usage_reported: true,
            status: parsed.success ? 'ok' : 'invalid_output', error,
          },
          transcript: { request: transcriptRequest(req, user), response: { output, error } },
        };
        if (req.run_id !== null) {
          record(
            {
              run_id: req.run_id,
              round: req.round,
              persona_id: req.persona_id,
              poi_id: null,
              type: 'llm.call',
              payload: attempt.payload,
            },
            attempt.transcript,
          );
        }
        req.onAttempt?.(attempt);
        if (parsed.success) return { object: parsed.data, cost_usd: spent };
        req.signal?.throwIfAborted();
        if (attemptNo === 2) throw new InvalidOutputError(`Invalid output twice: ${error}`);
        user = retryParts(req.user, error ?? '');
      }
    },
  };
}
