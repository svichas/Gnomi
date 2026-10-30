import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventPayloads, EventType, GnomiEvent, JudgeTheme } from '../types.ts';
import { buildCandidates, categoryOf, groupCandidates, groupKey, type Candidate, type Group } from './friction.ts';
import { analyseFrictions, applyJudge, applySuggestions, frictionGroups, judgeGroups, judgeInput, pickEvidence, prevalence, rulesTitle, sentimentBySegment, wentWell, type Context } from './themes.ts';

const JOBS = 'http://gym.test/jobs/new';
const HOME = 'http://gym.test/';

function log(...entries: [type: EventType, persona_id: string | null, payload: object][]): GnomiEvent[] {
  return entries.map(([type, persona_id, payload], i) => ({ run_id: 'r-1', round: 1, persona_id, poi_id: 'poi', type, payload, seq: i + 1, ts: i }) as GnomiEvent);
}
const step = (step_no: number, url = JOBS): EventPayloads['persona.step'] => ({
  step_no,
  action: { type: 'click', ref: 'e1', text: null },
  target: { role: 'button', name: 'Save', box: null },
  result: { ok: true, url_before: url, url_after: url, dom_changed: true, error: null },
  thought: `Step ${step_no}.`,
  feeling: 0,
  snapshot_hash: 'h',
  screenshot: `shots/${step_no}.jpg`,
  duration_ms: 1,
  heard_post_ids: [],
});
const friction = (step_no: number, severity: number, what = 'Save does nothing'): EventPayloads['persona.friction_reported'] => ({
  step_no, severity, what, expected: 'A saved job.', where: { url: JOBS, ref: 'e1' }, heard_post_ids: [],
});
const survey = (frictions: string[], likes: string[], sentiment = 0, would_continue = true): EventPayloads['persona.survey'] => ({
  poi_id: 'poi', sentiment, confidence: 0.5, likes, frictions, would_continue, reason: 'Because.',
});

// Recruiters (60%): a1, a2, a3 all reach the page; Hiring managers (40%): b1 reaches it, b2 never leaves the home page.
const ctx: Context = {
  poi_id: 'poi',
  personas: new Map([
    ['a1', { name: 'Ana', segment_id: 'rec' }],
    ['a2', { name: 'Abe', segment_id: 'rec' }],
    ['a3', { name: 'Ari', segment_id: 'rec' }],
    ['b1', { name: 'Bo', segment_id: 'hm' }],
    ['b2', { name: 'Bea', segment_id: 'hm' }],
  ]),
  segments: [{ id: 'rec', name: 'Recruiters', share: 60 }, { id: 'hm', name: 'Hiring managers', share: 40 }],
};

const run = log(
  ['persona.step', 'a1', step(1)],
  ['persona.friction_reported', 'a1', friction(1, 3)],
  ['signal.failed_action', 'a1', { step_no: 2, url: JOBS, ref: 'e1', action: 'click', error: 'no_effect' }],
  ['persona.step', 'a2', step(1)],
  ['persona.friction_reported', 'a2', friction(1, 2)],
  ['persona.step', 'a3', step(1)],
  ['persona.step', 'b1', step(1)],
  ['persona.friction_reported', 'b1', friction(1, 4)],
  ['persona.step', 'b2', step(1, HOME)],
);

test('scoring: the low end of the first-hand share of those who reached the page × the mean trust of its personas', () => {
  const [theme] = analyseFrictions(run, ctx).themes;
  // 3 of the 4 personas who reached the page (b2 never left home): 75%, with a 95% Wilson range of 30% to 95%; the median of
  // each persona's worst severity, 3, 2 and 4, is 3. Three personas and over a quarter: strong evidence.
  assert.deepEqual(theme.prevalence, { personas: 3, exposed: 4, share: 0.75, low: 0.3006, high: 0.9544, level: 'strong' });
  assert.deepEqual(theme.affected, [
    { segment_id: 'rec', name: 'Recruiters', affected: 2, reached: 3, rate: 2 / 3 },
    { segment_id: 'hm', name: 'Hiring managers', affected: 1, reached: 1, rate: 1 },
  ]);
  assert.equal(theme.severity, 3);
  // One confirmed report among two reported ones: the badge says so, and the score uses the mix (1 + 0.5 + 0.5) / 3, not the best.
  assert.equal(theme.trust, 'confirmed');
  assert.deepEqual(theme.trust_counts, { confirmed: 1, observed: 0, reported: 2 });
  assert.ok(Math.abs(theme.score - 0.3006 * (2 / 3)) < 1e-12);
  assert.deepEqual([theme.rank, theme.personas, theme.frictions, theme.title], [1, 3, 3, 'Trouble with button "Save" on /jobs/new']);
});

test('a survey answer merged into a page theme leaves "reached" at that page; a survey-only theme counts the whole POI', () => {
  const surveyed = [...run, ...log(['persona.survey', 'b2', survey(['Save is broken'], [])]).map((e) => ({ ...e, seq: e.seq + 100 }))];
  const judged = { ...run[0], seq: 200, persona_id: null, type: 'report.themes', payload: { poi_id: 'poi', themes: [{ title: 'Save', description: 'd', group_ids: ['g1', 'g2'] }] } } as GnomiEvent;
  const [merged] = analyseFrictions([...surveyed, judged], ctx).themes;
  assert.deepEqual(merged.affected.map((a) => [a.affected, a.reached]), [[2, 3], [2, 2]], 'b2 counts as affected, not through the POI');
  const surveyOnly = analyseFrictions(surveyed, ctx).themes.find((t) => t.id === 'g2');
  assert.deepEqual(surveyOnly?.affected.map((a) => [a.affected, a.reached]), [[0, 3], [1, 2]]);
});

test('themes rank by score within the POI', () => {
  const events = log(
    ['persona.step', 'a1', step(1)],
    ['persona.friction_reported', 'a1', { ...friction(1, 1), where: { url: JOBS, ref: null } }],
    ['persona.step', 'a1', { ...step(2, HOME), target: null }],
    ['persona.friction_reported', 'a1', { ...friction(2, 4, 'Home is empty'), where: { url: HOME, ref: null } }],
  );
  assert.deepEqual(analyseFrictions(events, ctx).themes.map((t) => [t.rank, t.title]), [[1, 'Reported friction on /'], [2, 'Trouble with button "Save" on /jobs/new']]);
});

test('evidence: at most three, highest severity first, one per persona first; every theme links to its events', () => {
  const c = (persona_id: string, severity: number, seq: number) => ({ persona_id, severity, trust: 'reported', seqs: [seq] }) as Candidate;
  const members = [c('p1', 4, 1), c('p1', 4, 2), c('p2', 2, 3), c('p3', 1, 4), c('p4', 3, 5)];
  assert.deepEqual(pickEvidence(members).map((m) => m.seqs[0]), [1, 5, 3]);
  assert.deepEqual(pickEvidence([c('p1', 4, 1), c('p1', 2, 2)]).map((m) => m.seqs[0]), [1, 2], 'one persona can fill the rest');

  const [theme] = analyseFrictions(run, ctx).themes;
  assert.equal(theme.evidence.length, 3);
  assert.deepEqual(theme.evidence.map((e) => [e.persona_name, e.severity, e.trust, e.step_seq, e.screenshot, e.signals]), [
    ['Bo', 4, 'reported', 7, 'shots/1.jpg', []],
    ['Ana', 3, 'confirmed', 1, 'shots/1.jpg', ['failed_action']],
    ['Abe', 2, 'reported', 4, 'shots/1.jpg', []],
  ]);
  assert.deepEqual(theme.seqs, [2, 3, 5, 8]);
});

const groups = (): Group[] =>
  groupCandidates(buildCandidates(log(
    ['persona.friction_reported', 'a1', { ...friction(1, 2, 'One'), where: { url: 'http://gym.test/a', ref: null } }],
    ['persona.friction_reported', 'a1', { ...friction(1, 2, 'Two'), where: { url: 'http://gym.test/b', ref: null } }],
    ['persona.friction_reported', 'a1', { ...friction(1, 2, 'Three'), where: { url: 'http://gym.test/c', ref: null } }],
  ), 'poi'));

test('judge output keeps known ids only, each group once; groups it drops stay as their own themes', () => {
  const judged: JudgeTheme[] = [
    { title: 'A and B are one problem', description: 'Merged.', group_ids: ['g1', 'g9', 'g2'] },
    { title: 'B again', description: 'Claims a placed group.', group_ids: ['g2'] },
    { title: 'Ghost', description: 'Only unknown ids.', group_ids: ['g7'] },
  ];
  const { drafts, unknown } = applyJudge(groups(), judged);
  assert.deepEqual(drafts.map((d) => [d.groups.map((g) => g.id), d.title, d.named_by]), [
    [['g1', 'g2'], 'A and B are one problem', 'judge'],
    [['g3'], 'Reported friction on /c', 'rules'],
  ]);
  assert.deepEqual(unknown, ['g9', 'g7']);
});

test('malformed or missing judge output falls back to one rules-named theme per group', () => {
  const rules = groups().map((g) => [[g.id], rulesTitle(g), 'rules']);
  for (const bad of [null, 'nonsense', [{}], [{ title: 5, group_ids: 'g1' }], [null]] as unknown[]) {
    assert.deepEqual(applyJudge(groups(), bad as JudgeTheme[]).drafts.map((d) => [d.groups.map((g) => g.id), d.title, d.named_by]), rules);
  }
  const blank = applyJudge(groups(), [{ title: '  ', description: '', group_ids: ['g1', 'g3'] }]).drafts[0];
  assert.deepEqual([blank.title, blank.description, blank.named_by], ['Reported friction on /a', 'One', 'rules']);
});

test('the judge sees the biggest groups first, and only as many as fit its input cap', () => {
  const all = groups();
  all[2].members.push({ ...all[2].members[0], persona_id: 'a2' });
  assert.deepEqual(judgeGroups(all).map((s) => s.id), ['g3', 'g1', 'g2']);
  const biggest = Math.ceil(JSON.stringify(judgeGroups(all)[0]).length / 4); // the cap counts about four characters a token
  assert.deepEqual(judgeGroups(all, biggest).map((s) => s.id), ['g3']);
});

test('suggestions attach to known themes, the first one per theme; unknown ids are reported', () => {
  const themes = analyseFrictions(run, ctx).themes;
  const { unknown } = applySuggestions(themes, [
    { theme_id: 'g1', change: 'Make Save save.', solution: 'Wire the button.' },
    { theme_id: 'g1', change: 'Second', solution: 'Ignored.' },
    { theme_id: 'g5', change: 'Stray', solution: 'Ignored.' },
  ]);
  assert.deepEqual(themes[0].suggestion, { change: 'Make Save save.', solution: 'Wire the button.' });
  assert.deepEqual(unknown, ['g5']);
});

test('sentiment by segment and what went well come from the surveys', () => {
  const events = log(
    ['persona.survey', 'a1', survey([], ['Clear pricing!', 'Fast'], 2)],
    ['persona.survey', 'a2', survey([], ['clear  pricing'], -1, false)],
    ['persona.survey', 'b1', survey([], ['Fast', ''], 1)],
  );
  assert.deepEqual(sentimentBySegment(events, ctx), [
    { segment_id: 'rec', name: 'Recruiters', surveyed: 2, sentiment: 0.5, would_continue: 0.5 },
    { segment_id: 'hm', name: 'Hiring managers', surveyed: 1, sentiment: 1, would_continue: 1 },
  ]);
  assert.deepEqual(wentWell(events), [
    { text: 'Clear pricing!', count: 2, personas: 2, seqs: [1, 2] },
    { text: 'Fast', count: 2, personas: 2, seqs: [1, 3] },
  ]);
  assert.deepEqual(sentimentBySegment(run, ctx), [], 'no surveys, no sentiment');
  const buyer = { ...survey([], [], -2, false), buyer: { would_buy: false, price: 'high', objections: [], unclear: [] } } as EventPayloads['persona.survey'];
  assert.deepEqual(sentimentBySegment([...events, ...log(['persona.survey', 'b1', buyer]).map((e) => ({ ...e, seq: 9, payload: { ...buyer, poi_id: 'other' } }) as GnomiEvent)], ctx)[1], { segment_id: 'hm', name: 'Hiring managers', surveyed: 1, sentiment: 1, would_continue: 1 }, 'buyers have their own section');
});

test('limitations say what the analysis could not do', () => {
  const judgedRun = [...run, { ...run[0], seq: 99, persona_id: null, type: 'report.themes', payload: { poi_id: 'poi', themes: [{ title: 'Save', description: 'd', group_ids: ['g1', 'g4'] }] } } as GnomiEvent];
  assert.deepEqual(analyseFrictions(judgedRun, ctx).limitations, [
    'The judge named unknown group ids (g4); they were ignored.',
    'This log predates group keys, so the judge\'s titles could not be checked against the current grouping and may name other groups.',
    'The author model wrote no suggested changes (no key, a model failure, or the run stopped first).',
    'No persona answered the end-of-episode survey, so there is no sentiment by segment and no "what went well".',
  ]);
  assert.deepEqual(analyseFrictions(log(['persona.step', 'a1', step(1)]), ctx), { themes: [], sentiment: [], went_well: [], limitations: [
    'No persona answered the end-of-episode survey, so there is no sentiment by segment and no "what went well".',
  ] });
});

const structured = (items: EventPayloads['persona.survey']['items'] & object, sentiment = 0): EventPayloads['persona.survey'] => ({
  ...survey(items.filter((i) => i.kind !== 'like').map((i) => i.what), items.filter((i) => i.kind === 'like').map((i) => i.what), sentiment),
  items,
});
const item = (kind: 'friction' | 'objection' | 'like', where: string, what: string, severity: number | null = kind === 'like' ? null : 2) => ({ kind, where, what, severity });

test('echoes: a report after a feed showed a post about the theme is heard first, unless a browser signal backs it', () => {
  const heard = (step_no: number, ids: string[]) => ({ ...step(step_no), heard_post_ids: ids });
  const social = log(
    ['persona.step', 'a1', step(1)],
    ['persona.friction_reported', 'a1', friction(1, 3)], // before any feed: first-hand
    ['social.post', 'a1', { post_id: 'p1', parent_id: null, text: 'Save does nothing!', about_poi_id: 'poi' }],
    ['social.feed_viewed', 'a2', { post_ids: ['p1'] }],
    ['social.feed_viewed', 'a3', { post_ids: ['p1'] }],
    ['persona.step', 'a2', heard(2, ['p1'])],
    ['persona.friction_reported', 'a2', { ...friction(2, 3), heard_post_ids: ['p1'] }], // after reading it: heard first
    ['persona.step', 'a3', heard(2, ['p1'])],
    ['persona.friction_reported', 'a3', { ...friction(2, 3), heard_post_ids: ['p1'] }],
    ['signal.failed_action', 'a3', { step_no: 2, url: JOBS, ref: 'e1', action: 'click', error: 'no_effect' }], // confirmed: first-hand
  );
  const judged = { ...social[0], seq: 99, persona_id: null, type: 'report.themes', payload: { poi_id: 'poi', themes: [{ title: 'Save', description: 'd', group_ids: ['g1'] }], posts: [{ post_id: 'p1', group_ids: ['g1'] }] } } as GnomiEvent;
  const counts = (events: GnomiEvent[]) => {
    const { themes: [theme], limitations } = analyseFrictions(events, ctx);
    return [theme.personas, theme.prevalence?.personas, theme.heard_first, theme.prevalence?.level, limitations.some((l) => l.includes('could not be separated'))];
  };
  assert.deepEqual(counts([...social, judged]), [3, 2, 1, 'some', false], 'by the judge’s tags');
  assert.deepEqual(counts(social), [3, 2, 1, 'some', false], 'by the heard ids, without the judge');
  const unrecorded = social.map((e) => (e.type === 'persona.step' ? { ...e, payload: { ...e.payload, heard_post_ids: undefined } } : e)) as GnomiEvent[];
  assert.deepEqual(counts(unrecorded), [3, 3, 0, 'strong', true], 'neither: every report counts, and the report says so');
  const taggedNothing = { ...judged, payload: { ...judged.payload, posts: [] } } as GnomiEvent;
  assert.deepEqual(counts([...social, taggedNothing]), [3, 2, 1, 'some', false], 'a judge that tagged nothing leaves the heard ids in charge');
  const { themes: [theme] } = analyseFrictions(social, ctx);
  assert.deepEqual([...(theme.first_hand ?? [])].sort(), ['a1', 'a3'], 'the first-hand ids are kept on the theme');
  assert.deepEqual(theme.affected.map((a) => a.affected), [2, 0], 'and the segment rows count only them');
  // Seqs are completion order across personas: a1 met it at step 1 but its report is logged after a2's at step 2, which echoes it.
  const late = log(
    ['social.post', 'a1', { post_id: 'p1', parent_id: null, text: 'Save does nothing!', about_poi_id: 'poi' }],
    ['persona.step', 'a2', heard(2, ['p1'])],
    ['persona.friction_reported', 'a2', { ...friction(2, 3), heard_post_ids: ['p1'] }],
    ['persona.step', 'a1', step(1)],
    ['persona.friction_reported', 'a1', friction(1, 3)],
  );
  assert.equal(analyseFrictions(late, ctx).themes[0].heard_first, 1);
  // A reply shows its parent's text: a feed that showed a reply to a tagged post showed that post too.
  const quoted = log(
    ['persona.step', 'a1', step(1)],
    ['persona.friction_reported', 'a1', friction(1, 3)],
    ['social.post', 'a1', { post_id: 'p1', parent_id: null, text: 'Save does nothing!', about_poi_id: 'poi' }],
    ['social.post', 'a3', { post_id: 'p2', parent_id: 'p1', text: 'Same here.', about_poi_id: 'poi' }],
    ['social.feed_viewed', 'a2', { post_ids: ['p2'], parent_ids: ['p1'] }],
    ['persona.step', 'a2', step(2)],
    ['persona.friction_reported', 'a2', friction(2, 3)],
  );
  assert.equal(analyseFrictions([...quoted, judged], ctx).themes[0].heard_first, 1);
});

test('structured survey answers group by the part of the product they name, and objections stay apart from frictions', () => {
  const events = log(
    ['persona.survey', 'a1', structured([item('friction', 'Pricing page', 'Plans hide the seat limit', 3), item('objection', 'pricing page', 'No team price to show my boss', 4)])],
    ['persona.survey', 'a2', structured([item('friction', 'pricing  page', 'Could not tell what a seat is', 2)])],
    ['persona.survey', 'a3', structured([item('objection', 'Security', 'Nothing on where data is stored', 3)])],
  );
  const groups = groupCandidates(buildCandidates(events, 'poi'));
  assert.deepEqual(groups.map((g) => [g.id, g.kind, g.element, g.members.map((m) => [m.persona_id, m.severity])]), [
    ['g1', 'survey', 'Pricing page', [['a1', 3], ['a2', 2]]],
    ['g2', 'objection', 'pricing page', [['a1', 4]]],
    ['g3', 'objection', 'Security', [['a3', 3]]],
  ]);
  // The judge tries to fold the pricing objection into the pricing friction: the objection stays its own theme, under the judge's
  // name, and a repeat of the same theme (models sometimes list them twice) adds nothing.
  const twice = { title: 'Pricing is unclear', description: 'd', group_ids: ['g1', 'g2'] };
  const judged = applyJudge(groups, [twice, twice]);
  assert.deepEqual(judged.drafts.map((d) => [d.groups.map((g) => g.id), categoryOf(d.groups[0].kind), d.title, d.named_by]), [
    [['g1'], 'friction', 'Pricing is unclear', 'judge'],
    [['g2'], 'objection', 'Objection: Pricing is unclear', 'judge'],
    [['g3'], 'objection', 'Nothing on where data is stored', 'rules'],
  ]);
  const themes = analyseFrictions(events, ctx).themes;
  assert.deepEqual(themes.map((t) => [t.id, t.category, t.prevalence?.personas, t.prevalence?.exposed, t.prevalence?.level]), [
    ['g1', 'friction', 2, 3, 'some'], // two personas: better evidence than either single report
    ['g2', 'objection', 1, 3, 'single'], // severity 4
    ['g3', 'objection', 1, 3, 'single'],
  ]);
});

test('a survey group the judge did not name is titled by its first sentence, cut at a word', () => {
  const long = `Reached Pricing after several pages of searching and found no numbers at all, just a form asking for my company size and email. Expected prices.`;
  const [short, cut] = groupCandidates(buildCandidates(log(
    ['persona.survey', 'a1', structured([item('objection', 'Security', 'Nothing on where data is stored. I would ask IT first.', 3)])],
    ['persona.survey', 'a2', structured([item('friction', 'Pricing page', long, 3)])],
  ), 'poi'));
  assert.equal(rulesTitle(short), 'Nothing on where data is stored');
  assert.equal(rulesTitle(cut), 'Reached Pricing after several pages of searching and found no numbers at all, just a form asking for my company size…');
});

test('buyer objections are a share of the buyers surveyed on the POI, not of everyone who used it', () => {
  const buyer = { ...survey(['Too expensive for us'], []), buyer: { would_buy: false, price: 'high', objections: ['Too expensive for us'], unclear: [] } } as EventPayloads['persona.survey'];
  const events = log(
    ...[...['a1', 'a2', 'a3']].map((id) => ['persona.survey', id, survey([], [])] as [EventType, string, object]),
    ['persona.survey', 'b1', buyer],
    ['persona.survey', 'b2', buyer],
  );
  const [theme] = analyseFrictions(events, ctx).themes;
  assert.deepEqual([theme.category, theme.prevalence?.personas, theme.prevalence?.exposed], ['objection', 2, 2]);
  assert.deepEqual(theme.affected.map((a) => [a.affected, a.reached]), [[0, 0], [2, 2]], 'users never get the buying survey');
  // The reverse: a friction only users named in their survey is a share of the users, not of the buyers too.
  const quiet = { ...buyer, frictions: [], buyer: { ...buyer.buyer!, objections: [] } };
  const users = log(
    ['persona.survey', 'a1', survey(['It was long'], [])],
    ['persona.survey', 'a2', survey(['It was long'], [])],
    ['persona.survey', 'a3', survey([], [])],
    ['persona.survey', 'b1', quiet],
    ['persona.survey', 'b2', quiet],
  );
  const [long] = analyseFrictions(users, ctx).themes;
  assert.deepEqual([long.category, long.prevalence?.personas, long.prevalence?.exposed], ['friction', 2, 3]);
  assert.deepEqual(long.affected.map((a) => [a.affected, a.reached]), [[2, 3], [0, 0]]);
});

test('merged themes that tie on everything rank by their first group, not by the judge’s order', () => {
  const events = log(...(['a1', 'a2', 'b1', 'b2'] as const).map((id, i) => ['persona.survey', id, structured([item('friction', `Part ${i}`, 'Hard to use')])] as [EventType, string, object]));
  const judged = { ...events[0], seq: 99, persona_id: null, type: 'report.themes', payload: { poi_id: 'poi', themes: [{ title: 'Late', description: 'd', group_ids: ['g3', 'g4'] }, { title: 'Early', description: 'd', group_ids: ['g1', 'g2'] }] } } as GnomiEvent;
  assert.deepEqual(analyseFrictions([...events, judged], ctx).themes.map((t) => [t.id, t.rank]), [['g1+g2', 1], ['g3+g4', 2]]);
});

test('nobody met first-hand is evidence none, not a single report', () => {
  assert.equal(prevalence(0, 5).level, 'none');
  assert.equal(prevalence(1, 5).level, 'single');
});

test('replayed judge answers and suggestions are dropped when their group ids now name other groups, and the report says so', () => {
  const answer = (keys: Record<string, string>) => ({ ...run[0], seq: 99, persona_id: null, type: 'report.themes', payload: { poi_id: 'poi', themes: [{ title: 'Save is broken', description: 'd', group_ids: ['g1'] }], keys } }) as GnomiEvent;
  const suggested = { ...run[0], seq: 100, persona_id: null, type: 'report.suggestions', payload: { poi_id: 'poi', suggestions: [{ theme_id: 'g1', change: 'Fix Save.', solution: 's' }] } } as GnomiEvent;
  const current = groupKey(groupCandidates(buildCandidates(run, 'poi'))[0].members[0]);
  const same = analyseFrictions([...run, answer({ g1: current }), suggested], ctx);
  assert.deepEqual([same.themes[0].title, same.themes[0].suggestion?.change], ['Save is broken', 'Fix Save.']);
  const moved = analyseFrictions([...run, answer({ g1: '["poi","elsewhere"]' }), suggested], ctx);
  assert.deepEqual([moved.themes[0].named_by, moved.themes[0].suggestion], ['rules', null]);
  assert.ok(moved.limitations.includes('The grouping rules changed after this run, so 1 judge answer and 1 suggested change naming groups that no longer match were dropped.'));
  const unchecked = 'This log predates group keys, so the judge\'s titles could not be checked against the current grouping and may name other groups.';
  assert.ok(!same.limitations.includes(unchecked));
  const old = { ...answer({}), payload: { poi_id: 'poi', themes: [{ title: 'Save is broken', description: 'd', group_ids: ['g1'] }] } } as GnomiEvent;
  assert.ok(analyseFrictions([...run, old], ctx).limitations.includes(unchecked), 'a log from before keys keeps its titles but says they are unchecked');
});

test('after a rejudge, suggestions older than the newest judge answer are not used: they were written for the earlier themes', () => {
  const current = groupKey(groupCandidates(buildCandidates(run, 'poi'))[0].members[0]);
  const answer = (seq: number) => ({ ...run[0], seq, persona_id: null, type: 'report.themes', payload: { poi_id: 'poi', themes: [{ title: 'Save is broken', description: 'd', group_ids: ['g1'] }], keys: { g1: current } } }) as GnomiEvent;
  const suggested = { ...run[0], seq: 100, persona_id: null, type: 'report.suggestions', payload: { poi_id: 'poi', suggestions: [{ theme_id: 'g1', change: 'Fix Save.', solution: 's' }] } } as GnomiEvent;
  assert.equal(analyseFrictions([...run, answer(99), suggested], ctx).themes[0].suggestion?.change, 'Fix Save.');
  const rejudged = analyseFrictions([...run, answer(99), suggested, answer(101)], ctx);
  assert.equal(rejudged.themes[0].suggestion, null);
  assert.ok(rejudged.limitations.includes('The author model wrote no suggested changes (no key, a model failure, or the run stopped first).'));
});

const tiny = (step_no: number) => ({ step_no, url: JOBS, ref: 'e1', box: [0, 0, 208, 21] });
const onLink = (step_no: number, name: string) => ({ ...step(step_no), target: { role: 'link', name, box: null } });
// g1 and g3 are weak signals alone; g2 and g4 are self-reports.
const mixed = log(
  ['persona.step', 'a1', onLink(1, 'Tiny')],
  ['signal.small_target', 'a1', tiny(1)],
  ['persona.step', 'a1', onLink(2, 'Home')],
  ['persona.friction_reported', 'a1', friction(2, 3, 'Home is empty')],
  ['persona.step', 'a1', onLink(3, 'Back')],
  ['signal.backtrack', 'a1', { step_no: 3, url: JOBS, ref: null, kind: 'revisit' }],
  ['persona.step', 'a1', onLink(4, 'Next')],
  ['persona.friction_reported', 'a1', friction(4, 2, 'Next is broken')],
);

test('weak signals alone make no theme and no note, and stay in the groups so ids hold', () => {
  const weak = mixed.filter((e) => e.type !== 'persona.friction_reported');
  const { themes, limitations } = analyseFrictions(weak, ctx);
  assert.deepEqual(themes, []);
  assert.deepEqual(limitations, ['No persona answered the end-of-episode survey, so there is no sentiment by segment and no "what went well".'], 'nothing about a judge that had nothing to name');
  assert.deepEqual(frictionGroups(weak, 'poi').map((g) => [g.id, g.kind]), [['g1', 'small_target'], ['g2', 'backtrack']]);
  assert.deepEqual(frictionGroups(mixed, 'poi').map((g) => g.id), ['g1', 'g2', 'g3', 'g4'], 'not renumbered around the weak ones');
});

test('a self-report or another signal on the same element keeps a weak signal in its theme, as before', () => {
  const reported = log(
    ['persona.step', 'a1', step(1)],
    ['signal.small_target', 'a1', tiny(1)],
    ['persona.friction_reported', 'a1', friction(1, 3)],
  );
  const [theme] = analyseFrictions(reported, ctx).themes;
  assert.deepEqual([theme.id, theme.frictions, theme.trust, theme.trust_counts], ['g1', 2, 'observed', { confirmed: 0, observed: 1, reported: 1 }]);
  const failed = log(
    ['persona.step', 'a1', step(1)],
    ['signal.small_target', 'a1', tiny(1)],
    ['signal.failed_action', 'a1', { step_no: 1, url: JOBS, ref: 'e1', action: 'click', error: 'no_effect' }],
  );
  assert.deepEqual(analyseFrictions(failed, ctx).themes.map((t) => [t.id, t.frictions]), [['g1', 2]]);
});

test('saved answers naming weak groups stay valid: their ids are known, and only themes with something else in them remain', () => {
  const groups = groupCandidates(buildCandidates(mixed, 'poi'));
  const keys = Object.fromEntries(groups.map((g) => [g.id, groupKey(g.members[0])]));
  const post = log(['social.post', 'a1', { post_id: 'p1', parent_id: null, text: 'So tiny!', about_poi_id: 'poi' }]).map((e) => ({ ...e, seq: 50 }));
  const answer = (themes: JudgeTheme[]) => ({ ...mixed[0], seq: 99, persona_id: null, type: 'report.themes', payload: { poi_id: 'poi', themes, posts: [{ post_id: 'p1', group_ids: ['g1'] }], keys } }) as GnomiEvent;
  const suggest = (...ids: string[]) => ({ ...mixed[0], seq: 100, persona_id: null, type: 'report.suggestions', payload: { poi_id: 'poi', suggestions: ids.map((theme_id) => ({ theme_id, change: `Fix ${theme_id}.`, solution: 's' })) } }) as GnomiEvent;
  const named = (title: string, ...group_ids: string[]) => ({ title, description: 'd', group_ids });
  const noise = (limitations: string[]) => limitations.filter((l) => /unknown|did not fit|no longer match/.test(l));

  const kept = analyseFrictions([...mixed, ...post, answer([named('Tiny link', 'g1'), named('Empty home', 'g2'), named('Next and back', 'g3', 'g4')]), suggest('g1', 'g2', 'g3+g4')], ctx);
  assert.deepEqual(kept.themes.map((t) => [t.id, t.title, t.named_by, t.suggestion?.change]), [
    ['g2', 'Empty home', 'judge', 'Fix g2.'],
    ['g3+g4', 'Next and back', 'judge', 'Fix g3+g4.'],
  ]);
  assert.deepEqual(noise(kept.limitations), []);
  const merged = analyseFrictions([...mixed, ...post, answer([named('Tiny and back', 'g1', 'g3')]), suggest('g1+g3')], ctx);
  assert.deepEqual(merged.themes.map((t) => t.id), ['g2', 'g4'], 'a merge of weak groups is weak too');
  assert.deepEqual(noise(merged.limitations), []);
});

test('the judge is not sent weak groups, and they never count as not fitting its input', () => {
  assert.deepEqual(judgeInput(frictionGroups(mixed, 'poi'), []).groups.map((g) => g.id), ['g2', 'g4']);
  assert.deepEqual(judgeGroups(frictionGroups(mixed.filter((e) => e.type !== 'persona.friction_reported'), 'poi')), []);
  const answered = (events: GnomiEvent[]) => [...events, { ...events[0], seq: 9_999, persona_id: null, type: 'report.themes', payload: { poi_id: 'poi', themes: [] } } as GnomiEvent];
  const unfit = (events: GnomiEvent[]) => analyseFrictions(answered(events), ctx).limitations.filter((l) => l.includes("did not fit the judge's input"));
  assert.deepEqual(unfit(mixed), []);
  const many = Array.from({ length: 500 }, (_, i): [EventType, string, object] => ['persona.friction_reported', 'a1', { ...friction(1, 2, `Problem ${i} `.repeat(30)), where: { url: `http://gym.test/p${i}`, ref: null } }]);
  const crowded = log(...many, ['signal.small_target', 'a1', tiny(1)]);
  const sent = judgeInput(frictionGroups(crowded, 'poi'), []).groups.length;
  assert.ok(sent < 500);
  assert.deepEqual(unfit(crowded), [`${500 - sent} friction groups did not fit the judge's input and stayed as their own themes.`], 'the 501st group is weak, so it is not one of them');
});

test('a buyer’s plain answers are objections; an older survey’s are frictions grouped by their words', () => {
  const buyer = { ...survey(['Too expensive for us'], []), buyer: { would_buy: false, price: 'high', objections: ['Too expensive for us'], unclear: [] } } as EventPayloads['persona.survey'];
  const kinds = buildCandidates(log(['persona.survey', 'a1', buyer], ['persona.survey', 'a2', survey(['It was long.'], [])]), 'poi').map((c) => [c.kind, c.element, c.severity]);
  assert.deepEqual(kinds, [['objection', null, 2], ['survey', null, 2]]);
});

test('ranking: evidence first, so a mild problem several met ranks above a severe one one persona met; one persona repeating itself counts once', () => {
  const many = new Map([...'abcdefghij'].map((id) => [id, { name: id, segment_id: 'rec' }]));
  const wide: Context = { poi_id: 'poi', personas: many, segments: [{ id: 'rec', name: 'Recruiters', share: 100 }] };
  const events = log(
    ...[...'abcdefghij'].map((id) => ['persona.step', id, step(1, HOME)] as [EventType, string, object]),
    ['persona.survey', 'a', structured([item('friction', 'export', 'Export crashed and I could not go on', 4)])],
    ...[...'bcd'].map((id) => ['persona.survey', id, structured([item('friction', 'search', 'Search ignores the job title', 2)])] as [EventType, string, object]),
  );
  const themes = analyseFrictions(events, wide).themes;
  assert.deepEqual(themes.map((t) => [t.title, t.prevalence?.level, t.rank]), [
    ['Search ignores the job title', 'strong', 1],
    ['Export crashed and I could not go on', 'single', 2],
  ]);
  assert.deepEqual(themes[0].prevalence, { personas: 3, exposed: 10, share: 0.3, low: 0.1078, high: 0.6032, level: 'strong' });
  // Persona e reports a blocker eight times; f and g a small irritation once each: the median is over personas, so 1.
  const repeated = log(
    ...[...'efg'].map((id) => ['persona.step', id, step(1)] as [EventType, string, object]),
    ...Array.from({ length: 8 }, () => ['persona.friction_reported', 'e', friction(1, 4)] as [EventType, string, object]),
    ['persona.friction_reported', 'f', friction(1, 1)],
    ['persona.friction_reported', 'g', friction(1, 1)],
  );
  assert.equal(analyseFrictions(repeated, wide).themes[0].severity, 1);
});

test('what went well: likes grouped by where, merged and named by the judge, with the share of personas who named them', () => {
  const events = log(
    ['persona.survey', 'a1', structured([item('like', 'Job form', 'The form is short'), item('like', 'Preview', 'Seeing the ad before posting')])],
    ['persona.survey', 'a2', structured([item('like', 'job form', 'Few required fields')])],
    ['persona.survey', 'b1', structured([item('like', 'Ad preview', 'Preview matches the board')])],
  );
  const judged = { ...events[0], seq: 50, persona_id: null, type: 'report.themes', payload: { poi_id: 'poi', themes: [], likes: [{ title: 'Previewing the ad before posting', description: 'They trusted the preview.', group_ids: ['l2', 'l3', 'l9'] }] } } as GnomiEvent;
  const likes = wentWell([...events, judged], ctx);
  assert.deepEqual(likes.map((l) => [l.text, l.description ?? null, l.where, l.personas, l.prevalence?.exposed, l.prevalence?.level]), [
    ['Previewing the ad before posting', 'They trusted the preview.', ['Preview', 'Ad preview'], 2, 3, 'some'],
    ['The form is short', null, ['Job form', 'job form'], 2, 3, 'some'],
  ]);
  assert.deepEqual(likes[0].quotes, [{ persona_id: 'a1', persona_name: 'Ana', what: 'Seeing the ad before posting' }, { persona_id: 'b1', persona_name: 'Bo', what: 'Preview matches the board' }]);
});
