import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output, type JSONValue, type LanguageModel, type LanguageModelUsage } from 'ai';
import { z } from 'zod';
import type { LlmAttempt, LlmGateway, LlmRequest, LlmResult, Recorder, SecretName, SecretsStore, UserPart } from '../seams.ts';
import type { LlmRole, ModelChoice, ProviderId } from '../types.ts';
import { createLimiter, DEFAULT_LIMITS, realClock, type Clock, type Limit } from './limiter.ts';
import { costUsd, type TokenUsage } from './prices.ts';

/** The model gave no schema-valid answer on either attempt. Callers treat it as a failed step, not a crash. */
export class InvalidOutputError extends Error {}

const NO_TOKENS: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
const NAME: Record<ProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', deepseek: 'DeepSeek', openai_compatible: 'The local endpoint' };
const SECRET: Record<Exclude<ProviderId, 'openai_compatible'>, SecretName> = {
  anthropic: 'anthropic_api_key',
  openai: 'openai_api_key',
  google: 'google_api_key',
  deepseek: 'deepseek_api_key',
};
// DeepSeek speaks OpenAI's chat-completions API, so it goes through the same package as a local endpoint (tech.md §4.5).
const DEEPSEEK_URL = 'https://api.deepseek.com';
const chatCompletions = (provider: ProviderId) => provider === 'deepseek' || provider === 'openai_compatible';

// How hard each role thinks (tech.md §10.1): routine steps run low or the thinking tokens dominate the output bill (§10.2).
const EFFORT: Record<LlmRole, 'low' | 'medium' | 'high'> = { navigator: 'low', socialiser: 'low', persona_writer: 'low', judge: 'medium', author: 'high' };
// GPT-5.6, GPT-6 Sol and GPT-6 Luna accept reasoning effort 'none'; GPT-6 Astra and 6.1 Sol start at 'low' (@ai-sdk/openai docs).
const CAN_SKIP_REASONING = /^gpt-(5\.6|6-(sol|luna))/;

const MAX_RETRIES = 3; // after the first attempt, for 429, 5xx and overloaded
const BACKOFF_MS = 1000; // 1 s, 2 s, 4 s before jitter
const MAX_WAIT_MS = 60_000; // a longer retry-after is a quota to wait out, not a blip: stop here and say so
// OpenAI answers an empty account with a 429 too, but waiting never helps.
const NO_CREDIT = /insufficient_quota|credit balance is too low/i;
const OVERLOADED = /overloaded/i;

// Key shapes: Anthropic, OpenAI and DeepSeek sk-…, Google AIza…. The key in hand is replaced literally as well.
const KEY_PATTERN = /\b(?:sk-[\w-]{8,}|AIza[\w-]{8,})/g;
const redact = (text: string, key?: string) => (key ? text.replaceAll(key, '[redacted]') : text).replace(KEY_PATTERN, '[redacted]');

/** Some SDK adapters fill omitted usage fields with zero; only the provider's raw fields establish completeness. */
function usageReported(provider: ProviderId, usage: LanguageModelUsage | undefined): boolean {
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!count(usage?.inputTokens) || !count(usage?.outputTokens)) return false;
  const raw = usage.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const [input, output] = provider === 'google' ? ['promptTokenCount', 'candidatesTokenCount']
    : chatCompletions(provider) ? ['prompt_tokens', 'completion_tokens'] : ['input_tokens', 'output_tokens'];
  if (!count(raw[input]) || !count(raw[output])) return false;
  // A Google total larger than the available components can reveal omitted reasoning or tool-use tokens.
  return provider !== 'google' || raw.totalTokenCount == null ||
    (count(raw.totalTokenCount) && raw.totalTokenCount === usage.inputTokens + usage.outputTokens);
}

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

/** `credential` is the provider's API key, or for the local endpoint its base URL. */
function languageModel({ provider, model }: ModelChoice, credential: string): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: credential }).languageModel(model);
    case 'openai':
      return createOpenAI({ apiKey: credential }).languageModel(model);
    case 'google':
      return createGoogle({ apiKey: credential }).languageModel(model);
    case 'deepseek': // no supportsStructuredOutputs: DeepSeek has JSON mode only, so the schema is not enforced (tech.md §10.6)
      return createOpenAICompatible({ name: 'deepseek', baseURL: DEEPSEEK_URL, apiKey: credential }).languageModel(model);
    case 'openai_compatible':
      return createOpenAICompatible({ name: 'local', baseURL: credential, supportsStructuredOutputs: true }).languageModel(model);
  }
}

// Output.object validates every provider's answer. Native schemas use output_config.format (Anthropic), text.format
// json_schema (OpenAI), responseJsonSchema (Google), response_format json_schema (local). DeepSeek uses JSON mode
// with the schema in the prompt and local validation. OpenAI's strict mode is set here too, so an SDK
// default that changed could not loosen it (tech.md §10.6).
// shortcut: Google gets thinkingLevel, which Gemini 3 and later take; 2.5-era ids would need thinkingBudget instead.
function providerOptions({ provider, model }: ModelChoice, role: LlmRole, override?: LlmRequest<unknown>['effort']): Record<string, Record<string, JSONValue>> {
  const effort = override ?? EFFORT[role];
  switch (provider) {
    case 'anthropic':
      return { anthropic: { effort: effort === 'none' ? 'low' : effort } };
    case 'openai':
      return { openai: { reasoningEffort: (effort === 'none' || effort === 'low') ? (CAN_SKIP_REASONING.test(model) ? 'none' : 'low') : effort, strictJsonSchema: true } };
    case 'google':
      return { google: { thinkingConfig: { thinkingLevel: effort === 'none' ? 'low' : effort } } };
    case 'deepseek':
      // DeepSeek defaults to HIGH thinking when omitted. Routine persona prose needs none.
      return { deepseek: effort === 'none' || (role === 'persona_writer' && effort === 'low')
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'enabled' }, reasoningEffort: effort === 'low' ? 'low' : 'high' } };
    case 'openai_compatible':
      return {};
  }
}

/** About four characters a token and 1.2k for a screenshot (tech.md §10.4): enough to pace requests, not to bill them. */
function estimateTokens(system: string, user: UserPart[]) {
  const chars = user.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), system.length);
  return Math.ceil(chars / 4) + 1200 * user.filter((p) => p.type === 'image').length;
}

function reasoningTokens(provider: ProviderId, usage: LanguageModelUsage | undefined): number | undefined {
  if (!usage) return undefined;
  if (provider === 'anthropic') return usage.outputTokenDetails.reasoningTokens;
  // These SDK adapters normalize omitted thinking usage to zero. Keep the distinction
  // between a provider-reported zero and unavailable usage in our diagnostics.
  const raw = usage.raw;
  if (provider === 'google') return typeof raw?.thoughtsTokenCount === 'number' ? raw.thoughtsTokenCount : undefined;
  const details = raw?.[provider === 'openai' ? 'output_tokens_details' : 'completion_tokens_details'];
  return details && typeof details === 'object' && 'reasoning_tokens' in details && typeof details.reasoning_tokens === 'number'
    ? details.reasoning_tokens : undefined;
}

/**
 * How long the provider asked us to wait, from retry-after-ms or retry-after (seconds or a date).
 * shortcut: the retryDelay inside a Gemini error body is not read, so its 429s fall back to the backoff; parse it if they prove too slow.
 */
function retryAfterMs(headers: Record<string, string> | undefined): number | null {
  const ms = Number(headers?.['retry-after-ms']);
  if (headers?.['retry-after-ms'] && Number.isFinite(ms)) return ms;
  const after = headers?.['retry-after'];
  if (!after) return null;
  const wait = Number.isFinite(Number(after)) ? Number(after) * 1000 : Date.parse(after) - Date.now();
  return Number.isFinite(wait) ? Math.max(0, wait) : null;
}

/** Routes each request to its provider (tech.md §10.1): keys from the secrets store, retries and rate limits per provider. */
export function createGateway({
  secrets,
  localBaseUrl,
  record,
  onThrottle,
  limits = {},
  clock = realClock,
}: {
  secrets: SecretsStore;
  localBaseUrl: string | null;
  record: Recorder;
  /** Called on every rate-limit answer (429), so the scheduler can lower its concurrency. */
  onThrottle?(provider: ProviderId): void;
  /** Replaces the default limits of a provider whose account has a higher tier. */
  limits?: Partial<Record<ProviderId, Limit>>;
  /** For tests: the time source of the limiter and the retry delays. */
  clock?: Clock;
}): LlmGateway {
  const buckets: Partial<Record<ProviderId, ReturnType<typeof createLimiter>>> = {};
  const bucket = (provider: ProviderId) => {
    const limit = limits[provider] ?? DEFAULT_LIMITS[provider];
    return limit ? (buckets[provider] ??= createLimiter(limit, clock)) : null;
  };

  return {
    async call<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      if (req.timeout_ms !== undefined) {
        const deadline = AbortSignal.timeout(req.timeout_ms);
        req = { ...req, signal: req.signal ? AbortSignal.any([req.signal, deadline]) : deadline };
      }
      req.signal?.throwIfAborted();
      const { provider } = req.model;
      costUsd(req.model, NO_TOKENS); // throws before spending money on a model the budget cannot price
      const credential = provider === 'openai_compatible' ? localBaseUrl : secrets.get(SECRET[provider]);
      if (!credential) throw new Error(provider === 'openai_compatible' ? 'No local endpoint is set. Add its URL in Settings.' : 'The selected AI provider is not connected. Open Settings to add its API key or choose a connected provider under Model choices.');
      const hideKey = (text: string) => redact(text, provider === 'openai_compatible' ? undefined : credential);
      const model = languageModel(req.model, credential);
      const options = providerOptions(req.model, req.role, req.effort);
      const output = Output.object({ schema: req.schema });
      // DeepSeek supports JSON mode, not native schemas. Keep Output.object's validation and error metadata.
      if (provider === 'deepseek') output.responseFormat = Output.json().responseFormat;
      // Local models and DeepSeek also get the schema in the prompt, which grounds their answers (tech.md §10.6).
      const system = chatCompletions(provider) ? `${req.system}\n\nAnswer with one JSON object that matches this JSON Schema:\n${JSON.stringify(z.toJSONSchema(req.schema))}` : req.system;
      // DeepSeek's chat models read text only (tech.md §10.2): a DeepSeek navigator runs without the screenshots.
      const parts = provider === 'deepseek' ? req.user.filter((p) => p.type === 'text') : req.user;

      let user = parts;
      let spent = 0;
      let invalid = 0; // answers that did not fit the schema; the second one ends the call
      let retries = 0; // transient failures that were tried again
      for (;;) {
        req.signal?.throwIfAborted();
        const queued = clock.now();
        await bucket(provider)?.acquire(estimateTokens(system, user), req.signal).catch((err) => { req.signal?.throwIfAborted(); throw err; });
        req.signal?.throwIfAborted();
        const started = clock.now();
        let object: T | undefined;
        let usage: LanguageModelUsage | undefined;
        let text: string | null = null;
        let finish: string | null = null;
        let status: 'ok' | 'error' | 'invalid_output' = 'ok';
        let error: string | null = null;
        let thrown: unknown;
        try {
          const result = await generateText({
            model,
            // The stable prefix carries the cache breakpoint; everything volatile is in the user turn.
            instructions: { role: 'system', content: system, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
            messages: [
              {
                role: 'user',
                content: user.map((p) => (p.type === 'text' ? p : { type: 'file' as const, data: p.data, mediaType: p.mediaType })),
              },
            ],
            output,
            providerOptions: options,
            // Thinking tokens count against the cap, so the roles that think more get more room.
            maxOutputTokens: req.max_output_tokens ?? (EFFORT[req.role] === 'low' ? 4096 : 16_384),
            // The retries are ours, so that each failed attempt is logged and a 429 reaches onThrottle.
            maxRetries: 0,
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
            error = hideKey(err.cause instanceof Error ? err.cause.message : err.message);
          } else if (NoOutputGeneratedError.isInstance(err)) {
            // A paid call with no answer in it, such as a refusal: retried like any invalid output.
            status = 'invalid_output';
            error = `No answer (finish reason: ${finish})`;
          } else {
            status = 'error';
            error = hideKey(err instanceof Error ? err.message : String(err));
          }
        }
        const cache_read_tokens = usage?.inputTokenDetails.cacheReadTokens ?? 0;
        const cache_write_tokens = usage?.inputTokenDetails.cacheWriteTokens ?? 0;
        const tokens: TokenUsage = {
          input_tokens: usage?.inputTokenDetails.noCacheTokens ?? Math.max(0, (usage?.inputTokens ?? 0) - cache_read_tokens - cache_write_tokens),
          output_tokens: usage?.outputTokens ?? 0,
          cache_read_tokens,
          cache_write_tokens,
        };
        const cost_usd = costUsd(req.model, tokens);
        spent += cost_usd;
        const attempt: LlmAttempt = {
          payload: { role: req.role, provider, model: req.model.model, ...tokens, reasoning_tokens: reasoningTokens(provider, usage), queue_ms: started - queued, cost_usd, latency_ms: clock.now() - started, usage_reported: usageReported(provider, usage), status, error },
          transcript: JSON.parse(hideKey(JSON.stringify({ request: transcriptRequest({ ...req, system }, user), response: { text, finish_reason: finish, usage: usage?.raw ?? null, error } }))),
        };
        if (APICallError.isInstance(thrown)) attempt.payload.http_status = thrown.statusCode;
        // Setup calls have no run ledger; observers still receive their attempt below.
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
        // Keep a successful response and its usage even if a budget observer just cancelled other work.
        if (status === 'ok') return { object: object as T, cost_usd: spent };
        req.signal?.throwIfAborted();

        if (status === 'error') {
          const api = APICallError.isInstance(thrown) ? thrown : null;
          const detail = `${api?.message ?? ''} ${api?.responseBody ?? ''}`;
          const noCredit = NO_CREDIT.test(detail);
          if (api?.statusCode === 429 && !noCredit) onThrottle?.(provider);
          const transient = !!api && !noCredit && (api.isRetryable || OVERLOADED.test(detail));
          const asked = retryAfterMs(api?.responseHeaders);
          if (!transient || retries === MAX_RETRIES || (asked ?? 0) > MAX_WAIT_MS || req.signal?.aborted) {
            if (req.signal?.aborted) throw thrown;
            const code = api?.statusCode ? `answered ${api.statusCode}` : 'failed';
            throw new Error(`${NAME[provider]} ${code}: ${error}${retries ? ` (gave up after ${retries + 1} attempts)` : ''}`);
          }
          // A provider's retry-after is a floor; the jitter spreads the personas out so they do not all return together.
          await clock.sleep(asked === null ? BACKOFF_MS * 2 ** retries * (0.5 + clock.random() / 2) : asked + clock.random() * 500, req.signal).catch((err) => { req.signal?.throwIfAborted(); throw err; });
          req.signal?.throwIfAborted();
          retries++;
          continue;
        }

        if (++invalid === 2) throw new InvalidOutputError(`Invalid output twice: ${error}`);
        user = retryParts(parts, error ?? '');
      }
    },
  };
}

const PROBES: Record<ProviderId, (credential: string) => { url: string; headers: Record<string, string> }> = {
  anthropic: (key) => ({ url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }),
  openai: (key) => ({ url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${key}` } }),
  // The key travels in a header, never in the query string, so no URL we show or log can carry it.
  google: (key) => ({ url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', headers: { 'x-goog-api-key': key } }),
  deepseek: (key) => ({ url: `${DEEPSEEK_URL}/models`, headers: { authorization: `Bearer ${key}` } }),
  openai_compatible: (baseUrl) => ({ url: `${baseUrl.replace(/\/+$/, '')}/models`, headers: {} }),
};

/** A zero-cost check of a provider's key, or for 'openai_compatible' that the endpoint at `credential` (a base URL) answers. */
export async function testProviderKey(provider: ProviderId, credential: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const local = provider === 'openai_compatible';
  if (local && !(/^https?:\/\//i.test(credential) && URL.canParse(credential))) return { ok: false, error: `"${credential}" is not a web address. Use one like http://localhost:11434/v1` };
  const { url, headers } = PROBES[provider](credential);
  const host = new URL(url).host;
  const hideKey = (text: string) => redact(text, local ? undefined : credential);
  const hint = local ? 'Is the server running?' : 'Check the internet connection, VPN or proxy.';
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    if ((err as Error | undefined)?.name === 'TimeoutError') return { ok: false, error: `${host} did not answer within 15 seconds. ${hint}` };
    return { ok: false, error: `Could not reach ${host} (${hideKey(err instanceof Error ? err.message : String(err))}). ${hint}` };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401 && !local) return { ok: false, error: `${NAME[provider]} rejected this key (401). Check it was pasted in full and has not been revoked.` };
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { ok: false, error: hideKey(`${NAME[provider]} answered ${res.status}: ${body?.error?.message ?? res.statusText}`) };
}
