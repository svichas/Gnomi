import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScriptedGateway, DEMO_AUTHOR } from '../llm/scripted.ts';
import { describe } from '../log/describe.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import type { BlobStore, LlmGateway, Recorder, Responder } from '../seams.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { GnomiEvent, NewEvent, Poi, Report, ReportTheme, RunConfig } from '../types.ts';
import { buildReport } from './build.ts';
import { diffReports } from './diff.ts';
import { forSharing, setForSharing } from './edits.ts';
import { gateDecision } from './gate.ts';
import { HIDDEN_FRICTIONS, reportToMarkdown, sharedText, studyPlanToMarkdown } from './markdown.ts';
import { runReportModels } from './models.ts';
import { combineReports } from './repeats.ts';
import { runStudyPlan } from './study.ts';
import { HIDDEN_ALL, writtenSummary } from './summary.ts';

const page = (path: string) => `http://gym.test${path}`;
const poi: Poi = { id: 'poi', type: 'web', name: 'Gym', start_url: 'http://gym.test/', allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null };
const config: RunConfig = {
  run_id: 'r-1', seed: 1, personas: [BUILTIN_PERSONA], sessions: [], reset: false, pause_timeout_ms: 0, app_version: '0.0.0',
  project: { name: 'Gym', description: 'A demo ATS.', goal: 'Post a job', role: null, audience: null, settings: DEFAULT_SETTINGS, pois: [poi] },
};
const who = { run_id: 'r-1', round: 1, persona_id: BUILTIN_PERSONA.id, poi_id: 'poi' } as const;
const none = { ...who, persona_id: null, poi_id: null };

function logOf(pages: string[]) {
  const events: GnomiEvent[] = [];
  const record: Recorder = (event: NewEvent) => {
    const stored = { ...event, seq: events.length + 1, ts: events.length } as GnomiEvent;
    events.push(stored);
    return stored;
  };
  record({ ...none, type: 'run.started', payload: { config } });
  record({ ...who, type: 'persona.created', payload: { persona: BUILTIN_PERSONA } });
  pages.forEach((path, i) => record({ ...who, type: 'persona.friction_reported', payload: { step_no: i + 1, severity: 3, what: `The save button on ${path} does nothing at all`, expected: 'Saved', where: { url: page(path), ref: null }, heard_post_ids: [] } }));
  record({ ...none, type: 'run.finished', payload: {} });
  return { events, record };
}

const finding = (t: ReportTheme) => ({ ...none, poi_id: t.poi_id, payload: { keys: t.keys!, category: t.category, title: t.title } });
const hide = (t: ReportTheme, hidden = true): NewEvent => { const { payload, ...e } = finding(t); return { ...e, type: 'finding.hidden', payload: { ...payload, hidden } }; };
const edit = (t: ReportTheme, new_title: string | null, new_description: string | null = null): NewEvent => { const { payload, ...e } = finding(t); return { ...e, type: 'finding.edited', payload: { ...payload, new_title, new_description } }; };
const elsewhere = (t: ReportTheme) => ({ ...t, keys: ['["poi",null,"kind","gone"]'], title: 'A finding from an older grouping' });

/** Names the themes as a judge would: one theme per entry of `ids`, each group list merged. */
const judged = (events: GnomiEvent[], ids: string[][], name = (i: number) => `Judged theme ${i}`): NewEvent => {
  const keys = Object.fromEntries((buildReport(events).themes ?? []).flatMap((t) => t.id.split('+').map((g, i) => [g, t.keys![i]])));
  return { ...none, poi_id: 'poi', type: 'report.themes', payload: { poi_id: 'poi', themes: ids.map((group_ids, i) => ({ title: name(i), description: `Description ${i}`, group_ids })), keys } };
};

test('a hide and a rewording land on their theme, the text of the finding stays, and each goes back', () => {
  const { events, record } = logOf(['/jobs', '/users']);
  const [jobs, users] = buildReport(events).themes!;
  record(hide(jobs));
  record(edit(users, 'Saving users fails', 'A plainer description.'));
  assert.equal(describe(events.at(-2)!), `hidden from exports: "${jobs.title}"`);
  assert.equal(describe(events.at(-1)!), `reworded for exports: "${users.title}"`);
  const edited = buildReport(events);
  assert.deepEqual(edited.themes![0].edit, { hidden: true, new_title: null, new_description: null });
  assert.deepEqual(edited.themes![1].edit, { hidden: false, new_title: 'Saving users fails', new_description: 'A plainer description.' });
  assert.deepEqual(edited.themes!.map((t) => t.title), [jobs.title, users.title]);

  record(hide(jobs, false));
  record(edit(users, null));
  assert.equal(describe(events.at(-2)!), `back in exports: "${jobs.title}"`);
  assert.equal(describe(events.at(-1)!), `wording back to the original: "${users.title}"`);
  assert.deepEqual(buildReport(events).themes, buildReport(events.slice(0, -4)).themes, 'a theme back as it was has no field left');
});

test('the latest for a theme wins', () => {
  const { events, record } = logOf(['/jobs']);
  const [theme] = buildReport(events).themes!;
  for (const event of [hide(theme), hide(theme, false), hide(theme), edit(theme, 'First wording'), edit(theme, 'Second wording', 'And more')]) record(event);
  assert.deepEqual(buildReport(events).themes![0].edit, { hidden: true, new_title: 'Second wording', new_description: 'And more' });
  assert.equal(buildReport(events).unmatched_edits, undefined, 'what a later record corrected is no orphan');
});

test('a hide survives a rejudge that changes theme ids, and stays on every part of a finding it split', () => {
  const { events, record } = logOf(['/jobs', '/users', '/teams']);
  record(judged(events, [['g1', 'g2'], ['g3']], (i) => `First name ${i}`));
  const merged = buildReport(events).themes!.find((t) => t.id === 'g1+g2')!;
  record(hide(merged));
  record(edit(merged, 'Our words'));
  record(judged(events, [['g1'], ['g2'], ['g3']], (i) => `Second name ${i}`));
  const report = buildReport(events);
  assert.deepEqual(report.themes!.filter((t) => t.edit?.hidden).map((t) => t.id).sort(), ['g1', 'g2'], 'a part left over would be back in exports with nobody asking');
  assert.equal(report.themes!.filter((t) => t.edit?.new_title).length, 1, 'a rewording fits one finding');
  assert.equal(report.unmatched_edits, undefined);
});

test('showing one part of a split finding leaves the other hidden', () => {
  const { events, record } = logOf(['/jobs', '/users']);
  record(judged(events, [['g1', 'g2']]));
  record(hide(buildReport(events).themes![0]));
  record(judged(events, [['g1'], ['g2']]));
  const [one] = buildReport(events).themes!;
  record(hide(one, false));
  assert.deepEqual(buildReport(events).themes!.map((t) => [t.id, !!t.edit?.hidden]).sort(), [['g1', false], ['g2', true]]);
});

test('two hidden findings a rejudge merged are one hidden finding, with nothing to tell the team', () => {
  const { events, record } = logOf(['/jobs', '/users']);
  const [jobs, users] = buildReport(events).themes!;
  record(hide(jobs));
  record(hide(users));
  record(judged(events, [['g1', 'g2']]));
  const report = buildReport(events);
  assert.equal(report.themes![0].edit?.hidden, true);
  assert.equal(report.unmatched_edits, undefined);
});

test('two reworded findings a rejudge merged are one reworded finding: the newer words stand, and the older are replaced, not listed', () => {
  const { events, record } = logOf(['/jobs', '/users']);
  const [jobs, users] = buildReport(events).themes!;
  record(edit(jobs, 'OLDER-WORDS'));
  record(edit(users, 'NEWER-WORDS'));
  record(judged(events, [['g1', 'g2']]));
  const report = buildReport(events);
  assert.equal(report.themes![0].edit?.new_title, 'NEWER-WORDS');
  assert.equal(report.unmatched_edits, undefined, 'the finding is still there under the team\'s words, so it is not back in exports as an entry would say');
});

test('a reset on the part of a split finding that holds its words takes them off, and they do not move to the other part', () => {
  const split = () => {
    const { events, record } = logOf(['/jobs', '/users']);
    record(judged(events, [['g1', 'g2']]));
    record(edit(buildReport(events).themes![0], 'WORDS-FOR-THE-WHOLE'));
    record(judged(events, [['g1'], ['g2']]));
    const themes = buildReport(events).themes!;
    return { events, record, worded: themes.find((t) => t.edit)!, other: themes.find((t) => !t.edit)! };
  };
  const titles = (events: GnomiEvent[]) => buildReport(events).themes!.map((t) => t.edit?.new_title ?? null).sort();

  const reset = split();
  reset.record(edit(reset.worded, null));
  const report = buildReport(reset.events);
  assert.ok(report.themes!.every((t) => !t.edit), 'nobody wrote those words for the other part');
  assert.equal(report.unmatched_edits, undefined);

  const elsewhere = split();
  elsewhere.record(edit(elsewhere.other, null));
  assert.equal(titles(elsewhere.events).filter(Boolean).length, 1, 'a reset on the other part leaves them where they are');

  const both = split();
  both.record(edit(both.other, 'WORDS-FOR-THE-OTHER'));
  assert.deepEqual(titles(both.events), ['WORDS-FOR-THE-OTHER', 'WORDS-FOR-THE-WHOLE'], 'and so does a rewording of it');
});

test('what a team undid after a rejudge is no orphan, whichever way the rejudge went', () => {
  const merged = logOf(['/jobs', '/users']);
  for (const theme of buildReport(merged.events).themes!) merged.record(hide(theme));
  merged.record(judged(merged.events, [['g1', 'g2']]));
  merged.record(hide(buildReport(merged.events).themes![0], false));
  assert.deepEqual([buildReport(merged.events).unmatched_edits, buildReport(merged.events).themes![0].edit], [undefined, undefined], 'shown after a merge');

  const grown = logOf(['/jobs', '/users', '/teams']);
  grown.record(judged(grown.events, [['g1', 'g2'], ['g3']]));
  const whole = buildReport(grown.events).themes!.find((t) => t.id === 'g1+g2')!;
  grown.record(hide(whole));
  grown.record(edit(whole, 'Our words'));
  grown.record(judged(grown.events, [['g1', 'g2', 'g3']]));
  const [bigger] = buildReport(grown.events).themes!;
  assert.equal(buildReport(grown.events).themes![0].edit?.hidden, true);
  grown.record(hide(bigger, false));
  grown.record(edit(bigger, null));
  assert.deepEqual([buildReport(grown.events).unmatched_edits, buildReport(grown.events).themes![0].edit], [undefined, undefined], 'shown and reset after a finding grew');

  const split = logOf(['/jobs', '/users']);
  split.record(judged(split.events, [['g1', 'g2']]));
  split.record(hide(buildReport(split.events).themes![0]));
  split.record(judged(split.events, [['g1'], ['g2']]));
  for (const part of buildReport(split.events).themes!) split.record(hide(part, false));
  assert.deepEqual([buildReport(split.events).unmatched_edits, buildReport(split.events).themes!.filter((t) => t.edit)], [undefined, []], 'shown part by part');
});

test('a merge brings no hidden part back: a key stays hidden until a record names it, whatever happened to its neighbour', () => {
  const { events, record } = logOf(['/jobs', '/users']);
  const [jobs, users] = buildReport(events).themes!;
  record(hide(jobs));
  record(hide(users));
  record(hide(users, false));
  record(judged(events, [['g1', 'g2']]));
  const [merged] = buildReport(events).themes!;
  assert.equal(merged.edit?.hidden, true, 'showing /users said nothing about /jobs');
  assert.equal(buildReport(events).unmatched_edits, undefined);
  record(hide(merged, false));
  assert.equal(buildReport(events).themes![0].edit, undefined, 'and the team can show the whole');
});

test('an edit with no matching theme is listed and never dropped, the finding is back in exports, and a reset leaves no entry', () => {
  const { events, record } = logOf(['/jobs']);
  const [theme] = buildReport(events).themes!;
  record(hide(elsewhere(theme)));
  record(edit(elsewhere(theme), 'Words for a finding that went'));
  const report = buildReport(events);
  assert.deepEqual(report.unmatched_edits, [
    { title: 'A finding from an older grouping', hidden: false, new_title: 'Words for a finding that went', new_description: null },
    { title: 'A finding from an older grouping', hidden: true, new_title: null, new_description: null },
  ]);
  assert.equal(report.themes![0].edit, undefined);
  const shared = forSharing(report);
  assert.ok(!('unmatched_edits' in shared), 'it is for the team, not the file');
  assert.equal(shared.themes![0].title, theme.title, 'the finding is back in exports');
  record(hide(elsewhere(theme), false));
  record(edit(elsewhere(theme), null));
  assert.equal(buildReport(events).unmatched_edits, undefined);
});

test('a title never moves an edit, and an edit on a theme the evidence check set aside stays on it', () => {
  const { events, record } = logOf(['/jobs', '/users']);
  const themes = buildReport(events).themes!;
  record(hide({ ...elsewhere(themes[1]), title: themes[0].title }));
  assert.ok(buildReport(events).themes!.every((t) => !t.edit));
  record(hide(themes[0]));
  record({ ...none, poi_id: 'poi', type: 'report.checks', payload: { poi_id: 'poi', checks: [{ theme_id: themes[0].id, verdict: 'agent_mistake', reason: 'The persona erred.' }], keys: Object.fromEntries(themes.map((t) => [t.id, t.keys![0]])) } });
  const report = buildReport(events);
  assert.equal(report.set_aside?.[0].edit?.hidden, true);
  assert.equal(forSharing(report).set_aside, undefined, 'a hidden theme leaves the set-aside list too');
  assert.ok(!reportToMarkdown(forSharing(report)).includes(themes[0].title));
});

test('edits change nothing the run found: a report built with and without them differs only in the new fields', () => {
  const { events, record } = logOf(['/jobs', '/users', '/teams']);
  const clean = structuredClone(events);
  const themes = buildReport(events).themes!;
  record(hide(themes[0]));
  record(edit(themes[1], 'Our words', 'Our description'));
  record(hide(elsewhere(themes[2])));
  const [plain, edited] = [buildReport(clean), buildReport(events)];
  const strip = ({ unmatched_edits: _, ...report }: Report) => ({ ...report, themes: report.themes?.map(({ edit: _e, ...theme }) => theme) });
  assert.deepEqual(strip(edited), strip(plain));
  assert.equal(writtenSummary(edited), writtenSummary(plain));
  assert.equal(reportToMarkdown(edited), reportToMarkdown(plain), 'report.md stays the run\'s record');
});

test('a report with no edits exports as it was, and an old log has none of the new fields', () => {
  const { events } = logOf(['/jobs', '/users']);
  const report = buildReport(events);
  assert.deepEqual(forSharing(report), report);
  assert.equal(reportToMarkdown(forSharing(report)), reportToMarkdown(report));
  for (const field of ['shared', 'unmatched_edits'] as const) assert.ok(!(field in forSharing(report)), field);
  assert.ok(report.themes!.every((t) => !('edit' in t) && !('reworded' in t)));
  assert.deepEqual(forSharing({ ...report, themes: undefined }), { ...report, themes: undefined }, 'a report from before themes');
});

/** Every place a finding can reach: a persona's words and ending, a feed post, a plan, an outcome and a suggestion, for one finding to hide and one to keep. */
function everywhere() {
  const { events, record } = logOf([]);
  events.pop(); // the run's end comes last
  const url = (path: string) => ({ url_before: page(path), url_after: page(path) });
  const step = (step_no: number, path: string, thought: string): NewEvent => ({ ...who, type: 'persona.step', payload: { step_no, action: { type: 'click', ref: 'e1', text: null }, target: { role: 'button', name: `Save on ${path}`, box: null }, result: { ok: true, ...url(path), error: null, dom_changed: false }, thought, feeling: -1, snapshot_hash: 'h', screenshot: null, duration_ms: 1, heard_post_ids: [] } }) as NewEvent;
  const friction = (step_no: number, path: string, what: string): NewEvent => ({ ...who, type: 'persona.friction_reported', payload: { step_no, severity: 3, what, expected: `Expected ${what}`, where: { url: page(path), ref: null }, heard_post_ids: [] } });
  const post = (post_id: string, text: string): NewEvent => ({ ...who, poi_id: null, type: 'social.post', payload: { post_id, parent_id: null, text, about_poi_id: 'poi' } });
  for (const event of [
    step(1, '/jobs', 'HIDDEN-QUOTE of the persona at the save button'),
    friction(1, '/jobs', 'HIDDEN-WHAT the save button does nothing'),
    { ...who, type: 'persona.abandoned', payload: { step_no: 1, reason: 'HIDDEN-ENDING gave up on saving' } } as NewEvent,
    step(2, '/users', 'KEPT-QUOTE of the persona on the users page'),
    friction(2, '/users', 'KEPT-WHAT the users table is empty'),
    post('p1', 'HIDDEN-POST the save button is broken'),
    post('p2', 'HIDDEN-SECOND-POST saving and the users table both let me down'),
    post('p3', 'KEPT-POST the users table is empty'),
    { ...who, type: 'persona.survey', payload: { poi_id: 'poi', sentiment: -1, confidence: 0.5, likes: [], frictions: ['HIDDEN-OBJECTION it costs too much', 'KEPT-OBJECTION no trial'], would_continue: false, reason: 'HIDDEN-SURVEY-REASON', buyer: { would_buy: false, price: 'high', objections: ['HIDDEN-OBJECTION it costs too much', 'KEPT-OBJECTION no trial'], unclear: [] } } } as NewEvent,
  ]) record(event);
  const first = buildReport(events).themes!;
  const of = (text: string) => first.find((t) => t.evidence.some((e) => e.what.includes(text)))!;
  const [saving, table, costly, trial] = [of('HIDDEN-WHAT'), of('KEPT-WHAT'), of('HIDDEN-OBJECTION'), of('KEPT-OBJECTION')];
  const keys = Object.fromEntries(first.map((t) => [t.id, t.keys![0]]));
  record({ ...none, poi_id: 'poi', type: 'report.themes', payload: {
    poi_id: 'poi', keys,
    themes: [
      { title: 'HIDDEN-TITLE saving does nothing', description: 'HIDDEN-DESCRIPTION of the save button', group_ids: [saving.id] },
      { title: 'KEPT-TITLE the table is empty', description: 'KEPT-DESCRIPTION of the table', group_ids: [table.id] },
      { title: 'HIDDEN-PRICE-TITLE too dear', description: 'HIDDEN-PRICE-DESCRIPTION', group_ids: [costly.id] },
      { title: 'KEPT-TRIAL-TITLE no trial', description: 'KEPT-TRIAL-DESCRIPTION', group_ids: [trial.id] },
    ],
    posts: [{ post_id: 'p1', group_ids: [saving.id] }, { post_id: 'p2', group_ids: [saving.id, table.id] }, { post_id: 'p3', group_ids: [table.id] }],
  } });
  record({ ...none, poi_id: 'poi', type: 'report.suggestions', payload: { poi_id: 'poi', suggestions: [
    { theme_id: saving.id, change: 'HIDDEN-SUGGESTION rename the button', solution: 'HIDDEN-SOLUTION' },
    { theme_id: table.id, change: 'KEPT-SUGGESTION fill the table', solution: 'KEPT-SOLUTION' },
  ] } });
  const named = buildReport(events).themes!;
  const hiddenTheme = named.find((t) => t.title.startsWith('HIDDEN-TITLE'))!;
  const keptTheme = named.find((t) => t.title.startsWith('KEPT-TITLE'))!;
  const priced = named.find((t) => t.title.startsWith('HIDDEN-PRICE'))!;
  const planned = (t: ReportTheme) => ({ id: t.id, keys: t.keys!, poi_id: t.poi_id, title: t.title, description: t.description, quotes: [] });
  record({ ...none, type: 'report.study', payload: {
    answer: { screener: ['Do you hire?'], themes: [{ theme_id: hiddenTheme.id, tasks: ['HIDDEN-TASK post a role'], observe: ['HIDDEN-OBSERVE the save button'] }, { theme_id: keptTheme.id, tasks: ['KEPT-TASK add someone'], observe: ['KEPT-OBSERVE the table'] }] },
    themes: [planned(hiddenTheme), planned(keptTheme)],
    left_out: { objections: 0, competitors: 0, set_aside: 0, scan_only: 0, lower_ranked: 0 },
  } });
  const { payload, ...e } = finding(hiddenTheme);
  record({ ...e, type: 'finding.validated', payload: { ...payload, status: 'contradicted', note: 'HIDDEN-NOTE', study_date: '2026-10-12' } });
  record({ ...e, type: 'finding.validated', payload: { ...payload, keys: ['["poi",null,"kind","gone"]'], status: 'unresolved', note: 'HIDDEN-LEFTOVER-NOTE', study_date: '2026-10-12' } });
  record(hide(hiddenTheme));
  record(hide(priced));
  record({ ...none, type: 'run.finished', payload: {} });
  return { events, record, hiddenTheme, keptTheme };
}

test('a hidden theme survives nowhere in the copy, in Markdown or JSON, and what is kept stays', () => {
  const { events } = everywhere();
  const report = buildReport(events);
  assert.ok(JSON.stringify(report).includes('HIDDEN-'), 'the report itself keeps the original');
  const shared = forSharing(report);
  for (const [format, text] of [['json', JSON.stringify(shared)], ['md', reportToMarkdown(shared)]] as const) {
    assert.deepEqual([...text.matchAll(/HIDDEN-[A-Z-]+/g)].map(([word]) => word), [], `${format} has no trace`);
    for (const kept of ['KEPT-TITLE', 'KEPT-DESCRIPTION', 'KEPT-QUOTE', 'KEPT-WHAT', 'KEPT-SUGGESTION', 'KEPT-POST', 'KEPT-TASK', 'KEPT-OBSERVE', 'KEPT-OBJECTION']) assert.ok(text.includes(kept), `${format} keeps ${kept}`);
  }
  assert.deepEqual(shared.shared, { hidden: 2, reworded: 0 });
  assert.equal(shared.study_count, undefined, 'the only studied finding is gone, so no count stands for it');
  assert.ok(writtenSummary(shared)!.includes('KEPT-TITLE'));
  assert.ok(shared.spread![0].seeds.every((post) => !post.text.includes('HIDDEN')), 'and the feed posts the judge tagged with it');
  assert.ok(studyPlanToMarkdown(shared, shared.study_plan!).includes(sharedText(shared.shared!)), 'the plan on its own says so too');
  assert.deepEqual(shared.personas, report.personas.map((p) => ({ ...p, outcome_text: null })), 'a persona keeps its outcome, without words that belong to the hidden finding');
  for (const field of ['weighted', 'segments', 'steps', 'cost_usd', 'coverage', 'flows', 'reach', 'sentiment'] as const) assert.deepEqual(shared[field], report[field], `${field} is from the run`);
});

test('a hidden theme survives nowhere: an outcome a rejudge left over goes with the finding its keys overlap, whatever title it was recorded under', () => {
  const studied = () => {
    const { events, record } = logOf(['/jobs', '/users', '/teams']);
    record(judged(events, [['g1'], ['g2'], ['g3']], (i) => `STUDIED-OLD-TITLE ${i}`));
    const [a, b] = buildReport(events).themes!;
    for (const [theme, note] of [[a, 'NOTE-ABOUT-A'], [b, 'NOTE-ABOUT-B']] as const) {
      const { payload, ...e } = finding(theme);
      record({ ...e, type: 'finding.validated', payload: { ...payload, status: 'supported', note, study_date: '2026-10-12' } });
    }
    record(judged(events, [['g1', 'g2'], ['g3']], (i) => `Later name ${i}`));
    return { events, record, merged: buildReport(events).themes!.find((t) => t.id === 'g1+g2')! };
  };
  const hidden = studied();
  assert.deepEqual(buildReport(hidden.events).unmatched_outcomes?.map((o) => o.title), ['STUDIED-OLD-TITLE 0'], 'the newest sits on the merged theme, and the other is left over');
  hidden.record(hide(hidden.merged));
  const shared = forSharing(buildReport(hidden.events));
  for (const text of [JSON.stringify(shared), reportToMarkdown(shared)]) assert.deepEqual([...text.matchAll(/STUDIED-OLD-TITLE \d|NOTE-ABOUT-\w/g)].map(([word]) => word), []);
  assert.equal(shared.unmatched_outcomes, undefined);

  const reworded = studied();
  reworded.record(edit(reworded.merged, 'OUR-WORDS'));
  const report = buildReport(reworded.events);
  const copy = forSharing(report);
  assert.deepEqual(copy.unmatched_outcomes?.map((o) => [o.title, o.note]), [['OUR-WORDS', 'NOTE-ABOUT-A']], 'a reworded finding takes its words there too');
  assert.ok(!reportToMarkdown(copy).includes('STUDIED-OLD-TITLE'));

  const older = { ...report, unmatched_outcomes: [{ status: 'supported' as const, note: null, study_date: '2026-10-12', title: reworded.merged.title, poi_id: 'poi' }] };
  assert.equal(forSharing(older).unmatched_outcomes?.[0].title, 'OUR-WORDS', 'a report from before these keys goes by its title');
});

test('with a finding hidden the summary speaks of the copy, as what leads it need not be what led the run', () => {
  const { events, record } = logOf(['/jobs', '/users']);
  const [top, second] = buildReport(events).themes!;
  record(edit(second, 'Our words'));
  assert.match(writtenSummary(forSharing(buildReport(events)))!, /^The biggest problem in this run is “/, 'a rewording leaves nothing out');
  record(hide(top));
  const shared = forSharing(buildReport(events));
  assert.match(writtenSummary(shared)!, /^The biggest problem left in this copy is “Our words”/);
  assert.doesNotMatch(writtenSummary(shared)!, /in this run/);
  const objections = { ...shared, themes: shared.themes!.map((t) => ({ ...t, category: 'objection' as const })) };
  assert.match(writtenSummary(objections)!, /The top objection left in this copy is “Our words”/);
});

test('a copy keeps its ranks, and a thought shared with a kept finding goes with the hidden one', () => {
  const { events, record } = logOf(['/jobs', '/users', '/teams']);
  const themes = buildReport(events).themes!;
  record(hide(themes[1]));
  const report = buildReport(events);
  assert.deepEqual(forSharing(report).themes!.map((t) => t.rank), [1, 3], 'a number from the run stays');
  report.themes![1].evidence[0].quote = 'One thought at two findings';
  report.themes![2].evidence[0].quote = 'One thought at two findings';
  report.frictions[2].quote = 'One thought at two findings';
  const shared = forSharing(report);
  assert.equal(shared.themes![1].evidence[0].quote, '');
  assert.ok(!JSON.stringify(shared).includes('One thought'));
  assert.ok(!reportToMarkdown(shared).includes('Quote: ""'), 'an empty quote prints nothing');
});

test('hiding everything does not read as nothing having been found', () => {
  const { events, record } = logOf(['/jobs']);
  record(hide(buildReport(events).themes![0]));
  const shared = forSharing(buildReport(events));
  assert.ok(writtenSummary(shared)!.includes(HIDDEN_ALL));
  const markdown = reportToMarkdown(shared);
  assert.ok(markdown.includes(HIDDEN_ALL));
  assert.doesNotMatch(markdown, /No friction theme came up|No themes\. |No frictions reported/);
  assert.ok(markdown.includes(HIDDEN_FRICTIONS));
  assert.ok(markdown.includes('hid 1 finding from this copy and reworded 0 findings'));
});

test('a reworded finding is marked and its new words reach everything that names it, and nothing else the run found moves', () => {
  const { events, record, keptTheme } = everywhere();
  const { payload, ...e } = finding(keptTheme);
  record({ ...e, type: 'finding.validated', payload: { ...payload, title: 'A title before the rejudge', status: 'supported', note: null, study_date: '2026-10-12' } });
  record(edit(keptTheme, 'OUR-TITLE', 'OUR-DESCRIPTION'));
  const report = buildReport(events);
  const shared = forSharing(report);
  assert.deepEqual(shared.shared, { hidden: 2, reworded: 1 });
  const theme = shared.themes!.find((t) => t.id === keptTheme.id)!;
  assert.deepEqual([theme.title, theme.description, theme.reworded], ['OUR-TITLE', 'OUR-DESCRIPTION', true]);
  assert.ok(!('edit' in theme), 'the file carries the wording, not the original beside it');
  const original = report.themes!.find((t) => t.id === keptTheme.id)!;
  const numbers = ({ rank, severity, score, trust, personas, frictions, prevalence, seqs }: ReportTheme) => ({ rank, severity, score, trust, personas, frictions, prevalence, seqs });
  assert.deepEqual(numbers(theme), numbers(original));
  for (const text of [JSON.stringify(shared), reportToMarkdown(shared)]) {
    assert.ok(!text.includes('KEPT-TITLE') && !text.includes('KEPT-DESCRIPTION'), 'the old words are in no place');
    assert.ok(!text.includes('A title before the rejudge'), 'nor what the outcome recorded');
  }
  assert.ok(reportToMarkdown(shared).includes(`OUR-TITLE\n\nReworded by the team.`));
  assert.ok(reportToMarkdown(shared).includes(sharedText({ hidden: 2, reworded: 1 })));
  assert.equal(shared.spread![0].themes[0].title, 'OUR-TITLE');
  assert.equal(shared.study_plan!.hypotheses[0].title, 'OUR-TITLE');
});

test('a rewording of the description alone keeps the title', () => {
  const { events, record } = logOf(['/jobs']);
  const [theme] = buildReport(events).themes!;
  record(edit(theme, null, 'Our description'));
  const [shared] = forSharing(buildReport(events)).themes!;
  assert.deepEqual([shared.title, shared.description, shared.reworded], [theme.title, 'Our description', true]);
});

test('a repeat set in a copy does not bring a reworded title back as what other runs named it', () => {
  const { events, record } = logOf(['/jobs']);
  const clean = structuredClone(events);
  record(edit(buildReport(events).themes![0], 'Our words'));
  const report = buildReport(events);
  const other = { ...buildReport(clean), run_id: 'r-2' };
  other.themes![0].title = 'Another run named it this';
  const set = combineReports([report, other]);
  const markdown = reportToMarkdown(forSharing(report), setForSharing(set, report));
  assert.ok(markdown.includes('Named in other runs: Another run named it this'));
  assert.ok(!markdown.includes(report.themes![0].title), 'the original stays out');
  assert.deepEqual(set.findings[0].titles, [report.themes![0].title, 'Another run named it this'], 'and the set itself reads the original');
});

test('repeat sets, comparisons and the gate read the originals', () => {
  const { events, record } = logOf(['/jobs', '/users']);
  const clean = structuredClone(events);
  const themes = buildReport(events).themes!;
  record(hide(themes[0]));
  record(edit(themes[1], 'Our words'));
  const [plain, edited, later] = [buildReport(clean), buildReport(events), { ...buildReport(clean), run_id: 'r-2' }];
  assert.deepEqual(combineReports([edited, later]), combineReports([plain, later]));
  assert.deepEqual(diffReports([edited], [later]), diffReports([plain], [later]));
  assert.deepEqual(gateDecision(diffReports([edited], [later])), gateDecision(diffReports([plain], [later])));
});

test('edits reach no model: not a rejudge, not its check, not a study plan, which all read the originals', async () => {
  const { events, record } = logOf(['/jobs', '/users']);
  const themes = buildReport(events).themes!;
  record(hide(themes[0]));
  record(edit(themes[1], 'SECRET-WORDS', 'SECRET-DESCRIPTION'));
  const sent: string[] = [];
  const spy = (answer: Responder): Responder => (req) => {
    sent.push(JSON.stringify([req.system, req.shared, req.user]));
    return answer(req);
  };
  const judge: Responder = (req) => {
    if (req.purpose === 'report_check') return { checks: [] };
    const { groups = [] } = JSON.parse(req.user[0].type === 'text' ? req.user[0].text : '{}') as { groups?: { id: string }[] };
    return { themes: groups.map((g, i) => ({ title: `Name ${i}`, description: 'A description.', group_ids: [g.id] })) };
  };
  const llm: LlmGateway = createScriptedGateway({ judge: spy(judge), author: spy(DEMO_AUTHOR) }, record);
  const blobs: BlobStore = { put: async () => {}, get: async () => { throw new Error('ENOENT'); } };
  await runReportModels({ config, round: 1, llm, blobs, record, events: () => events, check: true });
  await runStudyPlan({ config, report: buildReport(events), round: 1, llm, record });
  assert.ok(sent.length >= 4, `judge, check, author and study calls: ${sent.length}`);
  const everything = sent.join('\n');
  assert.ok(!everything.includes('SECRET'));
  assert.doesNotMatch(everything, /new_title|new_description|reworded/);
  assert.ok(everything.includes('Name 0'), 'a hidden finding is still in what they read');
  assert.equal(buildReport(events).themes!.filter((t) => t.edit).length, 2, 'and the rejudge kept both edits, as they are in the log');
});

test('a copy keeps no picture of a hidden finding, and a kept finding keeps its own', () => {
  const { events, record } = logOf([]);
  events.pop(); // run.finished, recorded again after the steps
  ['/jobs', '/users'].forEach((path, i) => {
    const step_no = i + 1;
    record({ ...who, type: 'persona.step', payload: { step_no, action: { type: 'click', ref: 'e1', text: null }, target: { role: 'button', name: 'Save', box: null }, result: { ok: true, url_before: page(path), url_after: page(path), dom_changed: true, error: null }, thought: 'Saving.', feeling: 0, snapshot_hash: 'h', screenshot: `shots/SHOT-${path.slice(1)}.jpg`, duration_ms: 1, heard_post_ids: [] } });
    record({ ...who, type: 'persona.friction_reported', payload: { step_no, severity: 3, what: `The save button on ${path} does nothing at all`, expected: 'Saved', where: { url: page(path), ref: null }, heard_post_ids: [] } });
  });
  record({ ...none, type: 'run.finished', payload: {} });
  const [jobs, users] = buildReport(events).themes!;
  assert.deepEqual([jobs.pictures?.[0].screenshot, users.pictures?.[0].screenshot], ['shots/SHOT-jobs.jpg', 'shots/SHOT-users.jpg']);
  record(hide(jobs));
  const shared = forSharing(buildReport(events));
  assert.ok(!JSON.stringify(shared).includes('SHOT-jobs'), 'the hidden finding\'s picture is gone with it');
  assert.deepEqual(shared.themes?.map((t) => t.pictures?.map((p) => p.screenshot)), [['shots/SHOT-users.jpg']]);
});
