import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventPayloads, EventType, GnomiEvent, Persona, RunConfig, Segment } from '@gnomi/engine/types.ts';
import { countStates, filterEvents, merge, personaProgress, personaStates, resetOutcome, runSetup, stopText, toRows, waitingBlocks } from './activity.ts';

function event<K extends EventType>(seq: number, type: K, payload: EventPayloads[K], persona_id: string | null = 'p-001'): GnomiEvent {
  return { seq, ts: seq, run_id: 'r-0001', round: 1, persona_id, poi_id: 'poi-1', type, payload } as GnomiEvent;
}
const blockedRequest = (seq: number, host: string, path: string) => event(seq, 'containment.blocked_request', { host, url: `http://${host}${path}`, method: 'GET' });
const blocked = (seq: number, reason: 'captcha' | 'session_expired' = 'captcha', who = 'p-001') => event(seq, 'persona.blocked', { step_no: 2, reason, detail: 'recaptcha' }, who);
const resumed = (seq: number, who = 'p-001') => event(seq, 'persona.resumed', { step_no: 2 }, who);

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
