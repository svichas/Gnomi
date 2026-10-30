import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { EventPayloads, EventType, GnomiEvent, Outcome, Persona, ProjectConfig, Report, RunConfig } from '../types.ts';
import { buildReport } from './build.ts';
import { diffReports, RETEST_REACH, type ThemeDiff } from './diff.ts';
import { groupKey, isWeak } from './friction.ts';
import { DIFF_HINT, DIFF_NOTICE, diffText, diffToMarkdown, spreadRows } from './markdown.ts';
import { frictionGroups } from './themes.ts';

// Sides are folded from synthetic events through buildReport, so keys, pages and reach are the real ones, on another host in each run.

const PERSONAS = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5'];
const project: ProjectConfig = {
  name: 'Gym', description: '', goal: 'Post a job', role: null, audience: null, settings: DEFAULT_SETTINGS,
  pois: [{ id: 'web', type: 'web', name: 'Gym', start_url: 'http://localhost:1/', allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null }],
};
const persona = (id: string) => ({ id, name: `Persona ${id}`, job_title: 'Recruiter', segment_id: null, device: 'desktop' }) as unknown as RunConfig['personas'][number];

interface Visit { persona: string; page: string; friction?: string; element?: string }
const visitsTo = (page: string, count: number, friction?: string, element?: string): Visit[] => PERSONAS.slice(0, count).map((id) => ({ persona: id, page, friction, element }));

/** A run where each visit is one persona's step, some with a friction report; the judge answers with one theme per group, named by its first report. */
function run(run_id: string, host: string, visits: Visit[], over: { pois?: ProjectConfig['pois']; group?: RunConfig['repeat']; surveys?: { persona: string; frictions: string[] }[]; traits?: Partial<Persona>; goal?: string } = {}): Report {
  const person = (id: string) => ({ ...persona(id), ...over.traits });
  const config: RunConfig = { run_id, seed: 1, project: { ...project, ...(over.pois && { pois: over.pois }), ...(over.goal && { goal: over.goal }) }, personas: PERSONAS.map(person), sessions: [], reset: false, pause_timeout_ms: 1000, app_version: '0', ...(over.group && { repeat: over.group }) };
  const events: GnomiEvent[] = [];
  const log = <K extends EventType>(type: K, payload: EventPayloads[K], persona_id: string | null = null, poi_id: string | null = null) => events.push({ run_id, round: 1, persona_id, poi_id, type, payload, seq: events.length + 1, ts: events.length + 1 } as GnomiEvent);
  log('run.started', { config });
  for (const id of PERSONAS) log('persona.created', { persona: person(id) }, id);
  visits.forEach((visit, i) => {
    const url = `http://${host}${visit.page}`;
    log('persona.step', { step_no: i + 1, action: { type: 'click', ref: 'e1', text: null }, target: { role: 'button', name: visit.element ?? 'Save', box: null }, result: { ok: true, url_before: url, url_after: url, dom_changed: false, error: null }, thought: 'Trying it.', feeling: 0, snapshot_hash: `h${i}`, screenshot: null, duration_ms: 1, heard_post_ids: [] }, visit.persona, 'web');
    if (visit.friction) log('persona.friction_reported', { step_no: i + 1, severity: 3, what: visit.friction, expected: 'It works', where: { url, ref: 'e1' }, heard_post_ids: [] }, visit.persona, 'web');
  });
  for (const { persona: id, frictions } of over.surveys ?? []) log('persona.survey', { poi_id: 'web', sentiment: 0, confidence: 1, likes: [], frictions, would_continue: true, reason: 'Asked.' }, id, 'web');
  const groups = frictionGroups(events, 'web').filter((group) => !isWeak(group));
  if (groups.length) log('report.themes', { poi_id: 'web', themes: groups.map((group) => ({ title: group.members[0].text, description: 'What happened.', group_ids: [group.id] })), keys: Object.fromEntries(groups.map((group) => [group.id, groupKey(group.members[0])])) });
  log('run.finished', {});
  return buildReport(events);
}

const SAVE = 'Save loses the draft';
const before = (...more: Visit[]) => run('r-1', 'localhost:1111', [...visitsTo('/jobs/new', 3, SAVE), ...more]);
const statuses = (themes: ThemeDiff[]) => themes.map((theme) => [theme.before_title ?? theme.after_title, theme.status]);
const only = (themes: ThemeDiff[]) => { assert.equal(themes.length, 1); return themes[0]; };
const key = (name: string) => JSON.stringify(['web', `gym.test/${name}`, 'element', 'x']);
/** A report whose themes are written by hand, as a judge can merge and name groups any way. */
const themed = (run_id: string, themes: [title: string, keys: string[]][]): Report => {
  const report = before();
  return { ...report, run_id, themes: themes.map(([title, keys], i) => ({ ...report.themes![0], id: `g${i + 1}`, rank: i + 1, title, keys: keys.map(key) })) };
};
/** A theme on many pages of one run, sharing only the Settings element with any other theme built here. */
const wide = (run_id: string, host: string, title: string, others: string[]): Report => {
  const report = run(run_id, host, ['/settings/users', ...others].flatMap((page, i) => visitsTo(page, 3, 'x', i ? 'Other' : 'Settings')));
  return { ...report, themes: [{ ...report.themes![0], title, keys: report.themes!.flatMap((theme) => theme.keys!), pages: report.themes!.flatMap((theme) => theme.pages) }] };
};
const [APPROVAL, BACK_AND_FORTH] = ['Approval checkbox is a double negative', 'Personas went back and forth'];
const [SETTINGS_PAGES, OTHER_PAGES] = [['/settings/approvals', '/settings/a', '/settings/b'], ['/jobs', '/jobs/new', '/candidates']];

test('a theme the later run did not show, on a page enough personas reached, is fixed, and its text never says so', () => {
  const after = run('r-2', 'localhost:2222', visitsTo('/jobs/new', 4));
  const diff = diffReports([before()], [after]);
  const theme = only(diff.themes);
  assert.deepEqual([theme.status, theme.before, theme.after, theme.reached, theme.pages, theme.severity], ['fixed', { seen_in: 1, of: 1 }, { seen_in: 0, of: 1 }, 4, ['/jobs/new'], 3]);
  assert.equal(diffText(theme), 'was in 1 of 1 run, not seen in 1 of 1, 4 personas reached its page.');
  const markdown = diffToMarkdown(diff);
  assert.ok(markdown.includes(DIFF_NOTICE));
  assert.match(markdown, /## Not seen again \(1\)/);
  assert.deepEqual(markdown.match(/.*\bfixed\b.*/gi), [`> ${DIFF_NOTICE}`, DIFF_HINT.fixed], 'the word appears only to say it is not proved');
});

test('a theme the later run showed again is unchanged, keeps both titles when they differ, and counts as seen on both sides', () => {
  const after = run('r-2', 'localhost:2222', visitsTo('/jobs/new', 3, 'The draft vanishes'));
  const theme = only(diffReports([before()], [after]).themes);
  assert.deepEqual([theme.status, theme.before_title, theme.after_title, theme.before.seen_in, theme.after.seen_in, theme.weak], ['unchanged', SAVE, 'The draft vanishes', 1, 1, undefined]);
  assert.match(diffText(theme), /Earlier called "Save loses the draft"/);
});

test('a theme only the later run showed is new', () => {
  const theme = only(diffReports([run('r-1', 'localhost:1111', visitsTo('/jobs/new', 3))], [before()]).themes);
  assert.deepEqual([theme.status, theme.before, theme.after, theme.before_title, theme.after_title], ['new', { seen_in: 0, of: 1 }, { seen_in: 1, of: 1 }, null, SAVE]);
});

test('a page nobody reached in the later run is not retested, however empty of themes that run is', () => {
  const theme = only(diffReports([before()], [run('r-2', 'localhost:2222', visitsTo('/jobs', 5))]).themes);
  assert.deepEqual([theme.status, theme.reached], ['not_retested', 0]);
});

test(`reach below ${RETEST_REACH} personas is not retested, and a persona the model never answered tried nothing`, () => {
  const low = only(diffReports([before()], [run('r-2', 'localhost:2222', visitsTo('/jobs/new', RETEST_REACH - 1))]).themes);
  assert.deepEqual([low.status, low.reached], ['not_retested', RETEST_REACH - 1]);
  assert.match(diffText(low), /2 personas reached its page, and it takes 3 to say anything/);

  const after = run('r-2', 'localhost:2222', visitsTo('/jobs/new', 3));
  const silent: Report = { ...after, personas: after.personas.map((p) => (p.id === 'p-3' ? { ...p, outcome: 'model_failed' as Outcome } : p)) };
  assert.equal(only(diffReports([before()], [silent]).themes).status, 'not_retested');
});

test('a theme on two pages needs one set of personas to have reached both', () => {
  const two = before(...visitsTo('/settings', 3, SAVE));
  assert.deepEqual(two.themes?.map((theme) => theme.pages.length), [1, 1], 'the rules keep one group per page');
  const merged: Report = { ...two, themes: [{ ...two.themes![0], pages: [...two.themes![0].pages, ...two.themes![1].pages], keys: [...two.themes![0].keys!, ...two.themes![1].keys!] }] };
  const apart = run('r-2', 'localhost:2222', [...visitsTo('/jobs/new', 3), ...PERSONAS.slice(2).map((id) => ({ persona: id, page: '/settings' }))]);
  assert.deepEqual([only(diffReports([merged], [apart]).themes).status, only(diffReports([merged], [apart]).themes).reached], ['not_retested', 1], 'three reached each page, but only one reached both');
  const together = run('r-2', 'localhost:2222', [...visitsTo('/jobs/new', 3), ...visitsTo('/settings', 3)]);
  assert.deepEqual([only(diffReports([merged], [together]).themes).status, only(diffReports([merged], [together]).themes).reached], ['fixed', 3]);
  assert.match(diffText(only(diffReports([merged], [together]).themes)), /3 personas reached all its pages/);
});

test('a theme with no pages counts who started its POI and answered a survey there, so a run that asked nobody retests nothing', () => {
  const PRICING = 'Pricing is unclear';
  const steps = PERSONAS.map((id) => ({ persona: id, page: '/' }));
  const first = run('r-1', 'localhost:1111', steps, { surveys: PERSONAS.map((id) => ({ persona: id, frictions: [PRICING] })) });
  assert.deepEqual(first.themes?.map((theme) => [theme.title, theme.pages]), [[PRICING, []]]);
  const later = (answered: string[]) => run('r-2', 'localhost:2222', steps, { surveys: answered.map((id) => ({ persona: id, frictions: [] })) });
  const of = (after: Report) => only(diffReports([first], [after]).themes);

  assert.deepEqual([of(later(PERSONAS.slice(0, 3))).status, of(later(PERSONAS.slice(0, 3))).reached], ['fixed', 3]);
  assert.deepEqual([of(later(PERSONAS.slice(0, 2))).status, of(later(PERSONAS.slice(0, 2))).reached], ['not_retested', 2]);
  assert.match(diffText(of(later(PERSONAS.slice(0, 3)))), /3 personas answered a survey on it/);

  const none = of(later([]));
  assert.deepEqual([none.status, none.reached], ['not_retested', 0], 'a finished run whose surveys all failed');
  assert.match(diffText(none), /0 personas answered a survey on it, and it takes 3 to say anything/);

  const stopped = diffReports([first], [{ ...later([]), run_id: 'r-2', status: 'stopped', stop_reason: 'cost_budget' }]);
  assert.deepEqual([only(stopped.themes).status, only(stopped.themes).reached], ['not_retested', 0], 'a run that stopped before its surveys');
  assert.ok(stopped.notes.some((note) => note.includes('r-2 stopped early (cost_budget)')));
});

test('a pair on one shared key reads as a weak unchanged with both titles, never plain and never fixed', () => {
  const theme = only(diffReports([wide('r-1', 'localhost:1111', APPROVAL, SETTINGS_PAGES)], [wide('r-2', 'localhost:2222', BACK_AND_FORTH, OTHER_PAGES)]).themes);
  assert.deepEqual([theme.status, theme.weak, theme.before_title, theme.after_title], ['unchanged', true, APPROVAL, BACK_AND_FORTH]);
  assert.match(diffText(theme), /"Approval checkbox is a double negative" and "Personas went back and forth" may be different problems/);
});

test('a theme a repeat set grouped on one shared key reads as weak, however strongly it ties to the other side, and names what it was grouped with', () => {
  const a = [wide('a-1', 'localhost:1111', APPROVAL, SETTINGS_PAGES), wide('a-2', 'localhost:1112', BACK_AND_FORTH, OTHER_PAGES)];
  const theme = only(diffReports(a, [wide('b-1', 'localhost:2222', BACK_AND_FORTH, OTHER_PAGES)]).themes);
  assert.deepEqual([theme.status, theme.weak, theme.before_title, theme.after_title, theme.grouped_with, theme.before], ['unchanged', true, BACK_AND_FORTH, BACK_AND_FORTH, [APPROVAL], { seen_in: 2, of: 2 }]);
  assert.match(diffText(theme), /"Approval checkbox is a double negative" and "Personas went back and forth" may be different problems/);
  const later = only(diffReports([wide('b-1', 'localhost:2222', BACK_AND_FORTH, OTHER_PAGES)], a).themes);
  assert.deepEqual([later.weak, later.grouped_with], [true, [APPROVAL]], 'the same on the later side');
});

test('a weak tie shows the two themes that tied, not the first of a set that holds one of them', () => {
  const set = [themed('a-1', [['Job form forgets what was typed', ['a']]]), themed('a-2', [['The job form has two faults', ['a', 'b']]])];
  const theme = only(diffReports(set, [themed('b-1', [[BACK_AND_FORTH, ['b', 'c', 'd', 'e', 'f']]])]).themes);
  assert.deepEqual([theme.weak, theme.before_title, theme.after_title, theme.grouped_with], [true, 'The job form has two faults', BACK_AND_FORTH, undefined]);
});

test('a problem the judge merged in the later run is alive in each part: a leftover of the one-to-one match is not fixed', () => {
  const first = before(...visitsTo('/settings', 3, 'Settings hides the users'));
  assert.equal(first.themes?.length, 2);
  const later = run('r-2', 'localhost:2222', [...visitsTo('/jobs/new', 3, SAVE), ...visitsTo('/settings', 3, SAVE)]);
  const merged: Report = { ...later, themes: [{ ...later.themes![0], keys: later.themes!.flatMap((theme) => theme.keys!), pages: later.themes!.flatMap((theme) => theme.pages), title: 'Forms and settings lose work' }] };
  const { themes } = diffReports([first], [merged]);
  assert.deepEqual(themes.map((theme) => theme.status), ['unchanged', 'unchanged']);
  const split = diffReports([merged], [first]);
  assert.deepEqual(split.themes.map((theme) => theme.status), ['unchanged', 'unchanged'], 'the same the other way round: no part reads as new');
});

test('a similar title alone does not keep a leftover alive, but a key it shares with a taken theme does', () => {
  const [wrong, reviews] = ['Selecting a candidate opens a different candidate profile', 'Candidate links open the wrong candidate review page'];
  const first = run('r-1', 'localhost:1111', [...visitsTo('/candidates', 3, wrong), ...visitsTo('/reviews/1', 3, reviews)]);
  const later = run('r-2', 'localhost:2222', [...visitsTo('/candidates', 5), ...visitsTo('/reviews/1', 3, reviews)]);
  const { themes } = diffReports([first], [later]);
  assert.deepEqual(statuses(themes), [[reviews, 'unchanged'], [wrong, 'fixed']]);
  assert.ok(themes.every((theme) => !theme.weak));
  assert.deepEqual(statuses(diffReports([later], [first]).themes), [[wrong, 'new'], [reviews, 'unchanged']], 'the same the other way round');

  const kept = [[SAVE, ['a', 'b']], [reviews, ['z']]] as [string, string[]][];
  const [theme] = diffReports([themed('r-1', [...kept, [wrong, ['b', 'c', 'd', 'e', 'f', 'g']]])], [themed('r-2', kept)]).themes.filter(({ before_title }) => before_title === wrong);
  assert.deepEqual([theme.status, theme.weak, theme.after_title], ['unchanged', true, SAVE], 'it sounds like one taken theme and shares a key with another');
});

test('a theme set aside on one side is unchanged with the side named, neither fixed nor new', () => {
  const later = run('r-2', 'localhost:2222', visitsTo('/jobs/new', 3, SAVE));
  const moved = { ...later, themes: [], set_aside: later.themes };
  const after = only(diffReports([before()], [moved]).themes);
  assert.deepEqual([after.status, after.set_aside, after.before.seen_in, after.after.seen_in], ['unchanged', 'after', 1, 1]);
  const earlier = only(diffReports([moved], [before()]).themes);
  assert.deepEqual([earlier.status, earlier.set_aside], ['unchanged', 'before']);
  assert.match(diffText(earlier), /set it aside in the earlier run and kept it in the other, so this says nothing either way about a change in the product\./);
  assert.deepEqual(diffReports([moved], [moved]).themes, [], 'set aside on both sides, neither ranks it');
});

test('sets on both sides compare how often each theme appeared, and a set can face a single run', () => {
  const set = (run_id: string, index: number, visits: Visit[]) => run(run_id, `localhost:${index}000`, visits, { group: { group: run_id.slice(0, 1), index, of: 3 } });
  const a = [set('a-1', 1, visitsTo('/jobs/new', 3, SAVE)), set('a-2', 2, visitsTo('/jobs/new', 3, SAVE)), set('a-3', 3, visitsTo('/jobs/new', 3))];
  const b = [set('b-1', 1, visitsTo('/jobs/new', 3, SAVE)), set('b-2', 2, visitsTo('/jobs/new', 4)), set('b-3', 3, visitsTo('/jobs/new', 2))];
  const theme = only(diffReports(a, b).themes);
  assert.deepEqual([theme.status, theme.before, theme.after], ['unchanged', { seen_in: 2, of: 3 }, { seen_in: 1, of: 3 }]);

  const gone = [set('c-1', 1, visitsTo('/jobs/new', 2)), set('c-2', 2, visitsTo('/jobs/new', 5)), set('c-3', 3, visitsTo('/jobs/new', 1))];
  const cleared = only(diffReports(a, gone).themes);
  assert.deepEqual([cleared.status, cleared.reached], ['fixed', 5], 'one later run reaching the page is enough, and the most it reached is what shows');
  assert.equal(diffText(cleared), 'was in 2 of 3 runs, not seen in 3 of 3, 5 personas reached its page.');

  const single = only(diffReports(a, [run('r-9', 'localhost:9999', visitsTo('/jobs/new', 4))]).themes);
  assert.deepEqual([single.status, single.before, single.after], ['fixed', { seen_in: 2, of: 3 }, { seen_in: 0, of: 1 }]);
});

test('a problem is found by any run of a set, not only by the run that started its cluster', () => {
  const first = themed('b-1', [['Job form forgets what was typed', ['a']]]);
  const second = themed('b-2', [['The job form has two faults', ['a', 'b']]]);
  const found = only(diffReports([themed('a-1', [['Save loses the draft', ['b']]])], [first, second]).themes);
  assert.deepEqual([found.status, found.after.seen_in, found.after_title], ['unchanged', 2, 'Job form forgets what was typed'], 'the later set clusters the two, and only its second run meets the earlier theme');
});

test('a POI the later side does not have is not retested, and the notes say why', () => {
  const other: ProjectConfig['pois'] = [{ ...project.pois[0], id: 'web-2', name: 'Admin' } as ProjectConfig['pois'][number]];
  const after = run('r-2', 'localhost:2222', [], { pois: other });
  const diff = diffReports([before()], [after]);
  assert.deepEqual(only(diff.themes).status, 'not_retested');
  assert.ok(diff.notes.some((note) => note.includes('did not try Gym')), diff.notes.join(' | '));
  assert.ok(diff.notes.some((note) => note.includes('earlier run did not try Admin')), diff.notes.join(' | '));
});

test('a report with no reach gives not retested with a note, and another later run can still give it', () => {
  const { reach: _, ...saved } = run('r-2', 'localhost:2222', visitsTo('/jobs/new', 4));
  const diff = diffReports([before()], [saved]);
  assert.deepEqual([only(diff.themes).status, only(diff.themes).reached], ['not_retested', null]);
  assert.ok(diff.notes.some((note) => note.includes('does not say which pages')));
  assert.match(diffText(only(diff.themes)), /the later report does not say who got there\./);
  assert.equal(only(diffReports([before()], [saved, run('r-3', 'localhost:3333', visitsTo('/jobs/new', 4))]).themes).status, 'fixed');
});

test('a run read through buildReport has reach whatever its age, per POI and without a persona who only had a friction elsewhere', () => {
  const report = run('r-2', 'localhost:2222', [...visitsTo('/jobs/new', 2), ...visitsTo('/jobs', 1, 'x')]);
  assert.deepEqual(report.reach, [{ poi_id: 'web', started: ['p-1', 'p-2'], surveyed: [], pages: { 'localhost:2222/jobs/new': ['p-1', 'p-2'], 'localhost:2222/jobs': ['p-1'] } }]);
});

test('the notes name what weakens a comparison: a model, a moved alias, the audience, a stopped run, an unfinished set', () => {
  const after = before();
  const quiet = diffReports([before()], [after]);
  assert.deepEqual(quiet.notes, [], 'the same conditions say nothing');
  const models = (navigator: string, response?: string): Report['methods'] => ({ ...after.methods, models: { navigator: { provider: 'anthropic', model: navigator } }, ...(response ? { response_models: { navigator: [response] } } : {}) });
  const route = diffReports([{ ...before(), methods: models('claude-a') }], [{ ...after, methods: models('claude-b') }]);
  assert.ok(route.notes.some((note) => note.includes('navigator ran on anthropic:claude-a in the earlier run and anthropic:claude-b')), route.notes.join(' | '));
  const alias = diffReports([{ ...before(), methods: models('claude-a', 'claude-a-1') }], [{ ...after, methods: models('claude-a', 'claude-a-2') }]);
  assert.ok(alias.notes.some((note) => note.includes('answered as claude-a-1 in the earlier run and claude-a-2')), alias.notes.join(' | '));
  const crowd = diffReports([before()], [{ ...after, personas: after.personas.slice(1) }]);
  assert.ok(crowd.notes.some((note) => note.includes('different personas')));
  const stopped = diffReports([before()], [{ ...after, run_id: 'r-2', status: 'stopped', stop_reason: 'budget' }]);
  assert.ok(stopped.notes.some((note) => note.includes('r-2 stopped early (budget)')));
  const short = diffReports([before()], [{ ...after, repeat: { group: 'g', index: 1, of: 3 } }]);
  assert.ok(short.notes.some((note) => note.includes('Only 1 of the 3 runs of the later set')));
});

test('what a persona is counts, not its label, and a different goal is its own gap', () => {
  const later = (over: Parameters<typeof run>[3]) => diffReports([before()], [run('r-2', 'localhost:2222', visitsTo('/jobs/new', 3, SAVE), over)]);
  assert.deepEqual(later({}).gaps, [], 'one fold of the same personas gives the same fingerprint');
  const rewritten = later({ traits: { background: 'Someone else entirely.', tech_skill: 1, patience: 5 } });
  assert.deepEqual(rewritten.gaps.map(({ kind }) => kind), ['personas']);
  assert.ok(rewritten.notes.some((note) => note.includes('different personas')), 'compare prints it too');
  const goal = later({ goal: 'Cancel a job' });
  assert.deepEqual(goal.gaps.map(({ kind }) => kind), ['goal']);
  assert.ok(goal.notes.some((note) => note.includes('different goals')));
});

test('a report saved before the fingerprint falls back on its labels', () => {
  const { personas_fingerprint: _, ...old } = before();
  const rewritten = run('r-2', 'localhost:2222', visitsTo('/jobs/new', 3, SAVE), { traits: { background: 'Someone else entirely.' } });
  assert.deepEqual(diffReports([old], [rewritten]).gaps, []);
  assert.deepEqual(diffReports([old], [{ ...rewritten, personas: rewritten.personas.slice(1) }]).gaps.map(({ kind }) => kind), ['personas']);
});

test('competitor POIs stay out of the themes, the POI list and the spread', () => {
  const report = before();
  const pois = [...report.pois, { id: 'rival', type: 'web' as const, name: 'Rival', start_url: 'http://rival.test/', competitor: true as const }];
  const rival = { ...report.themes![0], poi_id: 'rival', title: 'Rival checkout is slow', id: 'g9' };
  const diff = diffReports([{ ...report, pois, themes: [...report.themes!, rival] }], [{ ...report, pois, themes: report.themes }]);
  assert.deepEqual(statuses(diff.themes), [[SAVE, 'unchanged']]);
  assert.deepEqual(diff.pois, [{ id: 'web', name: 'Gym' }]);

  const observed = before();
  const watched = { ...observed, pois: [{ ...observed.pois[0], competitor: true as const }], themes: [] };
  assert.equal(only(diffReports([before()], [watched]).themes).status, 'not_retested', 'a POI only observed later is no retest of it');
});

test('segments change in sentiment and friction, spread changes only where both sides have it, and a set counts by its mean', () => {
  const report = before();
  const id = report.segments[0].id;
  const side = (sentiment: number, with_friction: number, spread?: Partial<NonNullable<Report['spread']>[number]>): Report => ({
    ...report,
    sentiment: [{ segment_id: id, name: 'Built-in', surveyed: 2, sentiment, would_continue: 1 }],
    segments: report.segments.map((segment) => ({ ...segment, with_friction })),
    ...(spread ? { spread: [{ poi_id: 'web', name: 'Gym', posts: 2, seeds: [], first_hand: [], second_hand: [], segments: [], influence: [], sentiment: [], themes: [], ...spread }] } : {}),
  });
  const [segment] = diffReports([side(-1, 0.75)], [side(0, 0.25), side(1, 0.25)]).segments;
  assert.deepEqual([segment.sentiment, segment.with_friction], [{ before: -1, after: 0.5, delta: 1.5 }, { before: 0.75, after: 0.25, delta: -0.5 }]);

  assert.deepEqual(diffReports([side(0, 0, {})], [side(0, 0)]).spread, [], 'one side has no spread');
  const [spread] = diffReports(
    [side(0, 0, { posts: 2, second_hand: ['a'], readers: ['a', 'b'], sentiment: [{ round: 1, mean: -1, personas: 2 }, { round: 2, mean: null, personas: 0 }], segments: [{ segment_id: id, name: 'Built-in', personas: 2, seed: true }] })],
    [side(0, 0, { posts: 6, second_hand: [], readers: ['a'], sentiment: [{ round: 1, mean: 1, personas: 2 }], segments: [] })],
  ).spread;
  assert.deepEqual([spread.posts.delta, spread.second_hand.delta, spread.readers.delta, spread.sentiment], [4, -1, -1, { before: -1, after: 1, delta: 2 }]);
  assert.deepEqual(spread.segments, [{ segment_id: id, name: 'Built-in', readers: { before: 2, after: 0, delta: -2 } }]);
  assert.deepEqual(spreadRows(spread)[1], { name: 'Gym: Built-in', cells: ['-', '-', '2 → 0 (-2)', '-'] }, 'under its product, with only what a segment has');
  assert.match(diffToMarkdown({ ...diffReports([before()], [before()]), spread: [spread] }), /\| Gym \| 2 → 6 \(\+4\) \|.*\n\| Gym: Built-in \| - \| - \| 2 → 0 \(-2\) \| - \|/);
  assert.match(diffToMarkdown(diffReports([side(-1, 0.75, {})], [side(1, 0.25, { posts: 6 })])), /Built-in.*-1\.00 → 1\.00 \(\+2\.00\).*75% → 25% \(-50 points\)[\s\S]*Gym \| 2 → 6 \(\+4\) \|/);
});

test('free text in a comparison cannot write Markdown', () => {
  const diff = diffReports([before()], [run('r-2', 'localhost:2222', visitsTo('/jobs/new', 3, '[click](http://x) <img src=x>'))]);
  assert.doesNotMatch(diffToMarkdown(diff), /<img|(?<!\\)\]\(http/);
});
