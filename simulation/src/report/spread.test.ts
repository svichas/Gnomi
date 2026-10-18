import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE } from '../llm/scripted.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import type { Recorder, Responder } from '../seams.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { EventPayloads, GnomiEvent, LlmRole, Persona, RunConfig, Segment } from '../types.ts';
import { buildReport } from './build.ts';
import { reportToMarkdown } from './markdown.ts';
import { JUDGE_POSTS, JUDGE_SYSTEM, runReportModels } from './models.ts';
import { homogeneity } from './spread.ts';
import { frictionGroups, judgeGroups, judgeInput, type Post } from './themes.ts';

const JOBS = 'http://gym.test/jobs/new';
const HOME = 'http://gym.test/';

const segment = (id: string, name: string, share: number): Segment => ({
  id, name, description: name, share, role: null, usage_frequency: 'weekly', typical_goals: [], mobile_share: 0,
  patience: [2, 4], tech_skill: [2, 4], account_state: 'empty', entry: 'direct', goal_override: null,
});
const person = (id: string, segment_id: string, name: string, background = `${name} hires engineers.`): Persona => ({ ...BUILTIN_PERSONA, id, segment_id, name, background });
const POPULATION = [person('a1', 'rec', 'Ana'), person('a2', 'rec', 'Abe'), person('a3', 'rec', 'Ari'), person('b1', 'hm', 'Bo'), person('b2', 'hm', 'Bea')];

const config: RunConfig = {
  run_id: 'r-1',
  seed: 1,
  project: {
    name: 'Gym', description: 'A demo ATS.', goal: 'Post a job', role: null, settings: DEFAULT_SETTINGS,
    audience: {
      seed: 1, persona_count: 5, segments: [segment('rec', 'Recruiters', 60), segment('hm', 'Hiring managers', 40)], company_size: [50, 500],
      languages: { en: 1 }, accessibility: { none: 1, low_vision: 0, colour_blind: 0, screen_reader: 0, motor: 0 },
    },
    pois: [{ id: 'poi', type: 'web', name: 'Gym', start_url: HOME, allowed_hosts: [], production_domains: [], not_production: true, reset_hook_url: null, mode: 'full', segments: null }],
  },
  personas: POPULATION,
  sessions: [],
  reset: false,
  pause_timeout_ms: 0,
  app_version: '0.0.0',
};

const at = (round: number, persona_id: string | null) => ({ run_id: 'r-1', round, persona_id, poi_id: 'poi' });
const friction = (what: string, url: string): EventPayloads['persona.friction_reported'] => ({ step_no: 1, severity: 3, what, expected: 'It works.', where: { url, ref: null }, heard_post_ids: [] });
const post = (post_id: string, text: string, about_poi_id: string | null = 'poi', injected = false): EventPayloads['social.post'] => ({
  post_id, parent_id: null, text, about_poi_id, ...(injected ? { injected } : {}),
});
const view = (sentiment: number) => ({ sentiment, confidence: 0.5, likes: [], frictions: [] });
const changed = (before: number | null, after: number, post_ids: string[] = []): EventPayloads['persona.opinion_changed'] => ({
  poi_id: 'poi', before: before === null ? null : view(before), after: view(after), cause: { step_ids: [], post_ids },
});

function recorder() {
  const events: GnomiEvent[] = [];
  const record: Recorder = (event) => {
    const stored = { ...event, seq: events.length + 1, ts: events.length } as GnomiEvent;
    events.push(stored);
    return stored;
  };
  return { events, record };
}

/**
 * Round 1: Ana (recruiter) and Bo (hiring manager) each hit a friction; Ana posts about hers. Round 2: Abe (recruiter) and
 * Bea (hiring manager) cite Ana's post, change their minds and post; Bo posts about his own; Ari posts about lunch. Round 3:
 * Ana's opinion drops again.
 */
function socialRun(social = true) {
  const { events, record } = recorder();
  const say = (round: number, persona_id: string, payload: EventPayloads['social.post']) => social && record({ ...at(round, persona_id), type: 'social.post', payload });
  record({ ...at(1, null), poi_id: null, type: 'run.started', payload: { config } });
  for (const p of POPULATION) record({ ...at(1, p.id), type: 'persona.created', payload: { persona: p } });
  record({ ...at(1, 'a1'), type: 'persona.friction_reported', payload: friction('Save does nothing', JOBS) });
  record({ ...at(1, 'b1'), type: 'persona.friction_reported', payload: friction('Home is empty', HOME) });
  record({ ...at(1, 'a1'), type: 'persona.opinion_changed', payload: changed(null, -1) });
  say(1, 'a1', post('s1', 'Saving a job does nothing at all.'));
  say(2, 'a2', post('s2', 'Heard the Save button is broken, avoiding it.'));
  record({ ...at(2, 'a2'), type: 'persona.opinion_changed', payload: changed(null, -1, ['s1']) });
  record({ ...at(2, 'b2'), type: 'persona.opinion_changed', payload: changed(1, -1, ['s1']) });
  say(2, 'b2', post('s3', 'Is Save broken for everyone?'));
  say(2, 'b1', post('s4', 'The home page shows nothing useful, and Save looks broken too.'));
  say(2, 'a3', post('s5', 'Lunch was nice today.', null));
  record({ ...at(3, 'a1'), type: 'persona.opinion_changed', payload: changed(-1, -2) });
  return { events, record };
}

// The judge merges nothing, tags three posts with g1 and Bo's with both groups, and names ids it was never given.
const judged: EventPayloads['report.themes'] = {
  poi_id: 'poi',
  themes: [{ title: 'Saving a job fails', description: 'Save does nothing.', group_ids: ['g1'] }],
  posts: [
    { post_id: 's1', group_ids: ['g1'] },
    { post_id: 's2', group_ids: ['g1', 'g9'] },
    { post_id: 's3', group_ids: ['g1'] },
    { post_id: 'nope', group_ids: ['g1'] },
    { post_id: 's5', group_ids: ['g1'] }, // not about the POI, so the judge was never shown it
    { post_id: 's4', group_ids: ['g2', 'g1'] },
  ],
};

function tagged() {
  const { events, record } = socialRun();
  record({ ...at(3, null), type: 'report.themes', payload: judged });
  return buildReport(events);
}

test('tags keep known posts and group ids only; the rest is dropped and named in the limitations', () => {
  const report = tagged();
  assert.deepEqual(report.spread?.[0].themes.map((t) => [t.theme_id, t.rank, t.title, t.posts]), [
    ['g1', 1, 'Saving a job fails', 4],
    ['g2', 2, 'Reported friction on /', 1],
  ]);
  assert.ok(report.methods.limitations?.includes('The judge tagged unknown post or group ids (g9, nope, s5); they were ignored.'));
});

test('seed posts, repeats and segments crossed, per POI and per theme, with the shared influence edges', () => {
  const [poi] = tagged().spread!;
  const [saving, home] = poi.themes;
  assert.equal(poi.name, 'Gym');
  assert.deepEqual(saving.seeds, [{ seq: 10, post_id: 's1', persona_id: 'a1', persona_name: 'Ana', segment_id: 'rec', round: 1, text: 'Saving a job does nothing at all.', injected: false }]);
  assert.deepEqual(saving.segments, [
    { segment_id: 'rec', name: 'Recruiters', personas: 2, seed: true },
    { segment_id: 'hm', name: 'Hiring managers', personas: 2, seed: false },
  ]);
  assert.deepEqual(saving.influence.map((e) => [e.from, e.to, e.post_id, e.round, e.delta]), [['a1', 'a2', 's1', 2, -1], ['a1', 'b2', 's1', 2, -2]]);
  assert.deepEqual(home.seeds.map((s) => [s.post_id, s.round]), [['s4', 2]]);
  assert.deepEqual(home.segments, [{ segment_id: 'hm', name: 'Hiring managers', personas: 1, seed: true }]);
  assert.deepEqual(home.influence, []);
  assert.equal(poi.posts, 4, "Ari's post is about no POI");
  assert.deepEqual(poi.seeds.map((s) => s.post_id), ['s1']);
  assert.equal(poi.influence.length, 2);
});

test('first-hand personas had their own friction in the theme; second-hand ones only posted about it', () => {
  const [poi] = tagged().spread!;
  const [saving, home] = poi.themes;
  assert.deepEqual(saving.first_hand, ['a1']);
  assert.deepEqual(saving.second_hand, ['a2', 'b2', 'b1'], 'Bo had a friction, but not this one');
  assert.deepEqual(home.first_hand, ['b1']);
  assert.deepEqual(home.second_hand, []);
  assert.deepEqual([...poi.first_hand].sort(), ['a1', 'b1']);
  assert.deepEqual(poi.second_hand, ['a2', 'b2']);
});

test("sentiment by round carries each persona's latest opinion forward; a theme counts only its own personas", () => {
  const [poi] = tagged().spread!;
  const line = [
    { round: 1, mean: -1, personas: 1 },
    { round: 2, mean: -1, personas: 3 },
    { round: 3, mean: -4 / 3, personas: 3 },
  ];
  assert.deepEqual(poi.sentiment, line);
  assert.deepEqual(poi.themes[0].sentiment, line);
  assert.deepEqual(poi.themes[1].sentiment.map((r) => [r.mean, r.personas]), [[null, 0], [null, 0], [null, 0]], 'Bo never gave an opinion');
});

test('homogeneity: mean pairwise TF-IDF cosine of model posts and persona backgrounds, warned at the threshold', () => {
  const posts = (...texts: string[]) => texts.map((text, i) => ({ ...at(1, 'a1'), type: 'social.post', seq: i + 1, ts: i, payload: post(`s${i}`, text) }) as GnomiEvent);
  const varied = [person('a1', 'rec', 'Ana', 'Runs payroll for a bakery chain.'), person('b1', 'hm', 'Bo', 'Coaches rowing on weekends.')];
  const alike = homogeneity(posts('Save is broken on the jobs page', 'Save is broken on the jobs page', 'Lovely colours and fast search'), varied);
  assert.ok(Math.abs(alike.posts! - 1 / 3) < 1e-9, `${alike.posts}`);
  assert.equal(alike.narratives, 0);
  assert.equal(alike.post_count, 3);
  assert.match(alike.warning ?? '', /^The posts \(mean similarity 0\.33\) read alike/);
  assert.doesNotMatch(alike.warning ?? '', /backgrounds/);

  const injected = { ...posts('Save is broken')[0], payload: post('x', 'Save is broken on the jobs page', 'poi', true) } as GnomiEvent;
  const quiet = homogeneity([...posts('Save is broken on the jobs page', 'Lovely colours and fast search'), injected], varied);
  assert.deepEqual([quiet.posts, quiet.post_count, quiet.warning], [0, 2, null], 'harness posts are not the swarm writing');
  assert.equal(homogeneity(posts('Only one'), varied.slice(0, 1)).posts, null);
});

test('the judge sees post summaries within their cap, an even stride over seq order, and the groups get the rest', () => {
  const groups = frictionGroups(socialRun().events, 'poi');
  const many = Array.from({ length: 40 }, (_, i) => ({ ...at(1 + Math.floor(i / 10), 'a1'), type: 'social.post', seq: i + 1, ts: i, payload: post(`s${i}`, 'x'.repeat(400)) }) as Post);
  const { posts, groups: sent } = judgeInput(groups, many, 30_000, 1_000);
  const used = posts.reduce((sum, p) => sum + Math.ceil(JSON.stringify(p).length / 4), 0);
  assert.deepEqual(posts.map((p) => p.id), ['s0', 's4', 's8', 's12', 's16', 's20', 's24', 's28', 's32', 's36']);
  assert.deepEqual([...new Set(posts.map((p) => p.round))], [1, 2, 3, 4], 'every round keeps some posts');
  assert.ok(used <= 1_000 && posts.every((p) => p.text.length === 280));
  assert.deepEqual(sent, judgeGroups(groups, 30_000 - used));
  assert.deepEqual(judgeInput(groups, []), { groups: judgeGroups(groups), posts: [] }, 'without posts, the M3 input');
});

async function withModels(social: boolean, judge: Responder) {
  const { events, record } = socialRun(social);
  const requests: { role: LlmRole; system: string; user: Record<string, unknown> }[] = [];
  const spy = (respond: Responder): Responder => (req) => {
    requests.push({ role: req.role, system: req.system, user: JSON.parse(req.user.map((p) => (p.type === 'text' ? p.text : '')).join('')) });
    return respond(req);
  };
  await runReportModels({ config, llm: createScriptedGateway({ judge: spy(judge), author: spy(DEMO_AUTHOR) }, record), record, events: () => events });
  return { events, requests, report: buildReport(events) };
}

test('scripted runs show spread: the demo judge tags every post, the tags are logged, and the log rebuilds the same report', async () => {
  const { events, requests, report } = await withModels(true, DEMO_JUDGE);
  assert.equal(requests[0].system, JUDGE_SYSTEM + JUDGE_POSTS);
  assert.deepEqual((requests[0].user.posts as { id: string }[]).map((p) => p.id), ['s1', 's2', 's3', 's4']);
  const logged = events.find((e) => e.type === 'report.themes');
  assert.deepEqual(logged?.type === 'report.themes' && logged.payload.posts?.map((p) => p.post_id), ['s1', 's2', 's3', 's4']);
  assert.deepEqual(report.spread?.[0].themes.map((t) => [t.theme_id, t.posts]), [['g1', 4]]);
  assert.ok(report.methods.homogeneity);
  assert.deepEqual(buildReport(JSON.parse(JSON.stringify(events))), report, 'the report is a fold of the log alone');
});

test('a run without social posts keeps the M3 judge call and gets no spread section or homogeneity', async () => {
  const { requests, report } = await withModels(false, DEMO_JUDGE);
  assert.equal(requests[0].system, JUDGE_SYSTEM);
  assert.deepEqual(Object.keys(requests[0].user), ['product', 'groups']);
  assert.equal('spread' in report, false);
  assert.equal('homogeneity' in report.methods, false);
  assert.doesNotMatch(reportToMarkdown(report), /Opinion spread|Homogeneity/);
});

test('without a judge answer the spread covers the POI only, and says why', async () => {
  const { report } = await withModels(true, () => ({ themes: 'nope' }));
  assert.deepEqual(report.spread?.map((s) => [s.posts, s.themes.length]), [[4, 0]]);
  assert.ok(report.methods.limitations?.includes('Without the judge, posts are not tagged to themes, so the opinion spread covers the product as a whole only.'));
});

test('Markdown carries the spread per POI and theme, and homogeneity in the methods', () => {
  const md = reportToMarkdown(tagged());
  for (const expected of [
    '## Opinion spread',
    '### About Gym',
    '#### 1. Saving a job fails',
    '- 4 posts; first-hand: 1 persona; second-hand: 3 personas (Abe, Bea, Bo)',
    '- Seed post by Ana, round 1: "Saving a job does nothing at all." (#10)',
    '- Segments reached: Recruiters 2 (seed), Hiring managers 2; crossed into 1 other segment',
    '- Mean sentiment by round, -2 to +2: 1: -1.00 (1 persona); 2: -1.00 (3 personas); 3: -1.33 (3 personas)',
    '#### 2. Reported friction on /',
    '- Mean sentiment by round, -2 to +2: 1: no opinions; 2: no opinions; 3: no opinions',
  ]) assert.ok(md.includes(expected), expected);
  assert.match(md, /- Influence: Ana → Abe \(round 2, -1\.00, #\d+\); Ana → Bea \(round 2, -2\.00, #\d+\)/);
  assert.match(md, /- Homogeneity \(mean pairwise TF-IDF cosine, warning at 0\.30\): posts \d\.\d\d \(5 posts\), persona backgrounds \d\.\d\d/);
});
