import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventPayloads, EventType, GnomiEvent, JudgeTheme } from '../types.ts';
import { buildCandidates, groupCandidates, type Candidate, type Group } from './friction.ts';
import { analyseFrictions, applyJudge, applySuggestions, judgeGroups, pickEvidence, rulesTitle, sentimentBySegment, wentWell, type Context } from './themes.ts';

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
});
const friction = (step_no: number, severity: number, what = 'Save does nothing'): EventPayloads['persona.friction_reported'] => ({
  step_no, severity, what, expected: 'A saved job.', where: { url: JOBS, ref: 'e1' },
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

test('scoring: affected share per segment, weighted by share, × median severity × the highest trust', () => {
  const [theme] = analyseFrictions(run, ctx).themes;
  // Recruiters 2 of 3 who reached the page, hiring managers 1 of 1 (b2 never reached it):
  // impact = 0.6 × 2/3 + 0.4 × 1 = 0.8; median severity of 3, 2, 4 is 3; a1 is confirmed, so trust 1.0; score 2.4.
  assert.deepEqual(theme.affected, [
    { segment_id: 'rec', name: 'Recruiters', affected: 2, reached: 3, rate: 2 / 3 },
    { segment_id: 'hm', name: 'Hiring managers', affected: 1, reached: 1, rate: 1 },
  ]);
  assert.ok(Math.abs(theme.impact - 0.8) < 1e-12);
  assert.equal(theme.severity, 3);
  assert.equal(theme.trust, 'confirmed');
  assert.ok(Math.abs(theme.score - 2.4) < 1e-12);
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
});

test('limitations say what the analysis could not do', () => {
  const judgedRun = [...run, { ...run[0], seq: 99, persona_id: null, type: 'report.themes', payload: { poi_id: 'poi', themes: [{ title: 'Save', description: 'd', group_ids: ['g1', 'g4'] }] } } as GnomiEvent];
  assert.deepEqual(analyseFrictions(judgedRun, ctx).limitations, [
    'The judge named unknown group ids (g4); they were ignored.',
    'The author model wrote no suggested changes (no key, a model failure, or the run stopped first).',
    'No persona answered the end-of-episode survey, so there is no sentiment by segment and no "what went well".',
  ]);
  assert.deepEqual(analyseFrictions(log(['persona.step', 'a1', step(1)]), ctx), { themes: [], sentiment: [], went_well: [], limitations: [
    'No persona answered the end-of-episode survey, so there is no sentiment by segment and no "what went well".',
  ] });
});
