import type { LlmGateway, LlmRequest, LlmResult, Recorder } from '../seams.ts';
import { InvalidOutputError, retryParts, transcriptRequest } from './gateway.ts';

/** One entry per model call: the raw output object, or a function of the request that returns it. */
export type Script = Array<object | ((req: LlmRequest<unknown>) => unknown)>;

/** Page-independent, so GNOMI_FAKE_LLM=1 works on any site; every text says plainly that no model ran. */
export const DEMO_SCRIPT: Script = [
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
      expected: 'A run with an Anthropic key, which reports real frictions',
    },
  },
  {
    thought: 'Scripted demo: stopping here.',
    feeling: 0,
    action: { type: 'abandon', ref: null, text: 'Scripted demo run: no model was called' },
    friction: null,
  },
];

/** The ref of the first `- role "name" … [ref=eN]` line in the request's page snapshot, for scripts that walk a known site. */
export function findRef(req: LlmRequest<unknown>, role: string, name: string): string | null {
  const text = req.user.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`- ${role} "${quoted}".*?\\[ref=([^\\]\\s]+)\\]`).exec(text)?.[1] ?? null;
}

export function createScriptedGateway(script: Script, record: Recorder): LlmGateway {
  let next = 0;
  return {
    async call<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      let user = req.user;
      for (let attempt = 1; ; attempt++) {
        if (next >= script.length) throw new Error(`The script ran out after ${script.length} model calls`);
        const entry = script[next++];
        const output = typeof entry === 'function' ? entry({ ...req, user }) : entry;
        const parsed = req.schema.safeParse(output);
        const error = parsed.success ? null : parsed.error.message;
        record(
          {
            run_id: req.run_id,
            round: req.round,
            persona_id: req.persona_id,
            poi_id: null,
            type: 'llm.call',
            payload: {
              role: req.role,
              provider: 'scripted',
              model: req.model,
              input_tokens: 0,
              output_tokens: 0,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              cost_usd: 0,
              latency_ms: 0,
              status: parsed.success ? 'ok' : 'invalid_output',
              error,
            },
          },
          { request: transcriptRequest(req, user), response: { output, error } },
        );
        if (parsed.success) return { object: parsed.data, cost_usd: 0 };
        if (attempt === 2) throw new InvalidOutputError(`Invalid output twice: ${error}`);
        user = retryParts(req.user, error ?? '');
      }
    },
  };
}
