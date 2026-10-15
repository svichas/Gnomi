import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { stepSchema } from '../agent/prompt.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import type { LlmRequest, Recorder } from '../seams.ts';
import type { EventOf, GnomiEvent } from '../types.ts';
import { InvalidOutputError } from './gateway.ts';
import { createScriptedGateway, DEMO_NAVIGATOR } from './scripted.ts';

const schema = z.object({ thought: z.string(), feeling: z.number().int().min(-2).max(2) });
const model = { provider: 'anthropic', model: 'claude-haiku-5-5' } as const;
const request = (over: Partial<LlmRequest<z.infer<typeof schema>>> = {}): LlmRequest<z.infer<typeof schema>> => ({
  role: 'navigator',
  model,
  run_id: 'r-0001',
  persona_id: 'p-001',
  round: 1,
  system: 'This is Priya.',
  user: [{ type: 'text', text: 'What now?' }],
  schema,
  ...over,
});

function recorder() {
  const events: EventOf<'llm.call'>[] = [];
  const transcripts: unknown[] = [];
  const record: Recorder = (event, transcript) => {
    const stored = { ...event, seq: events.length + 1, ts: 0 } as GnomiEvent;
    events.push(stored as EventOf<'llm.call'>);
    transcripts.push(transcript);
    return stored;
  };
  return { record, events, transcripts };
}

test('an array script answers calls in order, whatever their role, and runs out loudly', async () => {
  const { record, events } = recorder();
  const gateway = createScriptedGateway([{ thought: 'one', feeling: 0 }, (req) => ({ thought: req.persona_id, feeling: 1 })], record);
  assert.deepEqual((await gateway.call(request())).object, { thought: 'one', feeling: 0 });
  assert.deepEqual((await gateway.call(request({ role: 'judge' }))).object, { thought: 'p-001', feeling: 1 });
  await assert.rejects(gateway.call(request()), /The script ran out after 2 model calls/);
  assert.deepEqual(events.map((e) => [e.payload.provider, e.payload.model, e.payload.status, e.payload.cost_usd]), [
    ['scripted', 'claude-haiku-5-5', 'ok', 0],
    ['scripted', 'claude-haiku-5-5', 'ok', 0],
  ]);
});

test('an invalid answer is retried once with the validation error appended, then fails', async () => {
  const { record, events } = recorder();
  const seen: string[] = [];
  const bad = (req: LlmRequest<unknown>) => {
    seen.push(JSON.stringify(req.user));
    return { thought: 'x', feeling: 9 };
  };
  const gateway = createScriptedGateway([bad, { thought: 'ok', feeling: 2 }, bad, bad], record);
  assert.deepEqual((await gateway.call(request())).object, { thought: 'ok', feeling: 2 });
  assert.match(seen[0], /^\[\{"type":"text","text":"What now\?"\}\]$/);
  await assert.rejects(gateway.call(request()), InvalidOutputError);
  assert.match(seen[2], /That answer did not match the required format: .*feeling/s);
  assert.deepEqual(events.map((e) => e.payload.status), ['invalid_output', 'ok', 'invalid_output', 'invalid_output']);
});

test('a role map hands each role to its own responder', async () => {
  const { record } = recorder();
  const gateway = createScriptedGateway(
    { navigator: (req) => ({ thought: `nav ${req.persona_id}`, feeling: 0 }), judge: () => ({ thought: 'judged', feeling: 1 }) },
    record,
  );
  assert.deepEqual((await gateway.call(request())).object, { thought: 'nav p-001', feeling: 0 });
  assert.deepEqual((await gateway.call(request({ role: 'judge', persona_id: null }))).object, { thought: 'judged', feeling: 1 });
  assert.deepEqual((await gateway.call(request({ persona_id: 'p-002' }))).object, { thought: 'nav p-002', feeling: 0 }, 'a responder is called again for every call');
  await assert.rejects(gateway.call(request({ role: 'author' })), /no responder for the author role/);
});

test('costPerCall is spent on every attempt, logged and returned', async () => {
  const { record, events } = recorder();
  const answers = [{ thought: 'x', feeling: 9 }, { thought: 'ok', feeling: 0 }];
  const gateway = createScriptedGateway({ navigator: () => answers.shift() }, record, { costPerCall: 0.25 });
  const result = await gateway.call(request());
  assert.equal(result.cost_usd, 0.5, 'the invalid attempt is paid for too');
  assert.deepEqual(events.map((e) => e.payload.cost_usd), [0.25, 0.25]);
  assert.equal((await createScriptedGateway({ navigator: () => ({ thought: 'x', feeling: 0 }) }, record).call(request())).cost_usd, 0, 'free by default');
});

test('a setup call is priced but records nothing', async () => {
  const { record, events, transcripts } = recorder();
  const gateway = createScriptedGateway({ persona_writer: () => ({ thought: 'bio', feeling: 0 }) }, record, { costPerCall: 0.01 });
  const result = await gateway.call(request({ role: 'persona_writer', run_id: null, persona_id: null }));
  assert.deepEqual(result, { object: { thought: 'bio', feeling: 0 }, cost_usd: 0.01 });
  assert.deepEqual([events.length, transcripts.length], [0, 0]);
});

test('the demo navigator plays scroll, a labelled friction, then abandon, for each persona on its own', async () => {
  const gateway = createScriptedGateway({ navigator: DEMO_NAVIGATOR }, recorder().record);
  const step = async (persona_id: string, run_id = 'r-demo-1') => (await gateway.call({ ...request({ run_id, persona_id }), schema: stepSchema(BUILTIN_PERSONA) })).object;

  const a1 = await step('p-1');
  const b1 = await step('p-2'); // another persona starts from the beginning, even though p-1 is mid-way
  const a2 = await step('p-1');
  const a3 = await step('p-1');
  const b2 = await step('p-2');
  assert.deepEqual([a1.action, a1.friction], [{ type: 'scroll', ref: null, text: 'down' }, null]);
  assert.deepEqual(b1, a1);
  assert.equal(a2.action.type, 'scroll');
  assert.match(a2.friction?.what ?? '', /scripted demo/);
  assert.deepEqual(a2.opinion, {
    sentiment: -1,
    confidence: 0.5,
    likes: ['Sample like from the scripted demo: clear navigation; no model assessed this page'],
    frictions: ['Sample friction from the scripted demo persona; no model looked at this page'],
  });
  assert.deepEqual(b2, a2);
  assert.equal(a3.action.type, 'abandon');
  assert.match(a3.thought + a3.action.text, /Scripted demo/);

  assert.deepEqual(await step('p-1', 'r-demo-2'), a1, 'a new run starts over');
  assert.equal((await step('p-1')).action.type, 'abandon', 'past the end it keeps abandoning rather than throwing');
});
