import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { EventPayloads, EventType, GnomiEvent, Opinion, ProjectConfig, RunConfig, WebPoi } from '../types.ts';
import { buildReport } from './build.ts';
import { groupKey, type Candidate } from './friction.ts';
import { PRIOR_FRICTIONS, PRIOR_LIKES, PRIOR_OPINION_ITEMS, PRIOR_PAGES, PRIOR_TEXT, priorOf, priorVisit } from './prior.ts';
import { hostless } from './themes.ts';

// Folded from synthetic logs through the real report, so "first-hand" means what it means in a report.

const web = (id: string, over: Partial<WebPoi> = {}): WebPoi => ({ id, type: 'web', name: id, start_url: 'http://gym.test/', allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null, ...over });
const project: ProjectConfig = { name: 'Gym', description: '', goal: 'Post a job', role: null, audience: null, settings: DEFAULT_SETTINGS, pois: [web('app')] };
const person = (id: string) => ({ id, name: `Persona ${id}`, job_title: 'Recruiter', segment_id: null, device: 'desktop', background: 'Hires people.' }) as unknown as RunConfig['personas'][number];
const JOBS = 'http://gym.test/jobs/new';
const OPINION: Opinion = { sentiment: -1, confidence: 0.5, likes: ['Clear menu'], frictions: ['Save does nothing'] };

type Entry = [type: EventType, persona_id: string | null, payload: object, poi_id?: string];

function logOf(entries: Entry[], over: Partial<RunConfig> = {}, personas = ['a', 'b']): GnomiEvent[] {
  const config: RunConfig = { run_id: 'r-1', seed: 1, project, personas: personas.map(person), sessions: [], reset: false, pause_timeout_ms: 0, app_version: '0', ...over };
  const all: Entry[] = [['run.started', null, { config }], ...personas.map((id): Entry => ['persona.created', id, { persona: person(id) }]), ...entries, ['run.finished', null, {}]];
  return all.map(([type, persona_id, payload, poi_id], i) => ({ run_id: config.run_id, round: 1, persona_id, poi_id: poi_id ?? (persona_id ? 'app' : null), type, payload, seq: i + 1, ts: i }) as GnomiEvent);
}
const step = (step_no: number, url = JOBS, heard_post_ids: string[] = []): EventPayloads['persona.step'] => ({
  step_no, action: { type: 'click', ref: 'e1', text: null }, target: { role: 'button', name: 'Save', box: null }, result: { ok: true, url_before: url, url_after: url, dom_changed: true, error: null },
  thought: 'Trying it.', feeling: 0, snapshot_hash: 'h', screenshot: null, duration_ms: 1, heard_post_ids,
});
const friction = (step_no: number, what: string, severity = 2, url = JOBS, heard_post_ids: string[] = []): EventPayloads['persona.friction_reported'] => ({ step_no, severity, what, expected: 'It works', where: { url, ref: 'e1' }, heard_post_ids });
const survey = (over: Partial<EventPayloads['persona.survey']> = {}): EventPayloads['persona.survey'] => ({ poi_id: 'app', sentiment: -1, confidence: 0.5, likes: [], frictions: [], would_continue: false, reason: 'It lost my draft.', ...over });
const changed = (after: Opinion, post_ids: string[] = []): EventPayloads['persona.opinion_changed'] => ({ poi_id: 'app', before: null, after, cause: { step_ids: post_ids.length ? [] : [1], post_ids } });
const ended = (step_no: number): Entry[] => [['persona.step', 'a', step(step_no)], ['persona.goal_done', 'a', { step_no, summary: 'Saved it.' }]];

test('a memory holds the outcome, pages, first-hand complaints, survey answers and last opinion, and nothing of anyone else', () => {
  const events = logOf([
    ['persona.step', 'a', step(1)],
    ['persona.friction_reported', 'a', friction(1, 'Save does nothing', 3)],
    ['persona.step', 'b', step(1, 'http://gym.test/secret')],
    ['persona.friction_reported', 'b', friction(1, "Bo's own complaint", 4, 'http://gym.test/secret')],
    ['persona.survey', 'b', survey({ reason: "Bo's reason" })],
    ['persona.opinion_changed', 'a', changed({ ...OPINION, sentiment: 1 })],
    ['persona.opinion_changed', 'a', changed(OPINION)],
    ...ended(2),
    ['persona.survey', 'a', survey({ likes: ['Clear menu'], items: [{ kind: 'friction', where: 'Jobs', what: 'Jobs is hard to find', severity: 1 }, { kind: 'like', where: 'Menu', what: 'Clear menu', severity: null }], frictions: ['Jobs is hard to find'] })],
  ]);
  const visit = priorVisit(events, 'a')!;
  const [memory] = Object.values(visit.pois);
  assert.deepEqual(Object.keys(visit.pois), ['app']);
  assert.equal(memory.outcome, 'done');
  assert.deepEqual(memory.pages, ['/jobs/new'], 'without the host, which a new build may change');
  assert.deepEqual(memory.frictions.map(({ what }) => what), ['Save does nothing', 'Jobs is hard to find'], 'a complaint and a survey answer, worst first');
  assert.deepEqual(memory.survey, { sentiment: -1, would_continue: false, reason: 'It lost my draft.', likes: ['Clear menu'] });
  assert.deepEqual(memory.opinion, OPINION, 'the last one');
  assert.doesNotMatch(JSON.stringify(visit), /Bo's|secret/);
  assert.equal(memory.frictions[0].key, hostless(JSON.stringify(['app', 'gym.test/jobs/new', 'element', 'button "save"'])), 'its key reads the same on another host');
});

test('a key is the one the report groups by, so a persona who says it twice keeps it once, worded at its worst', () => {
  const events = logOf([
    ['persona.step', 'a', step(1)],
    ['persona.friction_reported', 'a', friction(1, 'Slightly odd', 1)],
    ['persona.step', 'a', step(2)],
    ['persona.friction_reported', 'a', friction(2, 'Save lost my work', 4)],
  ]);
  const { frictions } = priorVisit(events, 'a')!.pois.app;
  assert.deepEqual(frictions.map(({ what }) => what), ['Save lost my work']);
  assert.equal(frictions[0].key, hostless(groupKey({ poi_id: 'app', page: 'gym.test/jobs/new', kind: 'friction', element: 'button "Save"' } as Candidate)));
});

test('named limits keep a long run short', () => {
  const long = 'x'.repeat(5_000);
  const pages = Array.from({ length: PRIOR_PAGES + 5 }, (_, i) => `http://gym.test/page-${i}a`);
  const opinion = { ...OPINION, likes: [long, 'b', 'c', 'd', 'e'], frictions: [long, 'b', 'c', 'd', 'e'] };
  const events = logOf([
    ...pages.flatMap((url, i): Entry[] => [
      ['persona.step', 'a', { ...step(i + 1, url), target: { role: 'button', name: `Button ${i}`, box: null } }],
      ['persona.friction_reported', 'a', friction(i + 1, long, 2, url)],
    ]),
    ['persona.opinion_changed', 'a', changed(opinion)],
    ['persona.survey', 'a', survey({ reason: long, likes: [long, 'b', 'c', 'd', 'e'] })],
  ]);
  const memory = priorVisit(events, 'a')!.pois.app;
  assert.equal(memory.pages.length, PRIOR_PAGES);
  assert.equal(memory.frictions.length, PRIOR_FRICTIONS);
  assert.equal(memory.survey?.likes.length, PRIOR_LIKES);
  assert.equal(memory.opinion?.likes.length, PRIOR_OPINION_ITEMS);
  assert.equal(memory.opinion?.frictions.length, PRIOR_OPINION_ITEMS);
  const texts = [...memory.frictions.map(({ what }) => what), memory.survey!.reason, ...memory.survey!.likes, ...memory.opinion!.likes];
  assert.ok(texts.every((text) => text.length <= PRIOR_TEXT), 'no text past its limit');
  assert.ok(JSON.stringify(memory).length < 6_000, `a long run, a short memory: ${JSON.stringify(memory).length}`);
});

test('what came from another persona stays out: a repeated post, and an opinion that cites one', () => {
  const events = logOf([
    ['persona.step', 'b', step(1)],
    ['persona.friction_reported', 'b', friction(1, 'Save does nothing')],
    ['social.post', 'b', { post_id: 'p1', parent_id: null, text: 'Save does nothing!', about_poi_id: 'app' }],
    ['persona.opinion_changed', 'a', changed(OPINION)],
    ['persona.step', 'a', step(2, JOBS, ['p1'])],
    ['persona.friction_reported', 'a', friction(2, 'I hear Save does nothing', 2, JOBS, ['p1'])],
    ['persona.opinion_changed', 'a', changed({ ...OPINION, frictions: ['Bo says Save does nothing'] }, ['p1'])],
    ['persona.survey', 'a', survey()],
  ]);
  const memory = priorVisit(events, 'a')!.pois.app;
  assert.deepEqual(memory.frictions, []);
  assert.deepEqual(memory.opinion, OPINION, 'the last opinion it came to itself');
  assert.doesNotMatch(JSON.stringify(memory), /Bo says|I hear/);
});

test('an opinion changed at a step handed another persona\'s post is not its own, and nor is any after it, which inherits that text', () => {
  const atStep = (after: Opinion, seq: number): EventPayloads['persona.opinion_changed'] => ({ poi_id: 'app', before: null, after, cause: { step_ids: [seq], post_ids: [] } });
  const heardFirst = (seed: Entry[]) => logOf([
    ['social.post', 'b', { post_id: 'p1', parent_id: null, text: 'Save does nothing!', about_poi_id: 'app' }],
    ...seed,
    ['persona.step', 'a', step(1, JOBS, ['p1'])], // seq 4 + seed.length + 1
    ['persona.opinion_changed', 'a', atStep({ ...OPINION, frictions: ['Bo says Save does nothing'] }, 5 + seed.length)],
    ['persona.step', 'a', step(2)],
    ['persona.opinion_changed', 'a', atStep({ ...OPINION, sentiment: 1, frictions: ['Bo says Save does nothing', 'Also slow'] }, 7 + seed.length)],
  ]);
  assert.deepEqual(priorVisit(heardFirst([['persona.opinion_changed', 'a', changed(OPINION)]]), 'a')!.pois.app.opinion, OPINION, 'the last one before the first heard change, though a later event cites no heard step');
  assert.equal(priorVisit(heardFirst([]), 'a')!.pois.app.opinion, null, 'it held none of its own');

  const mine = logOf([
    ['social.post', 'a', { post_id: 'p2', parent_id: null, text: 'Save does nothing!', about_poi_id: 'app' }],
    ['persona.step', 'a', step(1, JOBS, ['p2'])],
    ['persona.opinion_changed', 'a', atStep(OPINION, 5)],
  ]);
  assert.deepEqual(priorVisit(mine, 'a')!.pois.app.opinion, OPINION, 'its own post is its own words');
});

test('each report is judged alone: a heard one neither gets in beside an own one nor gives the wording, even with a browser signal behind it', () => {
  const post: Entry = ['social.post', 'b', { post_id: 'p1', parent_id: null, text: 'Save lost my draft', about_poi_id: 'app' }];
  const events = logOf([
    post,
    ['persona.step', 'a', step(1)],
    ['persona.friction_reported', 'a', friction(1, 'Save is a bit slow', 2)],
    ['persona.step', 'a', step(2, JOBS, ['p1'])],
    ['persona.friction_reported', 'a', friction(2, 'Bo says Save lost a draft', 4, JOBS, ['p1'])],
  ]);
  assert.deepEqual(priorVisit(events, 'a')!.pois.app.frictions.map(({ what }) => what), ['Save is a bit slow']);

  const failed = { step_no: 1, url: JOBS, ref: 'e1', action: 'click', error: 'no_effect' };
  const backed = logOf([post, ['persona.step', 'a', step(1, JOBS, ['p1'])], ['persona.friction_reported', 'a', friction(1, 'Bo says Save lost a draft', 4, JOBS, ['p1'])], ['signal.failed_action', 'a', failed]]);
  assert.deepEqual(buildReport(backed).themes![0].first_hand, ['a'], 'the browser shows it met this');
  assert.deepEqual(priorVisit(backed, 'a')!.pois.app.frictions, [], 'but the words were written with the post in the prompt');

  const later = logOf([post, ['persona.step', 'a', step(1)], ['persona.friction_reported', 'a', friction(1, 'Bo says Save lost a draft', 4, JOBS, ['p1'])]]);
  assert.deepEqual(priorVisit(later, 'a')!.pois.app.frictions, [], "a report's own heard posts count when its step's do not, as a design's friction on an earlier frame");
});

test('a theme reaches one item of a survey, not every item of it, though all of them share a seq', () => {
  const items = [{ kind: 'friction' as const, where: 'Pricing', what: 'I hear pricing is hidden', severity: 3 }, { kind: 'friction' as const, where: 'Jobs', what: 'Jobs is hard to find', severity: 2 }];
  const events = logOf([
    ['social.post', 'b', { post_id: 'p1', parent_id: null, text: 'Pricing is hidden', about_poi_id: 'app' }],
    ['social.feed_viewed', 'a', { post_ids: ['p1'] }],
    ['persona.step', 'a', step(1)],
    ['persona.survey', 'a', survey({ items, frictions: items.map(({ what }) => what) })],
    ['report.themes', null, { poi_id: 'app', themes: [{ title: 'Pricing', description: 'd', group_ids: ['g1'] }, { title: 'Jobs', description: 'd', group_ids: ['g2'] }], posts: [{ post_id: 'p1', group_ids: ['g1'] }] }],
  ]);
  assert.deepEqual(buildReport(events).themes!.map(({ title, echoed }) => [title, echoed?.length ?? 0]).sort(), [['Jobs', 0], ['Pricing', 1]]);
  assert.deepEqual(priorVisit(events, 'a')!.pois.app.frictions.map(({ what }) => what), ['Jobs is hard to find']);
});

test('a persona the run never reached, that the model never answered, or that was not in it has no memory', () => {
  const events = logOf([
    ['persona.step', 'a', step(1)],
    ['persona.friction_reported', 'a', friction(1, 'Save does nothing')],
    ['persona.step', 'b', { ...step(1), result: { ...step(1).result, ok: false, error: 'invalid_output' } }],
    ['signal.repeated_failure', 'b', { step_no: 1, action: 'wait', error: 'invalid_output' }],
  ], {}, ['a', 'b', 'c']);
  assert.ok(priorVisit(events, 'a'));
  assert.equal(priorVisit(events, 'b'), null, 'model_failed');
  assert.equal(priorVisit(events, 'c'), null, 'not_started');
  assert.equal(priorVisit(events, 'ghost'), null);
  const { run_id, memories } = priorOf(events);
  assert.deepEqual([run_id, Object.keys(memories)], ['r-1', ['a']]);
});

test('each of the team\'s POIs is remembered on its own, and a competitor\'s not at all', () => {
  const pois = [web('app'), web('docs'), web('rival', { mode: 'observe_only' })];
  const events = logOf([
    ['persona.step', 'a', step(1), 'app'],
    ['persona.friction_reported', 'a', friction(1, 'Save does nothing'), 'app'],
    ['persona.goal_done', 'a', { step_no: 1, summary: 'Done.' }, 'app'],
    ['persona.step', 'a', step(2, 'http://gym.test/help'), 'docs'],
    ['persona.abandoned', 'a', { step_no: 2, reason: 'No search box' }, 'docs'],
    ['persona.step', 'a', step(3, 'http://gym.test/rival'), 'rival'],
    ['persona.friction_reported', 'a', friction(3, 'Rival is slow', 2, 'http://gym.test/rival'), 'rival'],
    ['persona.goal_done', 'a', { step_no: 3, summary: 'Done.' }, 'rival'],
  ], { project: { ...project, pois } }, ['a']);
  const { pois: visited } = priorVisit(events, 'a')!;
  assert.deepEqual(Object.keys(visited), ['app', 'docs']);
  assert.deepEqual([visited.app.outcome, visited.docs.outcome], ['done', 'abandoned']);
  assert.deepEqual([visited.app.pages, visited.docs.pages], [['/jobs/new'], ['/help']]);
  assert.deepEqual(visited.docs.frictions.map(({ what }) => what), ['No search box'], 'giving up says why, in its own words');
});

test('memory is one visit deep: it holds all of the latest visit, the persona\'s own repeats too, and nothing it did not say again', () => {
  const seeded = (prior: RunConfig['prior']): Entry[] => [['persona.opinion_changed', 'a', { poi_id: 'app', before: null, after: prior!.memories.a.pois.app.opinion!, cause: { step_ids: [], post_ids: [] } }]];
  const visit = (what: string, reason: string): Entry[] => [['persona.step', 'a', step(1)], ['persona.friction_reported', 'a', friction(1, what)], ['persona.survey', 'a', survey({ reason })]];
  const first = priorOf(logOf([['persona.step', 'a', step(1)], ['persona.friction_reported', 'a', friction(1, 'Save does nothing')], ['persona.opinion_changed', 'a', changed(OPINION)], ['persona.survey', 'a', survey({ reason: 'First visit.' })]]));
  const second = logOf([...seeded(first), ...visit('Save still does nothing', 'Second visit.')], { run_id: 'r-2', prior: first });
  const { run_id, memories } = priorOf(second);
  assert.equal(run_id, 'r-2');
  const memory = memories.a.pois.app;
  assert.deepEqual(memory.frictions, [{ key: first.memories.a.pois.app.frictions[0].key, what: 'Save still does nothing' }], 'a repeat of its own is still its own');
  assert.equal(memory.survey?.reason, 'Second visit.');
  assert.deepEqual(memory.opinion, OPINION, 'the opinion it left the latest visit with');
  assert.doesNotMatch(JSON.stringify(memories), /First visit/);

  const third = buildReport(logOf([...seeded(priorOf(second)), ...visit('Save still does nothing', 'Third visit.')], { run_id: 'r-3', prior: priorOf(second) })).themes![0];
  assert.deepEqual([third.first_hand, third.remembered], [[], 1], 'a chain of runs never reads an old complaint as new');

  const moved = logOf([...seeded(first), ['persona.step', 'a', { ...step(1), target: { role: 'button', name: 'Publish', box: null } }], ['persona.friction_reported', 'a', friction(1, 'Publish is greyed out')]], { run_id: 'r-2', prior: first });
  assert.deepEqual(priorOf(moved).memories.a.pois.app.frictions.map(({ what }) => what), ['Publish is greyed out'], 'what it did not say again is gone');
});
