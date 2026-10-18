// The real gateway against a stubbed fetch: no network, no key, no cost.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { z } from 'zod';
import type { LlmAttempt, LlmRequest, Recorder, SecretName } from '../seams.ts';
import type { EventOf, GnomiEvent, ModelChoice, ProviderId } from '../types.ts';
import { accepted, createGateway, InvalidOutputError, testProviderKey } from './gateway.ts';
import type { Clock } from './limiter.ts';

const KEYS: Record<'anthropic' | 'openai' | 'google' | 'deepseek', string> = {
  anthropic: 'sk-ant-api03-test-key-0123456789',
  openai: 'sk-proj-test-openai-key-0123456789',
  google: 'AIzaSyTestGoogleKey0123456789abcd',
  deepseek: 'sk-0123456789abcdef0123456789abcdef',
};
const KEY = KEYS.anthropic;
const LOCAL = 'http://localhost:11434/v1';
const HAIKU: ModelChoice = { provider: 'anthropic', model: 'claude-haiku-5-5' };
const schema = z.object({ thought: z.string(), feeling: z.number().int().min(-2).max(2) });
const shot = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const request = (over: Partial<LlmRequest<z.infer<typeof schema>>> = {}): LlmRequest<z.infer<typeof schema>> => ({
  role: 'navigator',
  model: HAIKU,
  run_id: 'r-0001',
  persona_id: 'p-001',
  round: 1,
  system: 'This is Priya.',
  user: [
    { type: 'image', data: shot, mediaType: 'image/jpeg' },
    { type: 'text', text: 'What does Priya do next?' },
  ],
  schema,
  ...over,
});

function recorder() {
  const calls: { event: EventOf<'llm.call'>; transcript: string }[] = [];
  const record: Recorder = (event, transcript) => {
    const stored = { ...event, seq: calls.length + 1, ts: 0 } as GnomiEvent;
    calls.push({ event: stored as EventOf<'llm.call'>, transcript: JSON.stringify(transcript) });
    return stored;
  };
  return { record, calls };
}

/** A clock that never waits: it notes how long the gateway asked to sleep. No jitter, so delays are exact. */
function fakeClock(sleep?: Clock['sleep']) {
  const slept: number[] = [];
  const clock: Clock = {
    now: () => 1_000_000,
    sleep: sleep ?? (async (ms) => void slept.push(ms)),
    random: () => 0,
  };
  return { clock, slept };
}

function setup(opts: { keys?: Partial<Record<SecretName, string>>; localBaseUrl?: string | null; sleep?: Clock['sleep']; limits?: Parameters<typeof createGateway>[0]['limits'] } = {}) {
  const { record, calls } = recorder();
  const { clock, slept } = fakeClock(opts.sleep);
  const throttled: ProviderId[] = [];
  const keys = opts.keys ?? { anthropic_api_key: KEYS.anthropic, openai_api_key: KEYS.openai, google_api_key: KEYS.google, deepseek_api_key: KEYS.deepseek };
  const gateway = createGateway({
    secrets: { get: (name) => keys[name] ?? null },
    localBaseUrl: opts.localBaseUrl === undefined ? LOCAL : opts.localBaseUrl,
    record,
    onThrottle: (provider) => throttled.push(provider),
    limits: opts.limits,
    clock,
  });
  return { gateway, calls, slept, throttled };
}

const usage = { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 3_000, cache_creation_input_tokens: 0 };
const anthropicMessage = (text: string, u = usage) =>
  Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: u });
// 1,000 tokens in, 400 of them cached, 200 out (50 of them reasoning): each provider's own shape of the same usage.
const openaiResponse = (text: string) =>
  Response.json({
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'gpt-6-luna',
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 200, output_tokens_details: { reasoning_tokens: 50 }, total_tokens: 1_200 },
  });
const googleResponse = (text: string) =>
  Response.json({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 1_000, cachedContentTokenCount: 400, candidatesTokenCount: 150, thoughtsTokenCount: 50, totalTokenCount: 1_200 },
  });
const chatCompletion = (text: string) =>
  Response.json({
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: 'gemma4:e4b',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1_000, completion_tokens: 200, total_tokens: 1_200 },
  });
const anthropicError = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  Response.json({ type: 'error', error: { type, message } }, { status, headers });

const OK = '{"thought":"Jobs is in the menu.","feeling":0}';

function stubFetch(...responses: Array<() => Response | Promise<Response>>) {
  const urls: string[] = [];
  const bodies: any[] = [];
  const headers: Headers[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    urls.push(String(url));
    bodies.push(init.body ? JSON.parse(String(init.body)) : null);
    headers.push(new Headers(init.headers));
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');
    return next();
  });
  return { urls, bodies, headers };
}

afterEach(() => mock.restoreAll());

test('a shared prefix goes first with a cache breakpoint of its own; a chat-completions endpoint gets it in its one system message', async () => {
  const sent = stubFetch(() => anthropicMessage(OK), () => chatCompletion(OK));
  const { gateway, calls } = setup();
  await gateway.call(request({ shared: '<text>The pricing copy.</text>' }));
  assert.deepEqual(sent.bodies[0].system, [
    { type: 'text', text: '<text>The pricing copy.</text>', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'This is Priya.', cache_control: { type: 'ephemeral' } },
  ]);
  assert.match(calls[0].transcript, /"shared":"<text>The pricing copy\.<\/text>"/);
  await gateway.call(request({ model: { provider: 'openai_compatible', model: 'gemma4:e4b' }, shared: '<text>The pricing copy.</text>', user: [{ type: 'text', text: 'Go on.' }] }));
  const system = sent.bodies[1].messages.filter((m: { role: string }) => m.role === 'system');
  assert.equal(system.length, 1);
  assert.match(system[0].content, /^<text>The pricing copy\.<\/text>\n\nThis is Priya\.\n\nAnswer with one JSON object/);
});

test('one call: cached system prefix, screenshot, low effort, native schema, cost and raw usage from the answer', async () => {
  const sent = stubFetch(() => anthropicMessage(OK));
  const { gateway, calls } = setup();
  const result = await gateway.call(request());

  assert.deepEqual(result.object, { thought: 'Jobs is in the menu.', feeling: 0 });
  const body = sent.bodies[0];
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.deepEqual(body.system, [{ type: 'text', text: 'This is Priya.', cache_control: { type: 'ephemeral' } }]);
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(body.output_config.format.schema.required, ['thought', 'feeling']);
  assert.equal(body.messages[0].content[0].type, 'image');
  assert.equal(body.messages[0].content[0].source.data, Buffer.from(shot).toString('base64'));
  assert.equal(sent.headers[0].get('x-api-key'), KEY);

  // 1,000 × $0.10 + 200 × $0.50 + 3,000 cache reads × $0.01, per million
  assert.ok(Math.abs(result.cost_usd - 0.00023) < 1e-12);
  assert.equal(calls.length, 1);
  const { payload, persona_id, run_id } = calls[0].event;
  assert.deepEqual(payload, {
    role: 'navigator',
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    input_tokens: 1_000,
    output_tokens: 200,
    cache_read_tokens: 3_000,
    cache_write_tokens: 0,
    cost_usd: result.cost_usd,
    latency_ms: 0,
    reasoning_tokens: undefined,
    queue_ms: 0,
    usage_reported: true,
    status: 'ok',
    error: null,
    temperature: null,
    seed: null,
    response_model: 'claude-haiku-5-5',
  });
  assert.deepEqual([run_id, persona_id], ['r-0001', 'p-001']);
  assert.match(calls[0].transcript, /"type":"image","mediaType":"image\/jpeg","bytes":4/);
  assert.equal(JSON.parse(calls[0].transcript).response.usage.cache_read_input_tokens, 3_000, 'the provider\'s own usage object is kept');
  assert.doesNotMatch(calls[0].transcript, /sk-ant-|\/9j\//); // no key, no base64 screenshot
});

test('each provider gets its own client, key, schema format and token accounting', async () => {
  const sent = stubFetch(() => anthropicMessage(OK), () => openaiResponse(OK), () => googleResponse(OK), () => chatCompletion(OK));
  const { gateway, calls } = setup();
  const models: ModelChoice[] = [HAIKU, { provider: 'openai', model: 'gpt-6-luna' }, { provider: 'google', model: 'gemini-3.5-flash-lite' }, { provider: 'openai_compatible', model: 'gemma4:e4b' }];
  const costs: number[] = [];
  for (const model of models) costs.push((await gateway.call(request({ model }))).cost_usd);

  assert.deepEqual(sent.urls, [
    'https://api.anthropic.com/v1/messages',
    'https://api.openai.com/v1/responses',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    `${LOCAL}/chat/completions`,
  ]);
  const [anthropic, openai, google, local] = sent.bodies;
  assert.equal(sent.headers[0].get('x-api-key'), KEYS.anthropic);
  assert.equal(sent.headers[1].get('authorization'), `Bearer ${KEYS.openai}`);
  assert.equal(sent.headers[2].get('x-goog-api-key'), KEYS.google);
  assert.equal(sent.headers[3].get('authorization'), null, 'a local endpoint needs no key');
  assert.ok(!sent.urls.some((u) => u.includes('AIza')), 'the Google key travels in a header, not the URL');

  // OpenAI: strict JSON schema, and no reasoning at all for a routine step on Luna.
  assert.deepEqual([openai.text.format.type, openai.text.format.strict, openai.reasoning], ['json_schema', true, { effort: 'none' }]);
  // Google: the schema as responseJsonSchema and a low thinking level.
  assert.deepEqual(google.generationConfig.responseJsonSchema.required, ['thought', 'feeling']);
  assert.deepEqual(google.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  // Local: json_schema output, and the schema again in the prompt (tech.md §10.6).
  assert.equal(local.response_format.type, 'json_schema');
  assert.match(local.messages[0].content, /^This is Priya\.\n\nAnswer with one JSON object that matches this JSON Schema:\n\{.*"thought".*"feeling"/s);
  assert.match(calls[3].transcript, /Answer with one JSON object that matches this JSON Schema/, 'the transcript shows the prompt that was sent');
  assert.equal(anthropic.output_config.effort, 'low');

  // Sampling: a navigator's temperature where the route takes one, a seed where the SDK passes one, and the model each answer named.
  assert.deepEqual([anthropic.temperature, openai.temperature, google.generationConfig.temperature, local.temperature], [undefined, 1, 1, 1], 'Claude reasons, so no temperature is sent');
  assert.deepEqual([anthropic.seed, openai.seed, typeof google.generationConfig.seed, typeof local.seed], [undefined, undefined, 'number', 'number']);
  assert.equal(google.generationConfig.seed, local.seed, 'the seed follows the request, not the provider');
  assert.deepEqual(calls.map((c) => [c.event.payload.temperature, c.event.payload.seed === null, c.event.payload.response_model]), [
    [null, true, 'claude-haiku-5-5'],
    [1, true, 'gpt-6-luna'],
    [1, false, 'gemini-3.5-flash-lite'],
    [1, false, 'gemma4:e4b'],
  ]);
  assert.equal(calls[2].event.payload.seed, google.generationConfig.seed, 'the log records the seed that was sent');

  // Tokens in the three fields the meter sums (uncached, read, written), and the cost from each model's own card.
  assert.deepEqual(
    calls.map((c) => [c.event.payload.provider, c.event.payload.model, c.event.payload.input_tokens, c.event.payload.cache_read_tokens, c.event.payload.output_tokens]),
    [
      ['anthropic', 'claude-haiku-5-5', 1_000, 3_000, 200],
      ['openai', 'gpt-6-luna', 600, 400, 200],
      ['google', 'gemini-3.5-flash-lite', 600, 400, 200],
      ['openai_compatible', 'gemma4:e4b', 1_000, 0, 200],
    ],
  );
  const expected = [0.00023, 0.000164, 0.000692, 0]; // 600 × 0.10 + 400 × 0.01 + 200 × 0.50 for Luna; 600 × 0.30 + 400 × 0.03 + 200 × 2.50 for Flash-Lite
  costs.forEach((cost, i) => assert.ok(Math.abs(cost - expected[i]) < 1e-12, `${models[i].model}: ${cost} ≠ ${expected[i]}`));
});

test('DeepSeek goes the chat-completions way: its key, JSON mode with the schema in the prompt, text only, its own price', async () => {
  const warnings = mock.method(process, 'emitWarning', () => {});
  // DeepSeek's usage: 1,000 tokens in, 400 of them cache hits, 200 out.
  const completion = (text: string) =>
    Response.json({
      id: 'c1', object: 'chat.completion', created: 1, model: 'deepseek-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1_000, completion_tokens: 200, total_tokens: 1_200, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600, prompt_tokens_details: { cached_tokens: 400 } },
    });
  const sent = stubFetch(() => completion('{"thought":"no feeling"}'), () => completion(OK));
  const { gateway, calls } = setup();
  const result = await gateway.call(request({ model: { provider: 'deepseek', model: 'deepseek-flash' } }));

  assert.deepEqual(result.object, { thought: 'Jobs is in the menu.', feeling: 0 });
  assert.deepEqual(sent.urls, ['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/chat/completions']);
  assert.equal(sent.headers[0].get('authorization'), `Bearer ${KEYS.deepseek}`);
  const [first, retry] = sent.bodies;
  assert.equal(first.model, 'deepseek-flash');
  assert.deepEqual(first.response_format, { type: 'json_object' }, 'JSON mode: DeepSeek enforces no schema');
  assert.match(first.messages[0].content, /^This is Priya\.\n\nAnswer with one JSON object that matches this JSON Schema:\n\{.*"thought".*"feeling"/s);
  assert.equal(first.messages[1].content, 'What does Priya do next?', 'the screenshot is left out');
  assert.deepEqual(retry.messages[1].content.map((part: { type: string }) => part.type), ['text', 'text'], 'the retry is text only too');
  assert.doesNotMatch(JSON.stringify(sent.bodies), /image_url/);

  // 600 × $0.30 + 400 hits × $0.006 + 200 × $1.20, per million, for each of the two attempts.
  assert.deepEqual(calls.map((c) => [c.event.payload.provider, c.event.payload.status, c.event.payload.input_tokens, c.event.payload.cache_read_tokens, c.event.payload.output_tokens, c.event.payload.usage_reported]), [
    ['deepseek', 'invalid_output', 600, 400, 200, true],
    ['deepseek', 'ok', 600, 400, 200, true],
  ]);
  assert.ok(Math.abs(result.cost_usd - 2 * 0.0004224) < 1e-12, `${result.cost_usd}`);
  assert.doesNotMatch(calls[1].transcript, new RegExp(KEYS.deepseek));
  assert.deepEqual(warnings.mock.calls.map(({ arguments: [warning] }) => String(warning)), [], 'DeepSeek JSON mode must not request unsupported structured outputs');
});

test('a role sets how hard the model thinks and how much room it has', async () => {
  const sent = stubFetch(
    () => anthropicMessage(OK),
    () => openaiResponse(OK),
    () => openaiResponse(OK),
    () => openaiResponse(OK),
    () => googleResponse(OK),
  );
  const { gateway } = setup();
  await gateway.call(request({ role: 'author', model: { provider: 'anthropic', model: 'claude-opus-5-5' } }));
  await gateway.call(request({ role: 'author', model: { provider: 'openai', model: 'gpt-6.1-sol' } }));
  await gateway.call(request({ role: 'navigator', model: { provider: 'openai', model: 'gpt-6.1-sol' } }));
  await gateway.call(request({ role: 'judge', model: { provider: 'openai', model: 'gpt-6-luna' } }));
  await gateway.call(request({ role: 'author', model: { provider: 'google', model: 'gemini-4-argon' } }));
  assert.deepEqual([sent.bodies[0].output_config.effort, sent.bodies[0].max_tokens], ['high', 16_384]);
  assert.deepEqual(sent.bodies.slice(1, 4).map((b) => b.reasoning.effort), ['high', 'low', 'none'], 'GPT-6.1 Sol cannot switch reasoning off, so a routine step on it is low; the judge thinks little');
  assert.deepEqual(sent.bodies[4].generationConfig.thinkingConfig, { thinkingLevel: 'high' });
  assert.deepEqual(sent.bodies.slice(1).map((b) => b.temperature ?? b.generationConfig?.temperature), [undefined, undefined, 0.5, 1], 'reasoning OpenAI routes get none; the judge runs cooler');
});

test('explicit DeepSeek effort overrides control thinking and reserve room for reasoning', async () => {
  const sent = stubFetch(...Array.from({ length: 3 }, () => () => chatCompletion(OK)));
  const { gateway } = setup();
  const model: ModelChoice = { provider: 'deepseek', model: 'deepseek-flash' };
  await gateway.call(request({ model, effort: 'high' }));
  await gateway.call(request({ model, effort: 'medium' }));
  await gateway.call(request({ model, role: 'author', effort: 'none' }));
  assert.deepEqual(sent.bodies.map((b) => [b.thinking.type, b.reasoning_effort, b.max_tokens]), [
    ['enabled', 'high', 16_384], ['enabled', 'high', 16_384], ['disabled', undefined, 4096],
  ]);
  assert.deepEqual(sent.bodies.map((b) => b.temperature), [undefined, undefined, 1], 'thinking DeepSeek takes no temperature');
});

/** The observed failure: the entire completion allowance was spent before a complete JSON answer. */
function truncatedCompletion(text: string, tokens = 4096) {
  return Response.json({
    id: 'c-length', object: 'chat.completion', created: 1, model: 'deepseek-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'length' }],
    usage: { prompt_tokens: 1_000, completion_tokens: tokens, total_tokens: 1_000 + tokens, completion_tokens_details: { reasoning_tokens: text ? tokens - 100 : tokens } },
  });
}

for (const text of ['', '{"thought":"Cut off']) {
  test(`a ${text ? 'partial JSON' : 'reasoning-only'} response retries with more output room and keeps paid usage`, async () => {
    const sent = stubFetch(() => truncatedCompletion(text), () => chatCompletion(OK));
    const { gateway, calls } = setup();
    const result = await gateway.call(request({ model: { provider: 'deepseek', model: 'deepseek-flash' } }));
    assert.deepEqual(result.object, JSON.parse(OK));
    assert.ok(sent.bodies.every((b) => b.thinking.type === 'disabled'));
    assert.deepEqual(sent.bodies.map((b) => b.max_tokens), [4096, 8192]);
    assert.deepEqual(calls.map((c) => c.event.payload.status), ['invalid_output', 'ok']);
    assert.equal(calls[0].event.payload.output_tokens, 4096);
    assert.equal(calls[0].event.payload.reasoning_tokens, text ? 3996 : 4096);
    assert.match(calls[0].event.payload.error ?? '', /output token limit.*4096/i);
    assert.deepEqual(calls.map((c) => JSON.parse(c.transcript).request.max_output_tokens), [4096, 8192]);
    assert.equal(result.cost_usd, calls.reduce((sum, c) => sum + c.event.payload.cost_usd, 0));
  });
}

test('length retries respect an explicit output limit and stop after the second attempt', async () => {
  const sent = stubFetch(() => truncatedCompletion('', 1200), () => truncatedCompletion('', 1200));
  const { gateway, calls } = setup();
  await assert.rejects(gateway.call(request({ model: { provider: 'deepseek', model: 'deepseek-flash' }, max_output_tokens: 1200 })), /Invalid output twice: .*output token limit.*1200/i);
  assert.deepEqual(sent.bodies.map((b) => b.max_tokens), [1200, 1200]);
  assert.equal(calls.length, 2);
});

test('a missing key fails before any request with provider-neutral guidance', async () => {
  const sent = stubFetch();
  const { gateway, calls } = setup({ keys: {}, localBaseUrl: null });
  const missingKey = { message: 'The selected AI provider is not connected. Open Settings to add its API key or choose a connected provider under Model choices.' };
  await assert.rejects(gateway.call(request()), missingKey);
  await assert.rejects(gateway.call(request({ model: { provider: 'openai', model: 'gpt-6-luna' } })), missingKey);
  await assert.rejects(gateway.call(request({ model: { provider: 'google', model: 'gemini-3.5-flash-lite' } })), missingKey);
  await assert.rejects(gateway.call(request({ model: { provider: 'deepseek', model: 'deepseek-flash' } })), missingKey);
  await assert.rejects(gateway.call(request({ model: { provider: 'openai_compatible', model: 'gemma4:e4b' } })), /No local endpoint is set/);
  assert.deepEqual([sent.urls.length, calls.length], [0, 0]);
});

test('a setup call is priced and returned, but logs no event and no transcript', async () => {
  stubFetch(() => anthropicMessage('{"thought":"Hmm","feeling":7}'), () => anthropicMessage(OK));
  const { gateway, calls } = setup();
  const result = await gateway.call(request({ run_id: null, persona_id: null, role: 'persona_writer', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' } }));
  assert.deepEqual(result.object, { thought: 'Jobs is in the menu.', feeling: 0 });
  // Both attempts are paid for: 2 × (1,000 × $2 + 200 × $10 + 3,000 cache reads × $0.20), per million
  assert.ok(Math.abs(result.cost_usd - 2 * 0.0046) < 1e-12);
  assert.equal(calls.length, 0);
});

test('an invalid output is retried once with the validation error appended', async () => {
  const sent = stubFetch(() => anthropicMessage('{"thought":"Hmm","feeling":7}'), () => anthropicMessage('{"thought":"Hmm","feeling":-1}'));
  const { gateway, calls } = setup();
  const result = await gateway.call(request());

  assert.deepEqual(result.object, { thought: 'Hmm', feeling: -1 });
  assert.deepEqual(calls.map((c) => c.event.payload.status), ['invalid_output', 'ok']);
  assert.match(calls[0].event.payload.error ?? '', /feeling/);
  const retry = sent.bodies[1].messages[0].content.at(-1);
  assert.match(retry.text, /^That answer did not match the required format: .*feeling/s);
  assert.ok(Math.abs(result.cost_usd - 2 * 0.00023) < 1e-12, 'both attempts are paid for');
});

test('each paid attempt notifies after recording, and cancellation suppresses an invalid-output retry', async () => {
  const sent = stubFetch(() => anthropicMessage('{"thought":"bad","feeling":9}'), () => anthropicMessage(OK));
  const { gateway, calls } = setup();
  const controller = new AbortController();
  const seen: LlmAttempt[] = [];
  await assert.rejects(gateway.call(request({ signal: controller.signal, onAttempt(attempt) {
    seen.push(attempt);
    assert.equal(calls.length, seen.length, 'the ledger exists before budget observers run');
    controller.abort(new Error('recorded budget reached'));
  } })), /recorded budget reached/);
  assert.equal(sent.urls.length, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.usage_reported, true);
  assert.equal(seen[0].payload.status, 'invalid_output');
  assert.ok(seen[0].payload.cost_usd > 0);
});

test('setup attempt callbacks receive redacted transcripts and preserve successful results when the observer cancels', async () => {
  stubFetch(() => anthropicMessage(JSON.stringify({ thought: KEY, feeling: 0 })));
  const { gateway, calls } = setup();
  const controller = new AbortController();
  const seen: LlmAttempt[] = [];
  const result = await gateway.call(request({ run_id: null, system: KEY, signal: controller.signal, onAttempt(attempt) {
    seen.push(attempt);
    controller.abort();
  } }));
  assert.equal(result.object.thought, KEY, 'the original successful result is not discarded by accounting');
  assert.equal(calls.length, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.usage_reported, true);
  assert.equal(seen[0].payload.cost_usd, result.cost_usd);
  assert.doesNotMatch(JSON.stringify(seen[0].transcript), new RegExp(KEY));
  assert.match(JSON.stringify(seen[0].transcript), /\[redacted\]/);
});

test('successful Google and local responses with partial usage remain incomplete while retaining known tokens', async () => {
  const google = (usageMetadata?: Record<string, number>) => Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: OK }] }, finishReason: 'STOP', index: 0 }], ...(usageMetadata ? { usageMetadata } : {}) });
  stubFetch(
    () => google({ promptTokenCount: 1_000 }),
    () => google({ candidatesTokenCount: 200 }),
    () => google(),
    () => google({ promptTokenCount: 0, candidatesTokenCount: 0 }),
    () => google({ promptTokenCount: 1_000, candidatesTokenCount: 200, totalTokenCount: 1_250 }),
    async () => { const body = await chatCompletion(OK).json(); body.usage = { prompt_tokens: 1_000 }; return Response.json(body); },
  );
  const { gateway, calls } = setup();
  for (let i = 0; i < 5; i++) await gateway.call(request({ model: { provider: 'google', model: 'gemini-3.5-flash-lite' } }));
  await gateway.call(request({ model: { provider: 'openai_compatible', model: 'test-local' } }));
  assert.deepEqual(calls.map((call) => [call.event.payload.input_tokens, call.event.payload.output_tokens, call.event.payload.usage_reported]), [
    [1_000, 0, false], [0, 200, false], [0, 0, false], [0, 0, true], [1_000, 200, false], [1_000, 0, false],
  ]);
  assert.ok(calls[0].event.payload.cost_usd > 0 && calls[1].event.payload.cost_usd > 0, 'known partial charges are still counted');
});

test('requests aborted before dispatch record no attempt, including after a limiter wait', async () => {
  const sent = stubFetch(() => anthropicMessage(OK));
  const already = new AbortController();
  already.abort(new Error('already stopped'));
  const first = setup();
  let notified = 0;
  await assert.rejects(first.gateway.call(request({ signal: already.signal, onAttempt: () => notified++ })), /already stopped/);
  const waiting = new AbortController();
  const second = setup({ limits: { anthropic: { rpm: 0.5, tpm: 1_000_000 } }, sleep: async () => { waiting.abort(new Error('stopped while queued')); } });
  await assert.rejects(second.gateway.call(request({ signal: waiting.signal, onAttempt: () => notified++ })), /stopped while queued/);
  assert.deepEqual([sent.urls.length, first.calls.length, second.calls.length, notified], [0, 0, 0, 0]);
});

test('a second invalid output throws InvalidOutputError after recording both attempts', async () => {
  stubFetch(() => anthropicMessage('not json'), () => anthropicMessage('{"thought":"Hmm"}'));
  const { gateway, calls } = setup();
  await assert.rejects(gateway.call(request()), InvalidOutputError);
  assert.deepEqual(calls.map((c) => c.event.payload.status), ['invalid_output', 'invalid_output']);
});

test('an answer with no output in it, such as a refusal, is retried like an invalid one', async () => {
  stubFetch(
    () => Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: 'refusal', stop_sequence: null, usage: { input_tokens: 900, output_tokens: 0 } }),
    () => anthropicMessage('{"thought":"Fine.","feeling":0}'),
  );
  const { gateway, calls } = setup();
  const result = await gateway.call(request());
  assert.deepEqual(result.object, { thought: 'Fine.', feeling: 0 });
  assert.deepEqual(calls.map((c) => [c.event.payload.status, c.event.payload.input_tokens]), [['invalid_output', 900], ['ok', 1_000]]);
  assert.match(calls[0].event.payload.error ?? '', /^No answer \(finish reason: content-filter\)$/);
});

test('a 429 is retried after its retry-after, each failed attempt is logged, and the scheduler is told', async () => {
  const sent = stubFetch(
    () => anthropicError(429, 'rate_limit_error', 'Rate limited', { 'retry-after': '7' }),
    () => anthropicError(429, 'rate_limit_error', 'Rate limited', { 'retry-after': '7' }),
    () => anthropicMessage(OK),
  );
  const { gateway, calls, slept, throttled } = setup();
  const result = await gateway.call(request());

  assert.deepEqual(result.object, { thought: 'Jobs is in the menu.', feeling: 0 });
  assert.equal(sent.urls.length, 3);
  assert.deepEqual(slept, [7_000, 7_000]);
  assert.deepEqual(throttled, ['anthropic', 'anthropic']);
  assert.deepEqual(calls.map((c) => [c.event.payload.status, c.event.payload.error, c.event.payload.cost_usd > 0]), [
    ['error', 'Rate limited', false],
    ['error', 'Rate limited', false],
    ['ok', null, true],
  ]);
  assert.ok(Math.abs(result.cost_usd - 0.00023) < 1e-12, 'only the answer is paid for');
});

test('retry-after-ms is honoured too, with a little jitter on top', async () => {
  stubFetch(() => Response.json({ error: { message: 'Slow down', type: 'rate_limit_exceeded' } }, { status: 429, headers: { 'retry-after-ms': '1500' } }), () => openaiResponse(OK));
  const { gateway, slept, throttled } = setup();
  await gateway.call(request({ model: { provider: 'openai', model: 'gpt-6-luna' } }));
  assert.deepEqual(slept, [1_500]);
  assert.deepEqual(throttled, ['openai']);
});

test('an overloaded API (529) backs off exponentially, gives up after three retries, and is not a throttle signal', async () => {
  const sent = stubFetch(...Array.from({ length: 4 }, () => () => anthropicError(529, 'overloaded_error', 'Overloaded')));
  const { gateway, calls, slept, throttled } = setup();
  await assert.rejects(gateway.call(request()), /^Error: Anthropic answered 529: Overloaded \(gave up after 4 attempts\)$/);
  assert.equal(sent.urls.length, 4);
  assert.deepEqual(slept, [500, 1_000, 2_000], 'half the nominal 1 s, 2 s and 4 s: jitter picks between half and all of it');
  assert.deepEqual(calls.map((c) => c.event.payload.status), ['error', 'error', 'error', 'error']);
  assert.deepEqual(throttled, []);
});

test('a 5xx is retried, and so are transient failures between invalid outputs', async () => {
  stubFetch(
    () => anthropicError(500, 'api_error', 'Internal error'),
    () => anthropicMessage('{"thought":"Hmm","feeling":7}'),
    () => anthropicError(503, 'api_error', 'Unavailable'),
    () => anthropicMessage('{"thought":"Hmm","feeling":7}'),
  );
  const { gateway, calls, slept } = setup();
  await assert.rejects(gateway.call(request()), InvalidOutputError);
  assert.deepEqual(calls.map((c) => c.event.payload.status), ['error', 'invalid_output', 'error', 'invalid_output']);
  assert.deepEqual(slept, [500, 1_000]);
});

test('400, 401 and 403 are thrown at once, never retried, and the key never reaches the log or the error', async () => {
  for (const status of [400, 401, 403]) {
    const sent = stubFetch(() => anthropicError(status, 'invalid_request_error', `invalid x-api-key ${KEY}`));
    const { gateway, calls, slept, throttled } = setup();
    await assert.rejects(gateway.call(request()), (err: Error) => {
      assert.match(err.message, new RegExp(`^Anthropic answered ${status}: invalid x-api-key \\[redacted\\]$`));
      return true;
    });
    assert.deepEqual([sent.urls.length, slept.length, throttled.length], [1, 0, 0]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event.payload.status, 'error');
    assert.equal(calls[0].event.payload.cost_usd, 0);
    assert.match(calls[0].event.payload.error ?? '', /\[redacted\]/);
    assert.doesNotMatch(calls[0].event.payload.error + calls[0].transcript, /sk-ant-/);
    mock.restoreAll();
  }
});

test('every provider key shape is redacted from errors', async () => {
  const cases = [
    { model: HAIKU, key: KEYS.anthropic, answer: () => anthropicError(401, 'authentication_error', `bad key ${KEYS.anthropic}`) },
    { model: { provider: 'openai', model: 'gpt-6-luna' }, key: KEYS.openai, answer: () => Response.json({ error: { message: `Incorrect API key provided: ${KEYS.openai}`, type: 'invalid_request_error', code: 'invalid_api_key' } }, { status: 401 }) },
    { model: { provider: 'google', model: 'gemini-3.5-flash-lite' }, key: KEYS.google, answer: () => Response.json({ error: { code: 400, message: `API key not valid: ${KEYS.google}`, status: 'INVALID_ARGUMENT' } }, { status: 400 }) },
  ] as const;
  for (const { model, key, answer } of cases) {
    stubFetch(answer);
    const { gateway, calls } = setup();
    await assert.rejects(gateway.call(request({ model })), (err: Error) => {
      assert.ok(!err.message.includes(key) && err.message.includes('[redacted]'), err.message);
      return true;
    });
    assert.ok(!(calls[0].event.payload.error + calls[0].transcript).includes(key));
    mock.restoreAll();
  }
});

test('an exhausted account and a retry-after of minutes are not worth retrying', async () => {
  const sent = stubFetch(() => Response.json({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }, { status: 429 }));
  const { gateway, slept, throttled } = setup();
  await assert.rejects(gateway.call(request({ model: { provider: 'openai', model: 'gpt-6-luna' } })), /OpenAI answered 429: You exceeded your current quota/);
  assert.deepEqual([sent.urls.length, slept.length, throttled.length], [1, 0, 0], 'no retry, and not a rate limit either');

  mock.restoreAll();
  const daily = stubFetch(() => anthropicError(429, 'rate_limit_error', 'Daily limit reached', { 'retry-after': '3600' }));
  const again = setup();
  await assert.rejects(again.gateway.call(request()), /Anthropic answered 429: Daily limit reached/);
  assert.deepEqual([daily.urls.length, again.slept.length, again.throttled], [1, 0, ['anthropic']]);
});

test('the abort signal cancels the request', async () => {
  mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))));
  const { gateway, calls } = setup();
  const controller = new AbortController();
  const attempts: LlmAttempt[] = [];
  const call = gateway.call(request({ signal: controller.signal, onAttempt: (attempt) => attempts.push(attempt) }));
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(call);
  assert.equal(calls[0].event.payload.status, 'error');
  assert.equal(calls[0].event.payload.usage_reported, false, 'an aborted request without returned usage is not a known-free request');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].payload.cost_usd, 0);
});

test('stopping the run while a call waits to retry ends the call', async () => {
  const controller = new AbortController();
  const sent = stubFetch(() => anthropicError(429, 'rate_limit_error', 'Rate limited', { 'retry-after': '30' }), () => anthropicMessage(OK));
  const { gateway } = setup({
    sleep: async (_ms, signal) => {
      controller.abort();
      throw signal?.reason;
    },
  });
  await assert.rejects(gateway.call(request({ signal: controller.signal })));
  assert.equal(sent.urls.length, 1, 'no second request after the stop');
});

test('a retry wait that resolves after cancellation cannot dispatch another attempt', async () => {
  const controller = new AbortController();
  const sent = stubFetch(() => anthropicError(429, 'rate_limit_error', 'Rate limited'), () => anthropicMessage(OK));
  const { gateway, calls } = setup({ sleep: async () => { controller.abort(new Error('cancelled in backoff')); } });
  await assert.rejects(gateway.call(request({ signal: controller.signal })), /cancelled in backoff/);
  assert.equal(sent.urls.length, 1);
  assert.deepEqual(calls.map((call) => call.event.payload.usage_reported), [false]);
});

test('an unpriced cloud model is refused before any request, but a local one is free', async () => {
  const sent = stubFetch(() => chatCompletion(OK));
  const { gateway } = setup();
  await assert.rejects(gateway.call(request({ model: { provider: 'anthropic', model: 'claude-mystery-1' } })), /No price for model claude-mystery-1/);
  assert.equal(sent.bodies.length, 0);
  assert.equal((await gateway.call(request({ model: { provider: 'openai_compatible', model: 'some-local-model:7b' } }))).cost_usd, 0);
});

test('requests wait their turn when the provider\'s bucket is empty', async () => {
  stubFetch(() => anthropicMessage(OK), () => anthropicMessage(OK), () => openaiResponse(OK));
  const { gateway, slept } = setup({ limits: { anthropic: { rpm: 1, tpm: 1_000_000 } } });
  await gateway.call(request());
  assert.deepEqual(slept, []);
  await gateway.call(request());
  assert.deepEqual(slept, [60_000], 'one request a minute');
  await gateway.call(request({ model: { provider: 'openai', model: 'gpt-6-luna' } }));
  assert.deepEqual(slept, [60_000], 'each provider has its own bucket');
});

test('testProviderKey asks each provider\'s list endpoint, with the key in a header and never in the URL', async () => {
  const sent = stubFetch(...Array.from({ length: 5 }, () => () => Response.json({ data: [] })));
  assert.deepEqual(await testProviderKey('anthropic', KEYS.anthropic), { ok: true });
  assert.deepEqual(await testProviderKey('openai', KEYS.openai), { ok: true });
  assert.deepEqual(await testProviderKey('google', KEYS.google), { ok: true });
  assert.deepEqual(await testProviderKey('openai_compatible', `${LOCAL}/`), { ok: true });
  assert.deepEqual(await testProviderKey('deepseek', KEYS.deepseek), { ok: true });
  assert.deepEqual(sent.urls, [
    'https://api.anthropic.com/v1/models?limit=1',
    'https://api.openai.com/v1/models',
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    `${LOCAL}/models`,
    'https://api.deepseek.com/models',
  ]);
  assert.equal(sent.headers[0].get('x-api-key'), KEYS.anthropic);
  assert.equal(sent.headers[1].get('authorization'), `Bearer ${KEYS.openai}`);
  assert.equal(sent.headers[2].get('x-goog-api-key'), KEYS.google);
  assert.equal(sent.headers[3].get('authorization'), null);
  assert.equal(sent.headers[4].get('authorization'), `Bearer ${KEYS.deepseek}`);
  assert.ok(!sent.urls.some((u) => Object.values(KEYS).some((k) => u.includes(k))));
});

test('testProviderKey explains a rejected key, a refusal, an unreachable API and a timeout', async () => {
  const sent = stubFetch(
    () => anthropicError(401, 'authentication_error', 'invalid x-api-key'),
    () => Response.json({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }, { status: 401 }),
    () => anthropicError(403, 'permission_error', 'This key cannot list models'),
    () => Response.json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }, { status: 400 }),
    () => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
  );
  const fail = async (provider: ProviderId, credential: string) => {
    const result = await testProviderKey(provider, credential);
    assert.equal(result.ok, false);
    return result.ok ? '' : result.error;
  };
  assert.match(await fail('anthropic', KEY), /^Anthropic rejected this key \(401\)/);
  assert.match(await fail('openai', KEYS.openai), /^OpenAI rejected this key \(401\)/);
  assert.equal(await fail('anthropic', KEY), 'Anthropic answered 403: This key cannot list models');
  assert.equal(await fail('google', KEYS.google), 'Google answered 400: API key not valid. Please pass a valid API key.');
  assert.equal(await fail('openai_compatible', LOCAL), 'The local endpoint answered 502: Bad Gateway');
  assert.ok(sent.urls.length === 5);

  mock.restoreAll();
  mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.ok(init.signal instanceof AbortSignal, 'every request has a timeout');
    throw new TypeError('fetch failed');
  });
  assert.match(await fail('anthropic', KEY), /^Could not reach api\.anthropic\.com \(fetch failed\)\. Check the internet connection/);
  assert.match(await fail('openai_compatible', LOCAL), /^Could not reach localhost:11434 \(fetch failed\)\. Is the server running\?/);

  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  assert.match(await fail('openai', KEYS.openai), /^api\.openai\.com did not answer within 15 seconds/);
  assert.match(await fail('openai_compatible', 'localhost:11434/v1'), /is not a web address/);
});

test('testProviderKey never puts a key in the message it returns', async () => {
  for (const provider of ['anthropic', 'openai', 'google', 'deepseek'] as const) {
    const key = KEYS[provider];
    stubFetch(() => Response.json({ error: { message: `no access for ${key}`, code: 403, status: 'PERMISSION_DENIED' } }, { status: 403 }));
    const refused = await testProviderKey(provider, key);
    assert.ok(!refused.ok && !refused.error.includes(key) && refused.error.includes('[redacted]'), JSON.stringify(refused));
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError(`connect failed while sending ${key}`);
    });
    const offline = await testProviderKey(provider, key);
    assert.ok(!offline.ok && !offline.error.includes(key), JSON.stringify(offline));
    mock.restoreAll();
  }
});

test('a sampling setting the provider reports it ignored is logged as null', () => {
  const ignored = [{ type: 'unsupported' as const, feature: 'temperature' }];
  assert.deepEqual([accepted(1, 'temperature', ignored), accepted(42, 'seed', ignored), accepted(1, 'temperature', [])], [null, 42, 1]);
});
