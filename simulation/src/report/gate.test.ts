import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Report, ReportTheme } from '../types.ts';
import { diffReports } from './diff.ts';
import { gateDecision, severeSightings } from './gate.ts';
import { gateToMarkdown } from './markdown.ts';

const key = (name: string) => JSON.stringify(['web', `gym.test/${name}`, 'element', `button "${name}"`]);
const theme = (title: string, keys: string[], severity = 3): ReportTheme => ({
  id: `t-${title}`, poi_id: 'web', rank: 1, title, description: '', named_by: 'judge', trust: 'reported', severity, score: 0, personas: 3, frictions: 3,
  pages: [], elements: [], affected: [], evidence: [], seqs: [], suggestion: null, keys: keys.map(key),
});
const report = (run_id: string, themes: ReportTheme[], over: Partial<Report> = {}): Report => ({
  run_id, status: 'finished', stop_reason: null, themes, pois: [{ id: 'web', name: 'Gym' }], segments: [], personas: [{ id: 'p-1', name: 'One', segment_id: null, outcome: 'done' }],
  methods: { models: { navigator: { provider: 'anthropic', model: 'claude-a' } } }, reach: [{ poi_id: 'web', started: ['p-1'], surveyed: ['p-1'], pages: {} }], ...over,
}) as unknown as Report;
/** One repeat set: a run per list of themes. */
const set = (group: string, ...runs: ReportTheme[][]) => runs.map((themes, i) => report(`${group}-${i + 1}`, themes, { repeat: { group, index: i + 1, of: runs.length } }));

const OLD = theme('Save does nothing', ['save']);
const NEW = theme('Checkout loses the cart', ['cart']);
const base = () => set('base', [OLD], [OLD], [OLD]);
const decide = (before: Report[], after: Report[]) => gateDecision(diffReports(before, after));
const titles = (themes: { after_title: string | null }[]) => themes.map((row) => row.after_title);

test('the same themes on both sides pass, and the pass claims nothing about people', () => {
  const gate = decide(base(), set('later', [OLD], [OLD], [OLD]));
  assert.deepEqual([gate.decision, gate.failing, gate.warnings, gate.reasons], ['passed', [], [], []]);
  assert.deepEqual(gate.run, ['later-1', 'later-2', 'later-3']);
  assert.match(gateToMarkdown(gate), /^# Gnomi gate: passed\n/);
  assert.ok(gateToMarkdown(gate).includes('> No new high-severity theme in these simulated runs. This does not show that people will not hit one.'));
});

test('a new high-severity theme seen in two later runs fails, and names the runs behind it', () => {
  const gate = decide(base(), set('later', [OLD, NEW], [OLD, NEW], [OLD]));
  assert.equal(gate.decision, 'failed');
  assert.deepEqual(titles(gate.failing), [NEW.title]);
  assert.deepEqual(gate.failing[0].sightings, [{ run_id: 'later-1', severity: 3 }, { run_id: 'later-2', severity: 3 }]);
  assert.deepEqual(gate.warnings, []);
  const text = gateToMarkdown(gate);
  assert.match(text, /^# Gnomi gate: failed\n/);
  assert.match(text, /\*\*Checkout loses the cart\*\*, high severity in 2 of 3 later runs: was in 0 of 3 runs, now in 2 of 3 runs\./);
  assert.match(text, /hypothesis to check, not evidence about real users/);
});

test('seen in one later run it warns and passes', () => {
  const gate = decide(base(), set('later', [OLD, NEW], [OLD], [OLD]));
  assert.equal(gate.decision, 'passed');
  assert.deepEqual([gate.failing, titles(gate.warnings)], [[], [NEW.title]]);
  const text = gateToMarkdown(gate);
  assert.match(text, /## Warnings \(1\)[\s\S]*Checkout loses the cart/);
  assert.doesNotMatch(text, /Some of those runs/, 'one sighting has nothing to be loosely tied to');
});

test('a pass with warnings does not deny the new high-severity theme it lists', () => {
  const text = gateToMarkdown(decide(base(), set('later', [OLD, NEW], [OLD], [OLD])));
  assert.ok(text.includes('> No new high-severity problem clearly came back in at least 2 of these simulated runs. This does not show that people will not hit one.'));
  assert.ok(!text.includes('No new high-severity theme in these simulated runs'));
});

test('below high severity a new theme neither fails nor warns, and high severity is the rounded tier, in any run order', () => {
  const low = theme('A label is unclear', ['label'], 2);
  const quiet = decide(base(), set('later', [OLD, low], [OLD, low], [OLD, low]));
  assert.deepEqual([quiet.decision, quiet.warnings], ['passed', []]);
  const median = theme('Search is slow', ['search'], 2.5);
  assert.equal(decide(base(), set('later', [OLD, median], [OLD, median], [OLD])).decision, 'failed');
  const firstLow = decide(base(), set('later', [OLD, low], [OLD, theme('A label is unclear', ['label'], 3)], [OLD, theme('A label is unclear', ['label'], 4)]));
  assert.equal(firstLow.decision, 'failed', 'the first run\'s severity alone would pass this');
  assert.equal(severeSightings(firstLow.failing[0]).length, 2);
  const onceHigh = decide(base(), set('later', [OLD, theme('A label is unclear', ['label'], 3)], [OLD, low], [OLD, low]));
  assert.deepEqual([onceHigh.decision, titles(onceHigh.warnings)], ['passed', ['A label is unclear']], 'high severity in one run is one sighting, however many runs saw it lower');
});

test('runs tied by one shared key are not two sightings, and a weak tie to an earlier theme warns rather than fails', () => {
  const shared = (title: string, own: string) => theme(title, ['settings', `${own}-a`, `${own}-b`]);
  const [one, other] = [shared('Invite form rejects the email', 'invite'), shared('Approval toggle does nothing', 'toggle')];
  const gate = decide(base(), set('later', [OLD, one], [OLD, other], [OLD]));
  assert.deepEqual(gate.failing, [], 'two problems at one link');
  assert.equal(gate.decision, 'passed');
  assert.deepEqual(gate.warnings[0].sightings?.map(({ weak }) => weak), [true, true]);
  assert.match(gateToMarkdown(gate), /Some of those runs only share one place on a page/);

  const tied = decide(set('base', [one], [one], [one]), set('later', [other], [other], [other]));
  assert.equal(tied.decision, 'passed');
  assert.deepEqual([tied.warnings[0].status, tied.warnings[0].weak], ['unchanged', true]);
  assert.match(gateToMarkdown(tied), /may be different problems/);
});

/** Every order of a list. */
const orders = <T>(items: T[]): T[][] => (items.length < 2 ? [items] : items.flatMap((item, i) => orders(items.toSpliced(i, 1)).map((rest) => [item, ...rest])));

test('the verdict does not depend on which later run came first', () => {
  const shared = (title: string, own: string, severity = 3) => theme(title, ['settings', `${own}-a`, `${own}-b`], severity);
  const [real, other] = [shared('Invite form rejects the email', 'invite'), shared('Approval toggle does nothing', 'toggle')];
  const verdicts = (runs: ReportTheme[][]) => new Set(orders(runs).map((order) => decide(base(), set('later', ...order.map((themes) => [OLD, ...themes]))).decision));
  assert.deepEqual([...verdicts([[other], [real], [real]])], ['failed'], 'two strong sightings, whichever run shares one key with them');
  assert.deepEqual([...verdicts([[other], [shared('Billing page is blank', 'billing')], [real]])], ['passed'], 'three loose sightings stay three problems');
  assert.deepEqual([...verdicts([[other], [real], [shared('Invite form rejects the email', 'invite', 1)]])], ['passed'], 'the strong tie must be between two high-severity sightings');

  const gate = decide(base(), set('later', [OLD, other], [OLD, real], [OLD, real]));
  assert.deepEqual(gate.failing[0].sightings, [{ run_id: 'later-1', severity: 3, weak: true }, { run_id: 'later-2', severity: 3 }, { run_id: 'later-3', severity: 3 }], 'the first run is the one that is weak');
});

test('a new high-severity objection warns however often it comes back, and a friction beside it still fails', () => {
  const objection: ReportTheme = { ...theme('Too dear for a small team', ['price']), category: 'objection' };
  const gate = decide(base(), set('later', [OLD, objection], [OLD, objection], [OLD, objection]));
  assert.deepEqual([gate.decision, titles(gate.warnings)], ['passed', [objection.title]]);
  assert.match(gateToMarkdown(gate), /No new high-severity problem clearly came back/);
  assert.match(gateToMarkdown(gate), /This is an objection, a reason not to adopt, so it never fails a build\./);
  const both = decide(base(), set('later', [OLD, objection, NEW], [OLD, objection, NEW], [OLD]));
  assert.deepEqual([both.decision, titles(both.failing), titles(both.warnings)], ['failed', [NEW.title], [objection.title]]);
});

test('a theme that reads not retested does not fail', () => {
  const [before, after] = [set('base', [OLD, NEW], [OLD, NEW], [OLD, NEW]), set('later', [OLD], [OLD], [OLD])];
  assert.deepEqual(diffReports(before, after).themes.map(({ status }) => status), ['unchanged', 'not_retested']);
  const gate = decide(before, after);
  assert.deepEqual(gate.warnings, []);
  assert.deepEqual([gate.decision, gate.failing], ['passed', []]);
});

test('too few finished runs on a side cannot decide, and an old run with no repeat set is one run', () => {
  const short = decide(base(), set('later', [OLD, NEW], [OLD, NEW]));
  assert.equal(short.decision, 'could_not_decide');
  assert.deepEqual(short.reasons, ['The later side has 2 finished runs, and the gate needs 3 from one repeat set.']);
  assert.deepEqual(titles(short.failing), [NEW.title], 'what would have failed stays visible');
  assert.match(gateToMarkdown(short), /could not decide[\s\S]*this is not a pass[\s\S]*## Why it could not decide[\s\S]*## Would have failed \(1\)/);
  const old = decide([report('r-0001', [OLD])], set('later', [OLD], [OLD], [OLD]));
  assert.deepEqual(old.reasons, ['The earlier side has 1 finished run, and the gate needs 3 from one repeat set.']);
});

test('a side that was stopped cannot decide, even with enough finished runs', () => {
  const planned = (run: Report, of: number) => ({ ...run, repeat: { ...run.repeat!, of } });
  const cut = decide(base(), set('later', [OLD], [OLD], [OLD]).map((run) => planned(run, 5)));
  assert.equal(cut.decision, 'could_not_decide');
  assert.match(cut.reasons.join(), /Only 3 of the 5 runs of the later set are compared/);
  const lone = decide(base(), [report('r-9', [], { status: 'stopped', stop_reason: 'cost_budget' })]);
  assert.match(lone.reasons.join(), /r-9 stopped early \(cost_budget\)/);
  const trait_free = decide(base(), set('later', [OLD], [OLD], [OLD]).map((run) => ({ ...run, repeat: { ...run.repeat!, of: 4, trait_free: 4 } })));
  assert.equal(trait_free.decision, 'passed', 'a planned trait-free run is in no count');
});

test('sides that differ in model, personas, goal or POIs cannot decide, and each says why', () => {
  const later = () => set('later', [OLD], [OLD], [OLD]);
  const model = decide(base(), later().map((run) => ({ ...run, methods: { models: { navigator: { provider: 'deepseek' as const, model: 'deepseek-v4-pro' } } } as Report['methods'] })));
  assert.equal(model.decision, 'could_not_decide');
  assert.match(model.reasons.join(), /navigator ran on anthropic:claude-a in the earlier run and deepseek:deepseek-v4-pro/);
  const alias = decide(base().map((run) => ({ ...run, methods: { ...run.methods, response_models: { navigator: ['claude-a-1'] } } })), later().map((run) => ({ ...run, methods: { ...run.methods, response_models: { navigator: ['claude-a-2'] } } })));
  assert.match(alias.reasons.join(), /answered as claude-a-1 in the earlier run and claude-a-2/);
  const personas = decide(base(), later().map((run) => ({ ...run, personas: [{ ...run.personas[0], id: 'p-2' }] })));
  assert.match(personas.reasons.join(), /different personas/);
  const pois = decide(base(), later().map((run) => ({ ...run, pois: [{ id: 'other', name: 'Other' }] as Report['pois'] })));
  assert.match(pois.reasons.join(), /did not try Gym/);
  const goal = decide(base().map((run) => ({ ...run, goal: 'Pick a plan' })), later().map((run) => ({ ...run, goal: 'Cancel my plan' })));
  assert.deepEqual(goal.reasons, ['The two sides have different goals, so a change may come from what they tried rather than the build.']);
  assert.ok([alias, personas, pois, goal].every(({ decision }) => decision === 'could_not_decide'));
});

test('personas with the same ids and names but other traits cannot decide, and an old report with no fingerprint is not held against it', () => {
  const printed = (runs: Report[], personas_fingerprint: string) => runs.map((run) => ({ ...run, personas_fingerprint }));
  const later = () => set('later', [OLD], [OLD], [OLD]);
  const rewritten = decide(printed(base(), 'a'), printed(later(), 'b'));
  assert.equal(rewritten.decision, 'could_not_decide');
  assert.deepEqual(rewritten.reasons, ['The two sides have different personas, so a change may come from who tried it rather than the build.']);
  assert.equal(decide(printed(base(), 'a'), printed(later(), 'a')).decision, 'passed');
  assert.equal(decide(base(), printed(later(), 'b')).decision, 'passed');
});

test('a side no persona got through says nothing, so three silent runs are no pass', () => {
  const silent = set('later', [], [], []).map((run) => ({ ...run, personas: [{ ...run.personas[0], outcome: 'model_failed' as const }] }));
  const gate = decide(base(), silent);
  assert.equal(gate.decision, 'could_not_decide');
  assert.match(gate.reasons.join(), /No persona in later-1 got a valid answer from the model/);
});
