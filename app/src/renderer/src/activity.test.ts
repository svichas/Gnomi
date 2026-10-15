import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttributeValue, EventPayloads, EventType, GnomiEvent, Persona, ProfileAttribute, RunConfig, Segment } from '@gnomi/engine/types.ts';
import { getPersonaSchema } from '@gnomi/engine/profile/schema.ts';
import { BUILTIN_PERSONA } from '@gnomi/engine/persona.ts';
import { countStates, filterEvents, filterPersonas, matchesProfileValues, merge, personaProgress, personaStates, resetOutcome, runSetup, stopText, toRows, waitingBlocks } from './activity.ts';

function event<K extends EventType>(seq: number, type: K, payload: EventPayloads[K], persona_id: string | null = 'p-001'): GnomiEvent {
  return { seq, ts: seq, run_id: 'r-0001', round: 1, persona_id, poi_id: 'poi-1', type, payload } as GnomiEvent;
}
const blockedRequest = (seq: number, host: string, path: string) => event(seq, 'containment.blocked_request', { host, url: `http://${host}${path}`, method: 'GET' });
const blocked = (seq: number, reason: 'captcha' | 'session_expired' = 'captcha', who = 'p-001') => event(seq, 'persona.blocked', { step_no: 2, reason, detail: 'recaptcha' }, who);
const resumed = (seq: number, who = 'p-001') => event(seq, 'persona.resumed', { step_no: 2 }, who);

test('opinion updates have their own activity category with explicit self-reported confidence', () => {
  const changed = event(3, 'persona.opinion_changed', { poi_id: 'poi-1', before: null, after: { sentiment: -1, confidence: 0.7, likes: ['Clear labels'], frictions: ['No confirmation'] }, cause: { step_ids: [2], post_ids: [] } });
  const rows = toRows([changed]);
  assert.equal(rows[0].label, 'Opinion');
  assert.match(rows[0].title, /Sentiment -1.*confidence 70%/);
  assert.match(rows[0].detail ?? '', /Clear labels.*No confirmation/);
  assert.deepEqual(filterEvents([changed, blocked(4)], { persona: '', segment: '', category: 'opinions' }, new Map()).map((e) => e.seq), [3]);
});

test('a survey answer reads as a row with its reason quoted, filed with opinions, and leaves the persona as she ended', () => {
  const done = event(2, 'persona.goal_done', { step_no: 1, summary: 'Posted' });
  const survey = event(3, 'persona.survey', { poi_id: 'poi-1', sentiment: 1, confidence: 0.8, likes: ['Clear form'], frictions: [], would_continue: true, reason: 'It just worked.' });
  const [row] = toRows([survey]);
  assert.deepEqual([row.label, row.quote], ['Survey', 'It just worked.']);
  assert.match(row.title, /^Would keep using it; sentiment \+1, self-reported confidence 80%/);
  assert.match(row.detail ?? '', /Frictions: none reported\. Likes: Clear form\./);
  assert.deepEqual(filterEvents([done, survey], { persona: '', segment: '', category: 'opinions' }, new Map()).map((e) => e.seq), [3]);
  assert.equal(personaStates([done, survey], [{ id: 'p-001' } as Persona]).get('p-001'), 'done');
});

test('profile filters retain typed false, zero and list values and filter the roster and activity together', () => {
  const attribute = (id: string, type: ProfileAttribute['type']): ProfileAttribute => ({
    id, name: id, type, group: 'work', description: 'A test attribute.', core: false, enabled: true, show_on_card: true, use_in_prompt: true, report_dimension: true,
    sampling: { default: { kind: 'fixed', value: type === 'number' ? 0 : type === 'list' ? [] : false }, by_segment: {} },
  });
  const schema = { ...getPersonaSchema(), attributes: [...getPersonaSchema().attributes, attribute('accepted', 'boolean'), attribute('tenure', 'number'), attribute('tools', 'list')] };
  const people = [
    { ...BUILTIN_PERSONA, id: 'a', segment_id: 'seg-1', attributes: { accepted: false, tenure: 0, tools: ['A', 'B'] } },
    { ...BUILTIN_PERSONA, id: 'b', segment_id: 'seg-2', attributes: { accepted: true, tenure: 1, tools: ['B', 'A'] } },
  ];
  const events = [blocked(1, 'captcha', 'a'), blocked(2, 'captcha', 'b'), event(3, 'run.finished', {}, null)];
  for (const [dimension, value] of [['accepted', false], ['tenure', 0], ['tools', ['A', 'B']]] as [string, AttributeValue][]) {
    const filters = { persona: '', segment: '', category: '' as const, dimension, value: JSON.stringify(value) };
    assert.deepEqual(filterPersonas(people, filters, schema).map((persona) => persona.id), ['a']);
    assert.deepEqual(filterEvents(events, filters, new Map(people.map((persona) => [persona.id, persona])), schema).map((event) => event.seq), [1]);
    assert.equal(matchesProfileValues(people[0].attributes, filters), true);
    assert.equal(matchesProfileValues(people[1].attributes, filters), false);
  }
  assert.equal(matchesProfileValues({ accepted: 'false' }, { dimension: 'accepted', value: 'false' }), false);
  const hidden = { ...schema, attributes: schema.attributes.map((a) => a.id === 'accepted' ? { ...a, enabled: false } : a) };
  assert.deepEqual(filterPersonas(people, { dimension: 'accepted', value: 'false' }, hidden), []);
});

test('blocked requests are one row per host that keeps its place while its count grows', () => {
  const events = [
    event(1, 'persona.episode_started', { poi_id: 'poi-1', device: 'desktop', start_url: 'http://localhost/' }),
    blockedRequest(2, 'cdn.example.com', '/a.js'),
    blockedRequest(3, 'ads.example.net', '/p.gif'),
    blockedRequest(4, 'cdn.example.com', '/b.js'),
    blockedRequest(5, 'cdn.example.com', '/c.js'),
  ];
  const rows = toRows(events);
  assert.deepEqual(
    rows.map(({ seq, title }) => [seq, title]),
    [
      [3, 'Blocked requests to ads.example.net (1)'],
      [2, 'Blocked requests to cdn.example.com (3)'],
      [1, 'Opened http://localhost/ in a desktop browser'],
    ],
  );
  assert.equal(toRows([...events, blockedRequest(6, 'ads.example.net', '/q.gif')]).find((row) => row.seq === 3)?.title, 'Blocked requests to ads.example.net (2)');
});

test('safety stops and the pause for the user have their own rows', () => {
  const rows = toRows([
    blocked(1, 'session_expired'),
    resumed(2),
    event(3, 'containment.tripwire', { kind: 'live_payment_key', detail: 'pk_live_ on /pay' }),
    event(4, 'run.stopped', { reason: 'tripwire', detail: 'pk_live_ on /pay' }),
  ]);
  assert.deepEqual(rows.map((row) => row.tone), ['alarm', 'alarm', 'good', 'bad']);
  assert.match(rows[3].title, /Login expired/);
});

test('a blocked persona is waited on until she resumes or her episode ends, and not once the run has ended', () => {
  assert.deepEqual(waitingBlocks([]), []);
  assert.deepEqual(waitingBlocks([blocked(1)]).map((e) => e.seq), [1]);
  assert.deepEqual(waitingBlocks([blocked(1), resumed(2)]), []);
  assert.deepEqual(waitingBlocks([blocked(1), resumed(2), blocked(3)]).map((e) => e.seq), [3], 'blocked again after a retry');
  assert.deepEqual(waitingBlocks([blocked(1), event(2, 'persona.abandoned', { step_no: 2, reason: 'timed out' })]), []);
  assert.deepEqual(waitingBlocks([blocked(1), event(2, 'run.stopped', { reason: 'user', detail: null }, null)]), []);
});

test('several blocked personas are each waited on, and one resuming does not free the others', () => {
  const events = [blocked(1, 'session_expired', 'p-1-01'), blocked(2, 'session_expired', 'p-1-02'), blocked(3, 'captcha', 'p-2-01'), resumed(4, 'p-1-01')];
  assert.deepEqual(waitingBlocks(events).map((e) => e.persona_id), ['p-1-02', 'p-2-01']);
});

const person = (id: string, segment: string | null) => ({ id, segment_id: segment, name: id }) as Persona;
const start = (seq: number, who: string) => event(seq, 'persona.episode_started', { poi_id: 'poi-1', device: 'desktop', start_url: 'http://localhost/' }, who);

test('each persona is waiting, working, blocked, done or gave up, and a run that ends cuts the rest short', () => {
  const people = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => person(id, null));
  const events = [
    start(1, 'a'),
    start(2, 'b'),
    start(3, 'c'),
    start(4, 'd'),
    event(5, 'persona.goal_done', { step_no: 3, summary: 'ok' }, 'a'),
    event(6, 'persona.abandoned', { step_no: 5, reason: 'lost' }, 'b'),
    blocked(7, 'captcha', 'c'),
    event(8, 'signal.repeated_failure', { step_no: 4, action: 'click', error: 'ref_not_found' }, 'e'),
  ];
  assert.deepEqual([...personaStates(events, people)], [['a', 'done'], ['b', 'abandoned'], ['c', 'blocked'], ['d', 'active'], ['e', 'abandoned'], ['f', 'waiting']]);
  assert.deepEqual(countStates(personaStates(events, people)), { waiting: 1, active: 1, blocked: 1, done: 1, abandoned: 2, unfinished: 0 });
  const ended = personaStates([...events, event(9, 'run.stopped', { reason: 'user', detail: null }, null)], people);
  assert.deepEqual([...ended.values()], ['done', 'abandoned', 'blocked', 'unfinished', 'abandoned', 'unfinished']);
  assert.equal(personaStates([start(1, 'unknown')], people).has('unknown'), false, 'events of someone outside the population are ignored');
});

test('the activity filters keep one persona, one segment or one kind of event', () => {
  const people = new Map([person('a1', 'seg-1'), person('a2', 'seg-1'), person('b1', 'seg-2')].map((p) => [p.id, p]));
  const step = (seq: number, who: string) => event(seq, 'persona.step', { step_no: seq, action: { type: 'wait', ref: null, text: null }, target: null, result: { ok: true, url_before: '', url_after: '', dom_changed: false, error: null }, thought: '', feeling: 0, snapshot_hash: '', screenshot: null, duration_ms: 1 }, who);
  const friction = (seq: number, who: string) => event(seq, 'persona.friction_reported', { step_no: 1, severity: 2, what: 'w', expected: 'e', where: { url: '', ref: null } }, who);
  const events = [step(1, 'a1'), step(2, 'a2'), step(3, 'b1'), friction(4, 'b1'), event(5, 'run.stopped', { reason: 'user', detail: null }, null)];
  const seqs = (filters: Partial<Parameters<typeof filterEvents>[1]>) => filterEvents(events, { persona: '', segment: '', category: '', ...filters }, people).map((e) => e.seq);
  assert.deepEqual(seqs({}), [1, 2, 3, 4, 5]);
  assert.deepEqual(seqs({ persona: 'a2' }), [2]);
  assert.deepEqual(seqs({ segment: 'seg-1' }), [1, 2]);
  assert.deepEqual(seqs({ category: 'frictions' }), [4]);
  assert.deepEqual(seqs({ segment: 'seg-2', category: 'steps' }), [3]);
  assert.deepEqual(seqs({ category: 'run' }), [5]);
});

test('merge ignores events it already has and keeps them in order', () => {
  const have = [resumed(2)];
  assert.equal(merge(have, [resumed(2)]), have);
  assert.equal(merge(have, []), have);
  assert.deepEqual(merge(have, [blocked(1), resumed(2), resumed(3)]).map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(merge(have, [resumed(3), resumed(4)]).map((e) => e.seq), [2, 3, 4]);
  assert.deepEqual(merge([], [resumed(1)]).map((e) => e.seq), [1]);
});

test('detected signals read as sentences and have their own category', () => {
  const base = { step_no: 3, url: 'http://gym.test/jobs/new', ref: 'e7' };
  const signals = [
    event(1, 'signal.failed_action', { ...base, action: 'click', error: 'no_effect' }),
    event(2, 'signal.failed_action', { ...base, action: 'type', error: 'not_editable' }),
    event(3, 'signal.loop', { ...base, snapshot_hash: 'h', visits: 3 }),
    event(4, 'signal.backtrack', { ...base, kind: 'repeated_back' }),
    event(5, 'signal.error', { ...base, kind: 'http', status: 404, message: 'GET http://gym.test/job' }),
    event(6, 'signal.validation_error', { ...base, message: 'Enter a job title' }),
    event(7, 'signal.small_target', { ...base, box: [0, 0, 35.4, 23] }),
  ];
  assert.deepEqual(
    toRows(signals).reverse().map((row) => [row.label, row.title, row.detail]),
    [
      ['Step 3', 'Detected: the click changed nothing', base.url],
      ['Step 3', 'Detected: the type failed (field cannot be typed into)', base.url],
      ['Step 3', 'Detected: the same page 3 times in a few steps', base.url],
      ['Step 3', 'Detected: went back again and again', base.url],
      ['Step 3', 'Detected: the site answered HTTP 404', 'GET http://gym.test/job'],
      ['Step 3', 'Detected: an error message appeared after submitting', 'Enter a job title'],
      ['Step 3', 'Detected: tapped a small target, 35×23 px', base.url],
    ],
  );
  assert.equal(filterEvents([...signals, blocked(8)], { persona: '', segment: '', category: 'signals' }, new Map()).length, signals.length);
});

test('a change of pace is a row of its own', () => {
  const [row] = toRows([event(1, 'run.concurrency_changed', { concurrency: 6, reason: 'The provider rate-limited us' }, null)]);
  assert.equal(row.title, 'Now running 6 personas at a time');
  assert.equal(row.detail, 'The provider rate-limited us');
});

test('the reset hook outcome says whether it worked', () => {
  assert.deepEqual(resetOutcome({ status: 204, error: null }), { ok: true, text: 'called, HTTP 204' });
  assert.deepEqual(resetOutcome({ status: 500, error: null }), { ok: false, text: 'answered HTTP 500' });
  assert.deepEqual(resetOutcome({ status: null, error: 'ECONNREFUSED' }), { ok: false, text: 'failed: ECONNREFUSED' });
});

test('the stop reason reads as a sentence, with its detail after it', () => {
  assert.equal(stopText('user'), 'You stopped the run');
  assert.equal(stopText('cost_budget: projected spend would exceed $5'), 'The run stopped for its cost budget: projected spend would exceed $5');
  assert.equal(stopText('tripwire: The persona tried to open https://acme.com/.'), 'The run was halted by a safety check: The persona tried to open https://acme.com/.');
  assert.equal(stopText('something else'), 'something else');
});

test('a run logged before M2 still reads: its one persona, its budget and its login', () => {
  const logged = { run_id: 'r-0001', persona: { id: 'p-001', name: 'Priya' }, session: { role: 'recruiter' }, cost_budget_usd: 1, project: { role: 'recruiter', goal: 'g' } } as unknown as RunConfig;
  const setup = runSetup(logged);
  assert.deepEqual(setup.personas.map((p) => p.name), ['Priya']);
  assert.equal(setup.costBudget, 1);
  assert.equal(setup.roleOf(setup.personas[0]), 'recruiter');
  assert.deepEqual(setup.segments, []);
  assert.equal(runSetup(undefined).personas.length, 0, 'a run whose row has not arrived yet');
});

test('in a run with an audience each persona logs in as her segment, and a logged-out segment stays logged out', () => {
  const segments = [{ id: 'seg-1', role: 'recruiter' }, { id: 'seg-2', role: null }] as Segment[];
  const config = { personas: [person('a', 'seg-1'), person('b', 'seg-2')], project: { role: 'admin', audience: { segments }, settings: { cost_budget_usd: 5, concurrency: 12 } }, pause_timeout_ms: 1000 } as unknown as RunConfig;
  const setup = runSetup(config);
  assert.deepEqual(setup.personas.map((p) => setup.roleOf(p)), ['recruiter', null]);
  assert.deepEqual([setup.costBudget, setup.concurrency, setup.pauseMs], [5, 12, 1000]);
});

test('steps taken and the latest feeling are counted per persona', () => {
  const step = (seq: number, who: string, step_no: number, feeling: number) =>
    event(seq, 'persona.step', { step_no, action: { type: 'wait', ref: null, text: null }, target: null, result: { ok: true, url_before: '', url_after: '', dom_changed: false, error: null }, thought: '', feeling, snapshot_hash: '', screenshot: null, duration_ms: 1 }, who);
  const progress = personaProgress([step(1, 'a', 1, 0), step(2, 'b', 1, -2), step(3, 'a', 2, 1), event(4, 'run.finished', {}, null)]);
  assert.deepEqual([...progress], [['a', { steps: 2, feeling: 1 }], ['b', { steps: 1, feeling: -2 }]]);
});
