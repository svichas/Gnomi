// The real gateway against a stubbed fetch: no network, no key, no cost.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { z } from 'zod';
import type { LlmRequest, Recorder } from '../seams.ts';
import type { EventOf, GnomiEvent } from '../types.ts';
import { createAnthropicGateway, InvalidOutputError, testAnthropicKey } from './gateway.ts';

const KEY = 'sk-ant-api03-test-key-0123456789';
const schema = z.object({ thought: z.string(), feeling: z.number().int().min(-2).max(2) });
const shot = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const request = (signal?: AbortSignal): LlmRequest<z.infer<typeof schema>> => ({
  role: 'navigator',
  model: 'claude-haiku-5-5',
  run_id: 'r-0001',
  persona_id: 'p-001',
  round: 1,
  system: 'This is Priya.',
  user: [
    { type: 'image', data: shot, mediaType: 'image/jpeg' },
    { type: 'text', text: 'What does Priya do next?' },
  ],
  schema,
  signal,
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

const message = (text: string, usage = { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 3_000, cache_creation_input_tokens: 0 }) =>
  Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage });

function stubFetch(...responses: Array<() => Response | Promise<Response>>) {
  const bodies: any[] = [];
  const headers: Headers[] = [];
  mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(init.body ? JSON.parse(String(init.body)) : null);
    headers.push(new Headers(init.headers));
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');
    return next();
  });
  return { bodies, headers };
}

afterEach(() => mock.restoreAll());

test('one call: cached system prefix, screenshot, low effort, native schema, cost from usage', async () => {
  const sent = stubFetch(() => message('{"thought":"Jobs is in the menu.","feeling":0}'));
  const { record, calls } = recorder();
  const result = await createAnthropicGateway({ apiKey: KEY, record }).call(request());

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
  assert.deepEqual(
    { ...payload, latency_ms: 0 },
    {
      role: 'navigator',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      input_tokens: 1_000,
      output_tokens: 200,
      cache_read_tokens: 3_000,
      cache_write_tokens: 0,
      cost_usd: result.cost_usd,
      latency_ms: 0,
      status: 'ok',
      error: null,
    },
  );
  assert.deepEqual([run_id, persona_id], ['r-0001', 'p-001']);
  assert.match(calls[0].transcript, /"type":"image","mediaType":"image\/jpeg","bytes":4/);
  assert.doesNotMatch(calls[0].transcript, /sk-ant-|\/9j\//); // no key, no base64 screenshot
});

test('an invalid output is retried once with the validation error appended', async () => {
  const sent = stubFetch(
    () => message('{"thought":"Hmm","feeling":7}'),
    () => message('{"thought":"Hmm","feeling":-1}'),
  );
  const { record, calls } = recorder();
  const result = await createAnthropicGateway({ apiKey: KEY, record }).call(request());

  assert.deepEqual(result.object, { thought: 'Hmm', feeling: -1 });
  assert.deepEqual(
    calls.map((c) => c.event.payload.status),
    ['invalid_output', 'ok'],
  );
  assert.match(calls[0].event.payload.error ?? '', /feeling/);
  const retry = sent.bodies[1].messages[0].content.at(-1);
  assert.match(retry.text, /^That answer did not match the required format: .*feeling/s);
  assert.ok(Math.abs(result.cost_usd - 2 * 0.00023) < 1e-12, 'both attempts are paid for');
});

test('a second invalid output throws InvalidOutputError after recording both attempts', async () => {
  stubFetch(
    () => message('not json'),
    () => message('{"thought":"Hmm"}'),
  );
  const { record, calls } = recorder();
  await assert.rejects(createAnthropicGateway({ apiKey: KEY, record }).call(request()), InvalidOutputError);
  assert.deepEqual(
    calls.map((c) => c.event.payload.status),
    ['invalid_output', 'invalid_output'],
  );
});

test('an answer with no output in it, such as a refusal, is retried like an invalid one', async () => {
  stubFetch(
    () => Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: 'refusal', stop_sequence: null, usage: { input_tokens: 900, output_tokens: 0 } }),
    () => message('{"thought":"Fine.","feeling":0}'),
  );
  const { record, calls } = recorder();
  const result = await createAnthropicGateway({ apiKey: KEY, record }).call(request());
  assert.deepEqual(result.object, { thought: 'Fine.', feeling: 0 });
  assert.deepEqual(
    calls.map((c) => [c.event.payload.status, c.event.payload.input_tokens]),
    [
      ['invalid_output', 900],
      ['ok', 1_000],
    ],
  );
  assert.match(calls[0].event.payload.error ?? '', /^No answer \(finish reason: content-filter\)$/);
});

test('an API error is recorded with the key redacted and rethrown', async () => {
  stubFetch(() => Response.json({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }, { status: 401 }));
  const { record, calls } = recorder();
  await assert.rejects(createAnthropicGateway({ apiKey: KEY, record }).call(request()), /invalid x-api-key/);
  assert.equal(calls[0].event.payload.status, 'error');
  assert.equal(calls[0].event.payload.cost_usd, 0);
  assert.match(calls[0].event.payload.error ?? '', /\[redacted\]/);
  assert.doesNotMatch(calls[0].event.payload.error + calls[0].transcript, /sk-ant-/);
});

test('the abort signal cancels the request', async () => {
  mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))));
  const { record, calls } = recorder();
  const controller = new AbortController();
  const call = createAnthropicGateway({ apiKey: KEY, record }).call(request(controller.signal));
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(call);
  assert.equal(calls[0].event.payload.status, 'error');
});

test('an unpriced model is refused before any request is sent', async () => {
  const sent = stubFetch();
  const { record } = recorder();
  await assert.rejects(createAnthropicGateway({ apiKey: KEY, record }).call({ ...request(), model: 'claude-mystery-1' }), /No price/);
  assert.equal(sent.bodies.length, 0);
});

test('testAnthropicKey explains success, a rejected key and an unreachable API', async () => {
  const sent = stubFetch(
    () => Response.json({ data: [{ id: 'claude-haiku-5-5' }] }),
    () => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 }),
    () => Response.json({ type: 'error', error: { type: 'permission_error', message: 'This key cannot list models' } }, { status: 403 }),
  );
  assert.deepEqual(await testAnthropicKey(KEY), { ok: true });
  assert.equal(sent.headers[0].get('x-api-key'), KEY);
  const rejected = await testAnthropicKey(KEY);
  assert.ok(!rejected.ok && /rejected this key \(401\)/.test(rejected.error));
  const forbidden = await testAnthropicKey(KEY);
  assert.ok(!forbidden.ok && forbidden.error === 'Anthropic answered 403: This key cannot list models');
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const offline = await testAnthropicKey(KEY);
  assert.ok(!offline.ok && /Could not reach api\.anthropic\.com \(fetch failed\)/.test(offline.error));
});
