import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repeatsToMarkdown } from './markdown.ts';
import { combineReports } from './repeats.ts';
import type { ModelChoice, Report, ReportTheme } from '../types.ts';

const key = (name: string) => JSON.stringify(['web', `gym.test/${name}`, 'element', `button "${name}"`]);
const theme = (id: string, title: string, keys: string[], over: Partial<ReportTheme> = {}): ReportTheme => ({
  id, poi_id: 'web', rank: 1, title, description: '', named_by: 'judge', trust: 'reported', severity: 2, score: 0, personas: 1, frictions: 1,
  pages: [], elements: [], affected: [], evidence: [], seqs: [], suggestion: null, keys: keys.map(key), ...over,
});
const ANTHROPIC: ModelChoice = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
const DEEPSEEK: ModelChoice = { provider: 'deepseek', model: 'deepseek-v4-pro' };
const run = (index: number, themes: ReportTheme[] | undefined, over: Partial<Report> & { navigator?: ModelChoice; of?: number } = {}): Report => {
  const { navigator = ANTHROPIC, of = 3, ...rest } = over;
  return { run_id: `r-${index}`, repeat: { group: 'set-a', index, of }, status: 'finished', themes, methods: { models: { navigator } }, ...rest } as unknown as Report;
};
const seen = (set: ReturnType<typeof combineReports>) => set.findings.map((f) => [f.titles[0], f.seen_in, f.of]);

test('three runs: a problem counts by what it is, not by its id or rank, and a theme seen once stays a finding', () => {
  const set = combineReports([
    run(1, [theme('g1', 'Save does nothing', ['save']), theme('g2', 'Prices are hidden', ['price'], { rank: 2 })]),
    run(2, [theme('g4', 'Plans have no price', ['price']), theme('g9', 'The job form loses work', ['save'], { rank: 2 })]),
    run(3, [theme('g2+g3', 'Saving fails silently', ['save']), theme('g5', 'Candidates page is only a placeholder', ['list'], { rank: 2 })]),
  ]);
  assert.deepEqual(seen(set), [['Save does nothing', 3, 3], ['Prices are hidden', 2, 3], ['Candidates page is only a placeholder', 1, 3]]);
  assert.deepEqual(set.findings[0].titles, ['Save does nothing', 'The job form loses work', 'Saving fails silently']);
  assert.deepEqual(set.findings[0].themes, { 'r-1': 'g1', 'r-2': 'g9', 'r-3': 'g2+g3' });
  assert.deepEqual([set.group, set.of, set.compared, set.incomplete], ['set-a', 3, 3, false]);
});

test('a theme one run split in two counts once for that run, and its other part is a finding of its own', () => {
  const merged = (id: string) => theme(id, 'Forms lose work', ['x', 'y']);
  const set = combineReports([
    run(1, [merged('g1')]),
    run(2, [theme('g2', 'Part x', ['x'], { rank: 1 }), theme('g3', 'Part y', ['y'], { rank: 2 })]),
    run(3, [merged('g7')]),
  ]);
  assert.deepEqual(seen(set), [['Forms lose work', 3, 3], ['Part y', 1, 3]]);
  assert.ok(set.findings.every((f) => f.seen_in <= f.of), 'one to one per run');
  assert.equal(Object.keys(set.findings[0].themes).length, 3);
});

test('a partial set compares the runs that finished and says so: a stopped run missing a theme says nothing about it', () => {
  const save = theme('g1', 'Save does nothing', ['save']);
  const stopped = combineReports([run(1, [save]), run(2, [save]), run(3, [], { status: 'stopped' })]);
  assert.deepEqual(seen(stopped), [['Save does nothing', 2, 2]]);
  assert.deepEqual([stopped.of, stopped.compared, stopped.incomplete], [3, 2, true]);
  const short = combineReports([run(1, [save])]);
  assert.deepEqual([short.of, short.compared, short.incomplete], [3, 1, true]);
  assert.match(repeatsToMarkdown(short), /Incomplete set: 1 of 3 runs finished/);
  const running = combineReports([run(1, [save]), run(2, [save], { status: 'running' })]);
  assert.equal(running.compared, 1, 'a run still going is not compared yet');
  assert.deepEqual([running.running, running.incomplete], [true, false], 'still going is not ended early');
  assert.match(repeatsToMarkdown(running), /1 of 3 runs finished so far\./);
  assert.doesNotMatch(repeatsToMarkdown(running), /Incomplete/);
  const between = combineReports([run(1, [save])], true);
  assert.deepEqual([between.running, between.incomplete], [true, false], 'the process running the set knows it goes on between two runs');
  assert.match(repeatsToMarkdown(between), /1 of 3 runs finished so far\./);
  assert.deepEqual([short.running, stopped.running], [false, false]);
  assert.deepEqual(combineReports([run(1, [], { status: 'stopped' })]).findings, []);
  assert.deepEqual(combineReports([]), { group: null, of: 0, compared: 0, running: false, incomplete: false, families: [], findings: [] });
});

test('each finding names the model families it appeared under, a family being the provider or a local model', () => {
  const save = theme('g1', 'Save does nothing', ['save']);
  const price = theme('g2', 'Prices are hidden', ['price'], { rank: 2 });
  const set = combineReports([run(1, [save, price]), run(2, [save, price]), run(3, [save], { navigator: DEEPSEEK })]);
  assert.deepEqual(set.families, ['anthropic', 'deepseek']);
  assert.deepEqual(set.findings.map((f) => f.families), [['anthropic', 'deepseek'], ['anthropic']]);
  const local = combineReports([run(1, [save], { navigator: { provider: 'openai_compatible', model: 'llama-4' } }), run(2, [save], { navigator: { provider: 'openai_compatible', model: 'qwen-4' } })]);
  assert.deepEqual(local.families, ['llama-4', 'qwen-4'], 'one endpoint can serve any family');
  assert.deepEqual(combineReports([run(1, [save], { methods: { models: {} } as Report['methods'] })]).families, ['unknown']);
});

test('old runs have no repeat field and may have no themes: they still combine, as a set of what was given', () => {
  const old = (id: string, themes?: ReportTheme[]) => { const { repeat: _, ...report } = run(1, themes, { run_id: id }); return report as Report; };
  const set = combineReports([old('r-1', [theme('g1', 'Save does nothing', [], { keys: undefined })]), old('r-2', [theme('g1', 'Save does nothing', [], { keys: undefined })]), old('r-3')]);
  assert.deepEqual([set.group, set.of, set.incomplete], [null, 3, false]);
  assert.deepEqual(seen(set), [['Save does nothing', 2, 3]]);
});

test('the set page keeps the titles, escapes model text and speaks of robustness, never of confidence', () => {
  const set = combineReports([run(1, [theme('g1', 'Save | does nothing', ['save'])]), run(2, [theme('g4', '[The form](x) loses work', ['save'])], { navigator: DEEPSEEK })]);
  const md = repeatsToMarkdown({ ...set, of: 2, incomplete: false });
  assert.match(md, /^# Gnomi repeat set set-a/);
  assert.match(md, /2 runs compared\. Repeats test robustness inside the simulation/);
  assert.match(md, /\| Save \\\| does nothing \| 2 of 2 runs \| anthropic, deepseek \| \\\[The form\\\]\(x\) loses work \|/);
  assert.doesNotMatch(md, /confidence|validated/i);
});
