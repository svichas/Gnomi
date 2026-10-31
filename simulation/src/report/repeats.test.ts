import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fewPairsText, repeatLabel, repeatNote, repeatsToMarkdown, TRAIT_FREE_TEXT } from './markdown.ts';
import { combineReports, plannedRuns, uncounted, WHAT_IF_NOTE } from './repeats.ts';
import type { ModelChoice, Report, ReportSpread, ReportTheme } from '../types.ts';

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
  assert.deepEqual(reports.map(uncounted), [null, null, 'trait_free']);
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
  assert.equal(uncounted(old), null);
  assert.equal(uncounted({ repeat: undefined }), null);
  assert.equal(uncounted({ repeat: null }), null);
  const save = theme('g1', 'Save does nothing', ['save']);
  assert.deepEqual(Object.keys(combineReports([run(1, [save], { of: 1 })])).sort(), ['compared', 'families', 'findings', 'group', 'incomplete', 'of', 'running'], 'a set without it has no new field');
  assert.equal('trait_free' in combineReports([run(1, [save], { of: 1 })]).findings[0], false);
});

const POST = 'The team post about saving a job.';
const figures = (posted: number, second_hand: number, opinion: number | null, abandoned = 0) => ({ posted, second_hand, opinion, abandoned });
/** One run of a pair in a what-if set of `pairs` pairs, with the numbers the comparison reads. The post is about POI `web`. */
function side(pair: number, post: boolean, pairs: number, { posted, second_hand, opinion, abandoned }: ReturnType<typeof figures>, themes: ReportTheme[] = [], over: Partial<Report> = {}) {
  const index = (pair - 1) * 2 + (post ? 2 : 1);
  const spread = [
    { poi_id: 'other', posters: ['x'], second_hand: ['x'] },
    { poi_id: 'web', posters: Array.from({ length: posted }, (_, i) => `p${i}`), second_hand: Array.from({ length: second_hand }, (_, i) => `p${i}`) },
  ] as unknown as ReportSpread[];
  return run(index, themes, {
    repeat: { group: 'set-a', index, of: pairs * 2, what_if: { pair, post, text: POST, round: 2, poi_id: 'web' } },
    spread, end_opinions: { other: 2, ...(opinion === null ? {} : { web: opinion }) }, personas: Array.from({ length: 4 }, (_, i) => ({ outcome: i < abandoned ? 'abandoned' : 'done' })) as Report['personas'], ...over,
  });
}
/** Pairs as [without, with]. */
const whatIfSet = (pairs: [ReturnType<typeof figures>, ReturnType<typeof figures>][]) => pairs.flatMap(([without, added], i) => [side(i + 1, false, pairs.length, without), side(i + 1, true, pairs.length, added)]);
const numbers = (set: ReturnType<typeof combineReports>) => Object.fromEntries(set.what_if!.numbers.map(({ id, ...rest }) => [id, rest]));

test('the runs with an added post are in no count: the runs without it are an ordinary repeat set', () => {
  const save = theme('g1', 'Save does nothing', ['save']);
  const reports = [
    side(1, false, 2, figures(1, 0, 0), [save]), side(1, true, 2, figures(2, 1, 1), [save, theme('g5', 'Only the post run saw this', ['other'])]),
    side(2, true, 2, figures(2, 1, 1), [save]), side(2, false, 2, figures(1, 0, 0), [save]),
  ];
  assert.deepEqual(reports.map(uncounted), [null, 'what_if', 'what_if', null]);
  assert.equal(plannedRuns(reports[0].repeat!), 2, 'a set of four runs plans two that count');
  const set = combineReports(reports);
  assert.deepEqual([set.of, set.compared, set.running, set.incomplete], [2, 2, false, false]);
  assert.deepEqual(seen(set), [['Save does nothing', 2, 2]], 'the post run\'s own theme adds no finding');
  assert.ok(set.findings.every((finding) => !('r-2' in finding.themes) && !('r-4' in finding.themes)));
  assert.match(repeatsToMarkdown(set), /2 runs compared\.[^\n]*The runs with the added post are in no count here\./);
  assert.equal(repeatNote(set, 'r-2', save), null, 'a post run has no line of its own');
  assert.equal(repeatLabel(reports[1]), ', pair 1, with the post your team added');
  assert.equal(repeatLabel(reports[0]), ', pair 1, without the added post');
});

test('two pairs give the mean difference and the existing note, with no interval', () => {
  const set = combineReports(whatIfSet([[figures(1, 0, 0, 1), figures(3, 1, 1, 1)], [figures(2, 0, -1, 2), figures(2, 2, 0, 1)]]));
  const { posted, second_hand, opinion, abandoned } = numbers(set);
  assert.deepEqual([set.what_if!.pairs, set.what_if!.of, set.what_if!.post, set.what_if!.round], [2, 2, POST, 2]);
  assert.deepEqual([posted.mean, second_hand.mean, opinion.mean, abandoned.mean], [1, 1.5, 1, -0.5], 'with the post minus without, on the post\'s POI');
  assert.ok(Object.values(numbers(set)).every((number) => number.n === 2 && number.lower === null && number.upper === null && number.note === 'fewer than three pairs'));
  assert.match(repeatsToMarkdown(set), /\| People who posted \| \+1\.00 \| fewer than three pairs \| 2 \|/);
});

test('three pairs give an interval, and differences that never vary give the note instead of a false certainty', () => {
  const set = combineReports(whatIfSet([[figures(1, 0, 0), figures(2, 0, 1)], [figures(1, 0, 0), figures(3, 0, 1)], [figures(1, 0, 0), figures(4, 0, 1)]]));
  const { posted, second_hand, opinion } = numbers(set);
  assert.deepEqual([posted.n, posted.mean, posted.note], [3, 2, null]);
  assert.ok(Math.abs(posted.lower! - (2 - 4.303 / Math.sqrt(3))) < 1e-9 && Math.abs(posted.upper! - (2 + 4.303 / Math.sqrt(3))) < 1e-9, 'a t interval over pairs');
  assert.deepEqual([opinion.mean, opinion.lower, opinion.upper, opinion.note], [1, null, null, 'no variation']);
  assert.deepEqual([second_hand.mean, second_hand.note], [0, 'no variation']);
  assert.match(repeatsToMarkdown(set), /\| People who posted \| \+2\.00 \| -0\.48 to \+4\.48 \| 3 \|/);
  assert.match(repeatsToMarkdown(set), /\| Mean opinion at the end, -2 to \+2 \| \+1\.00 \| no variation \| 3 \|/);
});

test('a stopped run drops its pair, a run nobody posted in counts as nobody, and its opinion still counts', () => {
  const reports = whatIfSet([[figures(1, 0, 0), figures(2, 0, 1)], [figures(1, 0, 0), figures(9, 9, 9)], [figures(1, 0, 0), figures(3, 0, 1)]]);
  const stopped = reports.map((report) => (report.run_id === 'r-4' ? { ...report, status: 'stopped' as const } : report));
  const set = combineReports(stopped);
  assert.deepEqual([set.what_if!.pairs, set.what_if!.of, numbers(set).posted.n, numbers(set).posted.mean], [2, 3, 2, 1.5], 'the pair without its other half says nothing');
  assert.deepEqual([set.compared, set.of, set.incomplete], [3, 3, false], 'its ordinary run still counts');
  assert.match(repeatsToMarkdown(set), /2 of 3 pairs finished; a pair with a run still going or stopped is left out\./);

  const none = combineReports(reports.slice(0, 1));
  assert.deepEqual([none.what_if!.pairs, numbers(none).posted.mean, numbers(none).posted.note], [0, null, 'no pairs']);

  // The post itself gives its run a spread, so reading opinions there would keep only the pairs whose baseline swarm talked.
  const silent = combineReports([{ ...side(1, false, 1, figures(0, 0, -1)), spread: undefined }, side(1, true, 1, figures(2, 1, 1))]);
  assert.deepEqual([numbers(silent).posted.mean, numbers(silent).second_hand.mean, numbers(silent).opinion.n, numbers(silent).opinion.mean], [2, 1, 1, 2]);

  const unformed = combineReports([side(1, false, 1, figures(0, 0, null)), side(1, true, 1, figures(2, 1, 1))]);
  assert.deepEqual([numbers(unformed).opinion.n, numbers(unformed).opinion.note], [0, 'no pairs'], 'only a run where nobody holds an opinion has none');
});

test('a what-if set is going while any of its runs is, the runs with the post too, though they are in no count', () => {
  const without = (pair: number) => side(pair, false, 2, figures(1, 0, 0));
  const added = (pair: number, over: Partial<Report> = {}) => side(pair, true, 2, figures(2, 0, 1), [], over);
  const state = (set: ReturnType<typeof combineReports>) => [set.compared, set.running, set.incomplete];
  const running = { status: 'running' as const };
  for (const live of [false, true]) {
    // The seed puts the post first in about half the pairs, so a run with it is often the one in flight.
    const inFlight = combineReports([without(1), added(1), added(2, running)], live);
    assert.deepEqual(state(inFlight), [1, true, false]);
    assert.match(repeatsToMarkdown(inFlight), /1 of 2 runs finished so far\./);
    const last = combineReports([without(1), added(1), without(2), added(2, running)], live);
    assert.deepEqual(state(last), [2, true, false], 'its counted runs are done, the set is not');
    assert.match(repeatsToMarkdown(last), /2 of 2 runs finished so far\..*1 of 2 pairs finished; a pair with a run still going or stopped is left out\./s);
    assert.deepEqual(state(combineReports([without(1), added(1), without(2), added(2)], live)), [2, false, false], 'over');
  }
  assert.deepEqual(state(combineReports([without(1), added(1), without(2)], true)), [2, true, false], 'the holder bridges the gap before a last run with the post');
  assert.deepEqual(state(combineReports([without(1), added(1, { status: 'stopped' })], true)), [1, false, true], 'a run that stops ends the set, even one in no count');
});

test('the result carries its limits every time, in every form, and promises nothing', () => {
  assert.equal(WHAT_IF_NOTE, 'Inside the simulator, adding this post moved these numbers. That does not establish a real-world effect. Spread is relative and uncalibrated.');
  const sets = [[], [[figures(1, 0, 0), figures(2, 0, 1)]], [[figures(1, 0, 0), figures(2, 0, 1)], [figures(1, 0, 0), figures(3, 0, 1)], [figures(1, 0, 0), figures(4, 0, 1)]]] as Parameters<typeof whatIfSet>[0][];
  for (const pairs of sets) {
    const set = combineReports(pairs.length ? whatIfSet(pairs) : [side(1, false, 3, figures(1, 0, 0), [], { status: 'stopped' })]);
    for (const form of [repeatsToMarkdown(set), JSON.stringify(set)]) {
      assert.ok(form.includes(WHAT_IF_NOTE), 'said wherever the numbers are');
      assert.doesNotMatch(form, /validated|confidence|users said|will increase|caused|lift\b/i);
    }
  }
  assert.equal(fewPairsText(1), '1 pair gives no interval, only a mean difference. Use at least 3.');
  assert.equal(fewPairsText(2), '2 pairs give no interval, only a mean difference. Use at least 3.');
  assert.equal(fewPairsText(3), null);
});

test('a set with no what-if has no what-if field, and its runs count as before', () => {
  const save = theme('g1', 'Save does nothing', ['save']);
  const set = combineReports([run(1, [save], { of: 2 }), run(2, [save], { of: 2 })]);
  assert.equal('what_if' in set, false);
  assert.doesNotMatch(repeatsToMarkdown(set), /What-if|added post/);
  assert.equal(plannedRuns({ group: 'g', index: 1, of: 3, trait_free: 3 }), 2);
  assert.equal(plannedRuns({ group: 'g', index: 1, of: 3 }), 3);
});
