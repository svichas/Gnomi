import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output, type LanguageModelUsage } from 'ai';
import type { LlmGateway, LlmRequest, LlmResult, Recorder, UserPart } from '../seams.ts';
import { costUsd, type TokenUsage } from './prices.ts';

/** The model gave no schema-valid answer on either attempt. Callers treat it as a failed step, not a crash. */
export class InvalidOutputError extends Error {}

const NO_TOKENS: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
const KEY_PATTERN = /sk-ant-[\w-]+/g;

/** The request as a transcript keeps it: screenshots are already stored as blobs, so images become a size. */
export function transcriptRequest(req: LlmRequest<unknown>, user: UserPart[]) {
  return {
    model: req.model,
    system: req.system,
    user: user.map((p) => (p.type === 'image' ? { type: 'image', mediaType: p.mediaType, bytes: p.data.byteLength } : p)),
  };
}

/** The appended turn of the one retry after an invalid output (tech.md §10.6). */
export function retryParts(user: UserPart[], error: string): UserPart[] {
  return [...user, { type: 'text', text: `That answer did not match the required format: ${error}\nAnswer again with one JSON object that matches the schema.` }];
}

export function createAnthropicGateway({ apiKey, record }: { apiKey: string; record: Recorder }): LlmGateway {
  const anthropic = createAnthropic({ apiKey });
  const redact = (text: string) => (apiKey ? text.replaceAll(apiKey, '[redacted]') : text).replace(KEY_PATTERN, '[redacted]');

  return {
    async call<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      costUsd(req.model, NO_TOKENS); // throws before spending money on a model the budget cannot price
      let user = req.user;
      let spent = 0;
      for (let attempt = 1; ; attempt++) {
        const started = Date.now();
        let object: T | undefined;
        let usage: LanguageModelUsage | undefined;
        let text: string | null = null;
        let finish: string | null = null;
        let status: 'ok' | 'error' | 'invalid_output' = 'ok';
        let error: string | null = null;
        let thrown: unknown;
        try {
          const result = await generateText({
            model: anthropic(req.model),
            // The stable prefix carries the cache breakpoint; everything volatile is in the user turn.
            instructions: { role: 'system', content: req.system, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
            messages: [
              {
                role: 'user',
                content: user.map((p) => (p.type === 'text' ? p : { type: 'file' as const, data: p.data, mediaType: p.mediaType })),
              },
            ],
            output: Output.object({ schema: req.schema }),
            // Routine steps run at low effort, or thinking tokens dominate the output bill (tech.md §10.2).
            providerOptions: { anthropic: { effort: 'low' } },
            maxOutputTokens: 4096,
            abortSignal: req.signal,
          });
          usage = result.usage;
          text = result.text;
          finish = result.finishReason;
          object = result.output;
        } catch (err) {
          thrown = err;
          if (NoObjectGeneratedError.isInstance(err)) {
            status = 'invalid_output';
            usage = err.usage;
            text = err.text ?? null;
            finish = err.finishReason ?? null;
            error = redact(err.cause instanceof Error ? err.cause.message : err.message);
          } else if (NoOutputGeneratedError.isInstance(err)) {
            // A paid call with no answer in it, such as a refusal: retried like any invalid output.
            status = 'invalid_output';
            error = `No answer (finish reason: ${finish})`;
          } else {
            status = 'error';
            error = redact(err instanceof Error ? err.message : String(err));
          }
        }
        const tokens: TokenUsage = {
          input_tokens: usage?.inputTokenDetails.noCacheTokens ?? 0,
          output_tokens: usage?.outputTokens ?? 0,
          cache_read_tokens: usage?.inputTokenDetails.cacheReadTokens ?? 0,
          cache_write_tokens: usage?.inputTokenDetails.cacheWriteTokens ?? 0,
        };
        const cost_usd = costUsd(req.model, tokens);
        spent += cost_usd;
        const transcript = { request: transcriptRequest(req, user), response: { text, finish_reason: finish, usage: usage?.raw ?? null, error } };
        record(
          {
            run_id: req.run_id,
            round: req.round,
            persona_id: req.persona_id,
            poi_id: null,
            type: 'llm.call',
            payload: { role: req.role, provider: 'anthropic', model: req.model, ...tokens, cost_usd, latency_ms: Date.now() - started, status, error },
          },
          JSON.parse(redact(JSON.stringify(transcript))),
        );
        if (status === 'ok') return { object: object as T, cost_usd: spent };
        if (status === 'error') throw thrown;
        if (attempt === 2) throw new InvalidOutputError(`Invalid output twice: ${error}`);
        user = retryParts(req.user, error ?? '');
      }
    },
  };
}

/** Lists one model: free, and proves the key, the network path and the account in one request. */
export async function testAnthropicKey(apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not reach api.anthropic.com (${reason}). Check the internet connection, VPN or proxy.` };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401) return { ok: false, error: 'Anthropic rejected this key (401). Check it was pasted in full and has not been revoked.' };
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { ok: false, error: `Anthropic answered ${res.status}: ${body?.error?.message ?? res.statusText}` };
}
