import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { socialParts, socialSchema, socialSystemPrompt, stepSchema, surveySchema } from '../agent/prompt.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import type { LlmAttempt, LlmRequest, Recorder } from '../seams.ts';
import type { EventOf, GnomiEvent, ProjectConfig } from '../types.ts';
import { InvalidOutputError } from './gateway.ts';
import { createScriptedGateway, DEMO_JUDGE, DEMO_NAVIGATOR, DEMO_SOCIALISER } from './scripted.ts';
import { comparisonAssessmentSchema, comparisonVerificationSchema } from '../comparison/prompts.ts';

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

test('the demo comparison returns explicitly unknown evidence without invalid-output retries or a fictional success', async () => {
  const { record, events } = recorder();
  const gateway = createScriptedGateway({ judge: DEMO_JUDGE }, record);
  const input = { ...request(), role: 'judge' as const, user: [{ type: 'text' as const, text: JSON.stringify({ criteria: [{ id: 'cost' }] }) }] };
  const assessment = (await gateway.call({ ...input, purpose: 'comparison_assessment', schema: comparisonAssessmentSchema })).object;
  assert.equal(assessment.outcome, 'incomplete');
  assert.equal(assessment.criteria[0].assessment, 'unknown');
  assert.deepEqual(assessment.criteria[0].evidence, []);
  assert.match(assessment.criteria[0].summary, /no model assessed/);
  const verification = (await gateway.call({ ...input, purpose: 'comparison_verification', schema: comparisonVerificationSchema })).object;
  assert.equal(verification.outcome_supported, false);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.payload.status === 'ok'));
});

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

test('scripted attempt notifications include setup costs and can stop paid invalid retries', async () => {
  const { record, events } = recorder();
  const seen: LlmAttempt[] = [];
  const controller = new AbortController();
  const gateway = createScriptedGateway([{ thought: 'bad', feeling: 9 }, { thought: 'ok', feeling: 0 }], record, { costPerCall: 0.25 });
  await assert.rejects(gateway.call(request({ signal: controller.signal, onAttempt(attempt) {
    seen.push(attempt);
    assert.equal(events.length, 1);
    controller.abort(new Error('budget'));
  } })), /budget/);
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].payload.usage_reported, seen[0].payload.cost_usd], [true, 0.25]);
  const result = await gateway.call(request({ run_id: null, onAttempt: (attempt) => seen.push(attempt) }));
  assert.equal(result.object.thought, 'ok', 'cancellation did not consume the next scripted answer');
  assert.equal(events.length, 1);
  assert.equal(seen.length, 2);
});

test('the demo navigator plays scroll, a labelled friction, then abandon, for each persona on its own', async () => {
  const gateway = createScriptedGateway({ navigator: DEMO_NAVIGATOR }, recorder().record);
  const step = async (persona_id: string, run_id = 'r-demo-1') => (await gateway.call({ ...request({ run_id, persona_id }), schema: stepSchema(BUILTIN_PERSONA) })).object;

  const a1 = await step('p-1');
  const b1 = await step('p-2'); // another persona starts from the beginning, even though p-1 is mid-way
  const survey = (await gateway.call({ ...request({ run_id: 'r-demo-1', persona_id: 'p-1' }), purpose: 'survey', schema: surveySchema })).object;
  assert.match(survey.reason, /Scripted demo/, 'a survey request gets a valid demo survey and leaves the steps where they were');
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

test('the demo socialiser reads the real social prompt and answers validly, mostly with silence, the same way each time', () => {
  const project = { name: 'Gym ATS', description: '', pois: [{ id: 'poi-1', type: 'web', name: 'Gym ATS', start_url: 'http://gym.test/', allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null }], goal: 'Post a job', role: null, audience: null, settings: DEFAULT_SETTINGS } satisfies ProjectConfig;
  const line = (post_id: string) => ({ post_id, author: 'Ana Ruiz', text: 'Lost my draft.', agree: 0, disagree: 0, parent: null });
  const ask = (persona_id: string, ids: string[]) => {
    const user = socialParts({ persona: BUILTIN_PERSONA, project, round: 2, rounds: 5, end: null, steps: 3, frictions: [], pois: [{ name: 'Gym ATS', opinion: null }], posted: [], feed: ids.map(line) });
    const answer = DEMO_SOCIALISER({ ...request(), role: 'socialiser', persona_id, round: 2, system: socialSystemPrompt(BUILTIN_PERSONA, project, null), user, schema: socialSchema(ids, ['poi-1']) });
    assert.ok(socialSchema(ids, ['poi-1']).safeParse(answer).success, JSON.stringify(answer));
    return answer as { action: string; post_id: string | null; about_poi_id: string | null; text: string | null; opinion_updates: unknown[] };
  };
  for (const ids of [['r1-p-a', 'inj-r1-1'], []]) {
    const answers = Array.from({ length: 200 }, (_, i) => ask(`p-${i}`, ids));
    const count = (action: string) => answers.filter((a) => a.action === action).length;
    assert.ok(count('nothing') > 120, `${count('nothing')} of 200 stay silent`);
    assert.ok(count('post') > 0);
    if (ids.length) assert.ok(count('react') > 0 && count('reply') > 0 && answers.every((a) => a.post_id === null || a.post_id === ids[0]));
    else assert.equal(count('post') + count('nothing'), 200, 'an empty feed has nothing to answer');
    assert.ok(answers.every((a) => a.opinion_updates.length === 0 && (a.text === null || /^Scripted demo/.test(a.text))));
    assert.ok(answers.filter((a) => a.action === 'post').every((a) => a.about_poi_id === 'poi-1'));
  }
  assert.deepEqual(ask('p-7', ['r1-p-a']), ask('p-7', ['r1-p-a']));
});

test('scripted calls record the request purpose and POI like the real gateway', async () => {
  const { record, events } = recorder();
  await createScriptedGateway({ navigator: () => ({ thought: 'x', feeling: 0 }) }, record).call(request({ purpose: 'step', poi_id: 'poi-1' }));
  assert.deepEqual([events[0].payload.purpose, events[0].poi_id], ['step', 'poi-1']);
});
