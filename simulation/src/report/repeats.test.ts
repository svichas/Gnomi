import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repeatNote, repeatsToMarkdown, TRAIT_FREE_TEXT } from './markdown.ts';
import { combineReports, isTraitFree } from './repeats.ts';
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

test('a set is over when its runs say so, however long the host holds it while the last report is written', () => {
  const save = theme('g1', 'Save does nothing', ['save']);
  const done = combineReports([run(1, [save], { of: 2 }), run(2, [save], { of: 2 })], true);
  assert.deepEqual([done.running, done.incomplete], [false, false], 'every run finished');
  assert.match(repeatsToMarkdown(done), /2 runs compared\./);
  const ended = combineReports([run(1, [save]), run(2, [], { status: 'stopped' })], true);
  assert.deepEqual([ended.running, ended.incomplete], [false, true], 'a stopped run ends its set');
  assert.match(repeatsToMarkdown(ended), /Incomplete set: 1 of 3 runs finished/);
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

/** Runs of a set with a trait-free run after them: the last run of `runs` plus one. */
const withControl = (runs: ReportTheme[][], control: ReportTheme[], over: Partial<Report> = {}) => {
  const of = runs.length + 1;
  const repeat = (index: number) => ({ group: 'set-a', index, of, trait_free: of });
  return [...runs.map((themes, i) => run(i + 1, themes, { repeat: repeat(i + 1) })), run(of, control, { repeat: repeat(of), ...over })];
};

test('a trait-free run is left out of every count of its set, and the set says so', () => {
  const save = theme('g1', 'Save does nothing', ['save']);
  const price = theme('g2', 'Prices are hidden', ['price'], { rank: 2 });
  const reports = withControl([[save, price], [save]], [theme('g5', 'Only the control saw this', ['other'])], { methods: { models: { navigator: DEEPSEEK } } as Report['methods'] });
  assert.deepEqual(reports.map(isTraitFree), [false, false, true]);
  const set = combineReports(reports);
  assert.deepEqual([set.of, set.compared, set.running, set.incomplete, set.families, set.trait_free], [2, 2, false, false, ['anthropic'], 'r-3']);
  assert.deepEqual(seen(set), [['Save does nothing', 2, 2], ['Prices are hidden', 1, 2]], 'the control\'s own theme adds no finding');
  assert.ok(set.findings.every((finding) => !('r-3' in finding.themes)));
  assert.match(repeatsToMarkdown(set), /2 runs compared\.[^\n]*One more run, of personas with no traits, is in no count here\./);
});

test('a finding the trait-free run also hit says so, keeps its place, and a weak match does not count', () => {
  const save = theme('g1', 'Save does nothing', ['save']);
  const price = theme('g2', 'Prices are hidden', ['price'], { rank: 2 });
  const plain = combineReports([run(1, [save, price], { repeat: undefined }), run(2, [save, price], { repeat: undefined })]);
  const set = combineReports(withControl([[save, price], [save, price]], [theme('g7', 'Plans have no price', ['price'])]));
  assert.deepEqual(set.findings.map((f) => [f.titles[0], f.seen_in, f.trait_free]), [['Save does nothing', 2, undefined], ['Prices are hidden', 2, true]]);
  assert.deepEqual(set.findings.map((f) => f.titles[0]), plain.findings.map((f) => f.titles[0]), 'the note changes no rank');

  const note = (finding: ReportTheme, runId = 'r-1') => repeatNote(set, runId, finding);
  assert.equal(note(price)?.trait_free, TRAIT_FREE_TEXT);
  assert.equal(note(price)?.appeared, 'Appeared in 2 of 2 runs');
  assert.equal(note(save)?.trait_free, null);
  assert.match(repeatsToMarkdown(set), /\| Prices are hidden \| 2 of 2 runs\. Personas with no traits hit this too, so it may say more about the model than this audience \|/);

  const wide = (id: string, title: string, own: string) => theme(id, title, ['settings', `${own}-a`, `${own}-b`]);
  const weak = combineReports(withControl([[wide('g1', 'Invite form rejects the email', 'invite')], [wide('g1', 'Invite form rejects the email', 'invite')]], [wide('g7', 'Approval toggle does nothing', 'toggle')]));
  assert.equal(weak.findings[0].trait_free, undefined, 'one shared key is often chance');
});

test('a theme only the scan found is no sign of the model: it gets no trait-free note and gives none', () => {
  const contrast = (id: string) => theme(id, 'Low contrast on the plans page', ['contrast'], { scan_only: true });
  const scanned = combineReports(withControl([[contrast('g1')], [contrast('g2')]], [contrast('g3')]));
  assert.deepEqual([scanned.findings[0].seen_in, scanned.findings[0].trait_free], [2, undefined], 'the scan finds a rule whoever browses');
  assert.equal(repeatNote(scanned, 'r-1', contrast('g1'))?.trait_free, null);
  const reported = (id: string) => theme(id, 'Low contrast on the plans page', ['contrast']);
  assert.equal(combineReports(withControl([[reported('g1')], [reported('g2')]], [contrast('g3')])).findings[0].trait_free, undefined, 'a control theme the scan alone found');
  assert.equal(combineReports(withControl([[reported('g1')], [reported('g2')]], [reported('g3')])).findings[0].trait_free, true, 'what personas reported still matches');
});

test('a stopped trait-free run marks nothing and ends nothing, and a set of one still shows the note', () => {
  const save = theme('g1', 'Save does nothing', ['save']);
  const stopped = combineReports(withControl([[save], [save]], [save], { status: 'stopped' }));
  assert.deepEqual([stopped.trait_free, stopped.findings[0].trait_free, stopped.incomplete], [undefined, undefined, false]);
  const going = combineReports(withControl([[save], [save]], [], { status: 'running' }), true);
  assert.deepEqual([going.running, going.compared], [false, 2], 'the runs it counts are over');
  const one = combineReports(withControl([[save]], [theme('g3', 'Saving fails', ['save'])]));
  assert.deepEqual([one.of, one.compared], [1, 1]);
  assert.deepEqual([repeatNote(one, 'r-1', save)?.appeared, repeatNote(one, 'r-1', save)?.trait_free], [null, TRAIT_FREE_TEXT]);
  assert.equal(repeatNote(combineReports([run(1, [save], { repeat: { group: 'g', index: 1, of: 1 } })]), 'r-1', save), null, 'a set of one with nothing to add');
});

test('a run marked with no trait-free index is an ordinary run, on old logs and new', () => {
  const old = run(1, []);
  assert.equal(isTraitFree(old), false);
  assert.equal(isTraitFree({ repeat: undefined }), false);
  assert.equal(isTraitFree({ repeat: null }), false);
  const save = theme('g1', 'Save does nothing', ['save']);
  assert.deepEqual(Object.keys(combineReports([run(1, [save], { of: 1 })])).sort(), ['compared', 'families', 'findings', 'group', 'incomplete', 'of', 'running'], 'a set without it has no new field');
  assert.equal('trait_free' in combineReports([run(1, [save], { of: 1 })]).findings[0], false);
});

test('a returning set names the run its personas remember, in Markdown and JSON, and any other set says nothing of it', () => {
  const prior = { run_id: 'r-0', fresh: 1 };
  const returning = (index: number) => run(index, [theme('g1', 'Save does nothing', ['save'])], { methods: { models: { navigator: ANTHROPIC }, prior } } as never);
  const set = combineReports([returning(1), returning(2), returning(3)]);
  assert.deepEqual(set.prior, prior);
  assert.match(repeatsToMarkdown(set), /> These personas used the product before, in r-0, so this run says little about first use\. 1 persona had no earlier visit/);
  const plain = combineReports([run(1, [theme('g1', 'Save does nothing', ['save'])])]);
  assert.equal('prior' in plain, false);
  assert.doesNotMatch(repeatsToMarkdown(plain), /used the product before/);
});
