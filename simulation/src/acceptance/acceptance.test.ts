import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, generic, germanProbe, gym, subset } from './fixture.ts';
import { DEFECT_IDS } from '../../../demo/GymSite/server.ts';
import { assess, createAllowance, defectScores, executionCriterion, mappingScores, observeAttempt, pairedDifference, parseOptions, t95, topOverlap, validateOptions, webDefects } from './checks.ts';
import { runEvaluation } from './run.ts';
import type { LlmAttempt } from '../seams.ts';
import { profileBlock } from '../agent/prompt.ts';
import type { Persona, ReportTheme } from '../types.ts';

test('the frozen acceptance fixture is deterministic, has fifty people and a guaranteed German probe', () => {
  const first = fixture('http://localhost:4317');
  assert.deepEqual(fixture('http://localhost:4317'), first);
  assert.equal(first.personas.length, 50);
  assert.equal(new Set(first.personas.map((p) => p.name)).size, 50);
  assert.equal(first.project.settings.concurrency, 12);
  assert.equal(first.project.settings.screenshots, true);
  const probe = germanProbe(first);
  assert.equal(probe.personas.length, 1);
  assert.equal(probe.personas[0].languages?.[0], 'de-DE');
  assert.equal(probe.personas[0].timezone, 'Europe/Berlin');
  assert.match(gym(probe).start_url, /\/locale$/);
});

test('live execution requires a finite positive allowance and a credential before any browser starts', () => {
  assert.equal(parseOptions([]).mode, 'scripted');
  const options = parseOptions(['--live', '--out', '/tmp/example', '--allowance-usd', '6']);
  assert.equal(options.allowance_usd, 6);
  assert.doesNotThrow(() => validateOptions(options, { ANTHROPIC_API_KEY: 'fixture-key' }));
  assert.throws(() => validateOptions({ ...options, allowance_usd: undefined }, {}), /allowance/);
  assert.throws(() => validateOptions(options, {}), /ANTHROPIC_API_KEY/);
  assert.throws(() => parseOptions(['--live', '--allowance-usd', 'Infinity']), /allowance/);
  assert.throws(() => parseOptions(['--allowance-usd', '0']), /allowance/);
});

test('scripted measurements cannot pass live acceptance and missing usage prevents a cost pass', () => {
  const facts = { population: 50, terminal: 50, goal_completed: 20, blocked: 0, run_status: 'finished', duration_ms: 1000, cost_usd: 1, unknown_usage: 0, peak_contexts: 12, replay_equal: true };
  const scripted = assess('scripted', facts);
  assert.ok(scripted.filter((c) => c.live_required).every((c) => c.status === 'NOT_RUN'));
  const live = assess('live', facts);
  assert.equal(live.find((c) => c.id === 'recorded_cost')?.status, 'PASS');
  assert.equal(assess('live', { ...facts, unknown_usage: 1 }).find((c) => c.id === 'recorded_cost')?.status, 'REVIEW_NEEDED');
  assert.equal(assess('live', { ...facts, duration_ms: 30 * 60_000 }).find((c) => c.id === 'duration')?.status, 'FAIL');
  assert.equal(assess('live', { ...facts, terminal: 49 }).find((c) => c.id === 'population')?.status, 'FAIL');
  assert.equal(assess('live', { ...facts, peak_contexts: 1 }).find((c) => c.id === 'concurrency')?.status, 'FAIL');
  assert.equal(assess('live', { ...facts, cost_usd: 5, unknown_usage: 1 }).find((c) => c.id === 'recorded_cost')?.status, 'FAIL');
  const stopped = assess('scripted', { ...facts, terminal: 0, run_status: 'stopped' });
  assert.equal(stopped.find((c) => c.id === 'execution')?.status, 'FAIL');
  assert.equal(stopped.find((c) => c.id === 'population')?.status, 'NOT_RUN');
  assert.equal(executionCriterion({ ...facts, population: 1, terminal: 1, run_status: 'stopped' }, 1).status, 'FAIL', 'a locale echo before a later run failure is insufficient');
  assert.equal(executionCriterion({ ...facts, population: 1, terminal: 1 }, 1).status, 'PASS');
});

test('a provider reads its own key, and the size options are bounded', () => {
  const options = parseOptions(['--live', '--allowance-usd', '1', '--provider', 'deepseek', '--personas', '6', '--seeds', '2', '--m3']);
  assert.deepEqual([options.provider, options.personas, options.seeds, options.m3], ['deepseek', 6, 2, true]);
  assert.equal(parseOptions([]).personas, 50);
  assert.doesNotThrow(() => validateOptions(options, { DEEPSEEK_API_KEY: 'fixture-key' }));
  assert.throws(() => validateOptions(options, { ANTHROPIC_API_KEY: 'fixture-key' }), /DEEPSEEK_API_KEY/);
  assert.throws(() => parseOptions(['--provider', 'other']), /--provider/);
  assert.throws(() => parseOptions(['--personas', '0']), /--personas/);
  assert.throws(() => parseOptions(['--seeds', '6']), /--seeds/);
  assert.throws(() => parseOptions(['--m3', '--m4']), /one of/);
});

test('a smaller run keeps every segment and the same people, and leaves the fifty-person targets unmeasured', () => {
  const base = fixture('http://localhost:4317');
  const small = subset(base, 6);
  assert.equal(small.personas.length, 6);
  assert.deepEqual(new Set(small.personas.map((p) => p.segment_id)), new Set(base.project.audience!.segments.map((s) => s.id)));
  for (const persona of small.personas) assert.deepEqual(persona, base.personas.find((p) => p.id === persona.id));
  assert.equal(subset(base, 50), base);
  assert.throws(() => subset(base, 3), /at least 4/);
  const facts = { population: 6, terminal: 6, goal_completed: 2, blocked: 0, run_status: 'finished', duration_ms: 1000, cost_usd: 0.1, unknown_usage: 0, peak_contexts: 6, replay_equal: true };
  const live = assess('live', facts, 6);
  assert.equal(live.find((c) => c.id === 'population')?.status, 'PASS');
  assert.equal(live.find((c) => c.id === 'execution')?.status, 'PASS');
  for (const id of ['duration', 'recorded_cost', 'concurrency']) assert.match(live.find((c) => c.id === id)!.detail, /^Reduced scale/), assert.equal(live.find((c) => c.id === id)?.status, 'NOT_RUN');
});

const attempt = (cost_usd: number, usage_reported = true) => ({ payload: { cost_usd, usage_reported }, transcript: { request: {}, response: {} } }) as LlmAttempt;
test('the shared allowance cancels at recorded spend and stops on missing usage without claiming a bill cap', () => {
  const allowance = createAllowance(1);
  allowance.observe(attempt(0.6));
  assert.equal(allowance.signal.aborted, false);
  allowance.observe(attempt(0.4));
  assert.equal(allowance.signal.aborted, true);
  allowance.observe(attempt(0.3)); // an already-dispatched response still contributes
  assert.equal(allowance.spent(), 1.3);
  assert.throws(() => allowance.check(), /recorded-spend allowance/);
  const unknown = createAllowance(1);
  unknown.observe(attempt(0, false));
  assert.equal(unknown.unknown(), 1);
  assert.equal(unknown.signal.aborted, true);
});

test('run attempt callbacks precede shared allowance cancellation, and callback failure retains cost and evidence', () => {
  const allowance = createAllowance(1);
  const order: string[] = [];
  allowance.signal.addEventListener('abort', () => order.push('allowance cancelled'));
  observeAttempt(attempt(1), () => order.push('engine budget observer'), allowance, () => order.push('evidence'));
  assert.deepEqual(order, ['engine budget observer', 'allowance cancelled', 'evidence']);

  const failed = createAllowance(1);
  const evidence: LlmAttempt[] = [];
  assert.throws(() => observeAttempt(attempt(0.5), () => { throw new Error('observer failed'); }, failed, (value) => evidence.push(value)), /observer failed/);
  assert.equal(failed.spent(), 0.5);
  assert.equal(evidence.length, 1);
});

test('the t table gives the two-sided 95% quantiles, and the normal one above thirty degrees of freedom', () => {
  assert.deepEqual([t95(1), t95(5), t95(30), t95(31)], [12.706, 2.571, 2.042, 1.96]);
});

test('the paired difference is the mean of per-replicate differences with a t interval, over pairs where both measured', () => {
  // differences 1, 2, 3: mean 2, sample variance 1, half-width 4.303 × √(1/3)
  const d = pairedDifference([2, 4, 6, 9], [1, 2, 3, null]);
  assert.equal(d.n, 3);
  assert.equal(d.mean, 2);
  assert.ok(Math.abs(d.lower! - (2 - 4.303 / Math.sqrt(3))) < 1e-9 && Math.abs(d.upper! - (2 + 4.303 / Math.sqrt(3))) < 1e-9);
  assert.equal(d.note, null);
  assert.deepEqual(pairedDifference([5, 6], [3, 3]), { n: 2, mean: 2.5, lower: null, upper: null, note: 'fewer than three pairs' }, 'two pairs have no interval');
  assert.deepEqual(pairedDifference([3, 3, 3], [1, 1, 1]), { n: 3, mean: 2, lower: null, upper: null, note: 'no variation' });
  assert.deepEqual(pairedDifference([null], [3]), { n: 0, mean: null, lower: null, upper: null, note: 'no pairs' });
});

const themeOf = (rank: number, trust: ReportTheme['trust'], pages: string[], title = 'Lost draft') => ({ rank, trust, pages, title, description: '', elements: [], evidence: [] }) as Partial<ReportTheme> as ReportTheme;

test('defect scores map themes to enabled web defects by shared pages and hints; only confirmed or observed themes find one', () => {
  const catalogue = '- id: D01\n  poi: web\n  severity: high\n  pages: [jobs/new]\n  hints: [lost draft]\n- id: D02\n  poi: web\n  severity: low\n  pages: [dashboard, "jobs/:id"]\n  hints: [lost draft, count]\n- id: D03\n  poi: web\n  severity: high\n  pages: [settings]\n  hints: [lost draft]\n- id: D28\n  poi: text\n  severity: high\n  pages: [pricing]\n  hints: [lost draft]\n';
  const themes = [themeOf(1, 'observed', ['localhost:1/jobs/new']), themeOf(2, 'reported', ['localhost:1/']), themeOf(3, 'confirmed', ['localhost:1/candidates'])];
  assert.deepEqual(defectScores(themes, catalogue, ['D01', 'D02', 'D28']), { found: 1, defects: 2, recall: 0.5, found_high: 1, defects_high: 1, recall_high: 1, matched: 2, top: 3, precision: 2 / 3 });
  assert.deepEqual(defectScores([], catalogue, []), { found: 0, defects: 0, recall: null, found_high: 0, defects_high: 0, recall_high: null, matched: 0, top: 0, precision: null });
});

test('defect scores need a hint in the title, description, elements or evidence as well as a shared page', () => {
  const catalogue = '- id: D01\n  poi: web\n  pages: [jobs/new]\n  hints: [Save Draft]\n- id: D02\n  poi: web\n  pages: [jobs/new]\n';
  const score = (extra: Partial<ReportTheme>) => defectScores([{ ...themeOf(1, 'observed', ['h/jobs/new'], 'A problem'), ...extra }], catalogue, ['D01', 'D02']).found;
  assert.equal(score({}), 0, 'the page alone pairs nothing, and a defect with no hints never pairs');
  assert.equal(score({ title: 'The save draft button' }), 1);
  assert.equal(score({ description: 'Pressed SAVE DRAFT' }), 1);
  assert.equal(score({ elements: ['button "Save draft"'] }), 1);
  assert.equal(score({ evidence: [{ what: 'save draft did nothing', quote: '' }] as ReportTheme['evidence'] }), 1);
  assert.equal(score({ evidence: [{ what: '', quote: 'I pressed save draft' }] as ReportTheme['evidence'] }), 1);
  assert.equal(defectScores([themeOf(1, 'observed', ['h/settings'], 'save draft')], catalogue, ['D01']).found, 0, 'a hint on another page pairs nothing');
});

test('defect scores assign themes and defects one-to-one, so one theme on a shared page credits one defect', () => {
  const catalogue = '- id: D01\n  poi: web\n  pages: [jobs/new, jobs]\n  hints: [lost draft]\n- id: D04\n  poi: web\n  pages: [jobs/new]\n  hints: [lost draft]\n';
  const theme = (rank: number, pages: string[]) => themeOf(rank, 'observed', pages);
  assert.deepEqual(defectScores([theme(1, ['h/jobs/new'])], catalogue, ['D01', 'D04']), { found: 1, defects: 2, recall: 0.5, found_high: 0, defects_high: 0, recall_high: null, matched: 1, top: 1, precision: 1 });
  // The first theme takes D01, then gives it up for D04 so the second theme, which reaches only D01, is matched too.
  assert.equal(defectScores([theme(1, ['h/jobs/new']), theme(2, ['h/jobs'])], catalogue, ['D01', 'D04']).found, 2);
  assert.equal(defectScores([theme(1, ['h/jobs']), theme(2, ['h/jobs'])], catalogue, ['D01', 'D04']).precision, 0.5);
});

test('the Gym catalogue gives every web defect hints, and ten are high severity', () => {
  const defects = webDefects(readFileSync(new URL('../../../demo/GymSite/defects.yaml', import.meta.url), 'utf8'), DEFECT_IDS);
  assert.equal(defects.length, 25);
  assert.equal(defects.filter((defect) => defect.high).length, 10);
  for (const defect of defects) assert.ok(defect.hints.length && defect.hints.every((hint) => hint.length >= 3), defect.id);
});

test('mapping scores give each run high-severity recall and top-theme precision, and leave control runs out', () => {
  const catalogue = '- id: D01\n  poi: web\n  severity: high\n  pages: [jobs]\n- id: D02\n  poi: web\n  severity: high\n  pages: [jobs]\n- id: D03\n  poi: web\n  severity: low\n  pages: [jobs]\n- id: D28\n  poi: text\n  severity: high\n  pages: [pricing]\n';
  const item = (run: string, rank: number, trust: string, defect: string | null) => ({ run, rank, trust, defect });
  const scores = mappingScores([
    item('a', 1, 'confirmed', 'D01'), item('a', 2, 'observed', 'D01'), item('a', 3, 'reported', 'D02'), item('a', 4, 'observed', 'D03'), item('a', 5, 'observed', null), item('a', 6, 'observed', 'D99'), item('a', 7, 'observed', 'D28'),
    item('a', 21, 'observed', 'D02'),
    item('b', 1, 'reported', null),
    item('control', 1, 'confirmed', 'D01'), item('r1-baseline-control', 1, 'confirmed', 'D01'),
  ], catalogue, ['D01', 'D02', 'D03', 'D28']);
  assert.deepEqual(Object.keys(scores), ['a', 'b']);
  // D01 twice, a reported D02 that finds nothing and a low D03 are true positives; null, an unknown id and a defect that is not web are not. D02 is found at rank 21, below the precision cut.
  assert.deepEqual(scores.a, { found: ['D01', 'D02'], defects_high: 2, recall_high: 1, matched: 4, top: 7, precision: 4 / 7 });
  assert.deepEqual(scores.b, { found: [], defects_high: 2, recall_high: 0, matched: 0, top: 1, precision: 0 });
  assert.deepEqual(mappingScores([], catalogue, []), {});
});

test('a mapper names a provider and a model, runs with --evaluate only, and comes from another provider than the navigator', () => {
  assert.deepEqual(parseOptions(['--evaluate', '--mapper', 'deepseek:deepseek-v4-pro']).mapper, { provider: 'deepseek', model: 'deepseek-v4-pro' });
  assert.deepEqual(parseOptions(['--evaluate', '--provider', 'deepseek', '--mapper', 'anthropic:claude:with-colon']).mapper, { provider: 'anthropic', model: 'claude:with-colon' });
  assert.equal(parseOptions(['--evaluate']).mapper, undefined);
  assert.throws(() => parseOptions(['--evaluate', '--mapper', 'anthropic:claude-sonnet-5-5']), /navigator/);
  assert.throws(() => parseOptions(['--evaluate', '--provider', 'deepseek', '--mapper', 'deepseek:deepseek-v4-pro']), /navigator/);
  for (const value of ['deepseek', 'deepseek:', ':model', 'other:model', 'constructor:model']) assert.throws(() => parseOptions(['--evaluate', '--mapper', value]), /provider:model/, value);
  assert.throws(() => parseOptions(['--m3', '--mapper', 'deepseek:deepseek-v4-pro']), /--evaluate/);
  const live = parseOptions(['--evaluate', '--live', '--allowance-usd', '1', '--mapper', 'deepseek:deepseek-v4-pro']);
  assert.doesNotThrow(() => validateOptions(live, { ANTHROPIC_API_KEY: 'fixture-key', DEEPSEEK_API_KEY: 'fixture-key' }));
  assert.throws(() => validateOptions(live, { ANTHROPIC_API_KEY: 'fixture-key' }), /DEEPSEEK_API_KEY/);
  assert.throws(() => validateOptions({ ...live, mapper: { provider: 'deepseek', model: 'no-such-model' } }, { ANTHROPIC_API_KEY: 'fixture-key', DEEPSEEK_API_KEY: 'fixture-key' }), /no price/);
});

test('evaluate mode takes repeats and arms, always with the baseline', () => {
  const options = parseOptions(['--evaluate', '--arms', 'baseline,social_off']);
  assert.deepEqual([options.evaluate, options.repeats, options.arms, options.mode], [true, 5, ['baseline', 'social_off'], 'scripted']);
  assert.equal(parseOptions(['--evaluate']).arms?.length, 9);
  assert.deepEqual(parseOptions(['--evaluate', '--arms', 'baseline,text_only,fewer_rounds']).arms, ['baseline', 'text_only', 'fewer_rounds']);
  assert.throws(() => parseOptions(['--evaluate', '--arms', 'social_off']), /include baseline/);
  assert.throws(() => parseOptions(['--evaluate', '--arms', 'baseline,other']), /got other/);
  assert.throws(() => parseOptions(['--evaluate', '--m4']), /one of/);
});

test('the generic persona keeps the person and seed but strips attributes and biography to the segment', () => {
  const base = subset(fixture('http://localhost:4317'), 4);
  const plain = generic(base);
  const [before, after] = [base.personas[0], plain.personas[0]];
  assert.deepEqual([after.id, after.seed, after.device, after.attributes], [before.id, before.seed, before.device, {}]);
  assert.equal(after.background, base.project.audience!.segments[0].description);
  assert.equal(after.patience, 3);
});

test("the generic persona's prompt block differs only by segment, besides its name and seed", () => {
  const plain = generic(fixture('http://localhost:4317'));
  const segments = plain.project.audience!.segments;
  const block = (p: Persona) => profileBlock(p, plain.project, segments.find((s) => s.id === p.segment_id)!, 'them').split('\n').filter((line) => !/^ {2}(name|seed): /.test(line)).join('\n');
  for (const segment of segments) {
    const blocks = new Set(plain.personas.filter((p) => p.segment_id === segment.id).map(block));
    assert.equal(blocks.size, 1, segment.id);
  }
  assert.equal(new Set(plain.personas.map(block)).size, segments.length);
});

test('stability is the mean Jaccard overlap of the top ten themes over every pair of replicates, matched across runs', () => {
  const key = (name: string) => JSON.stringify(['web', `gym.test/${name}`, 'element', `button "${name}"`]);
  const theme = (title: string, rank = 1) => ({ id: `g-${title}`, poi_id: 'web', rank, title, category: 'friction', keys: [key(title)] }) as ReportTheme;
  const [a, b, c, d] = ['Save does nothing', 'Prices are hidden', 'Candidates page is empty', 'Login loops forever'].map((title) => theme(title));
  assert.equal(topOverlap([[a, b], [a, b]]), 1, 'other ids and ranks would not matter');
  assert.equal(topOverlap([[a, b], [c, d]]), 0);
  assert.equal(topOverlap([[a, b, c], [a, b, d]]), 0.5, 'two shared of four');
  assert.equal(topOverlap([[a, b], [a, b], [c, d]]), 1 / 3, 'a mean over the three pairs: 1, 0 and 0');
  assert.equal(topOverlap([[a, theme('Reports never load', 11)], [a, theme('Search ignores filters', 11)]]), 1, 'only the top ten count');
  assert.equal(topOverlap([[a]]), null, 'one replicate compares nothing');
  assert.equal(topOverlap([[], []]), null, 'nor do two without themes');
  assert.equal(topOverlap([[a], []]), 0);
});

test('a scripted evaluation of two replicates and two arms writes matched results in a seeded arm order, labelled not run', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-evaluate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'run');
  const result = await runEvaluation(parseOptions(['--evaluate', '--repeats', '2', '--arms', 'baseline,chronological_feed', '--personas', '4', '--out', out]));
  assert.equal(result.error, null);
  assert.equal(result.status, 'NOT_RUN');
  assert.deepEqual(result.labels, { behavioural_validity: 'NOT_RUN', efficiency: 'NOT_RUN' });
  assert.deepEqual([result.defect_metrics.runs, result.defect_metrics.status], [null, 'NOT_RUN']);
  assert.ok(result.missing_benchmark.includes('human_reference_dataset'));
  assert.equal(result.recorded_cost_usd, 0);
  assert.deepEqual(result.replicates.map((r) => [r.seed - result.replicates[0].seed, [...r.order].sort()]), [[0, ['baseline', 'chronological_feed']], [1, ['baseline', 'chronological_feed']]]);
  for (const r of result.replicates) assert.deepEqual(Object.keys(r.arms), r.order, 'arms ran in the recorded order');
  assert.ok(result.replicates.every((r) => Object.values(r.arms).every((a) => a.duration_ms >= 0)));
  const outcomes = result.replicates[0].arms.baseline!.outcomes!;
  assert.equal(outcomes.personas, 4);
  assert.equal(outcomes.segments.reduce((sum, s) => sum + s.personas, 0), 4);
  assert.equal(outcomes.defect_proxy.defects, 25);
  assert.deepEqual([outcomes.recall_high, outcomes.precision], [0, 0], 'scripted themes carry no hint');
  assert.equal(outcomes.control_themes, 0, 'scripted frictions have no trusted signal on the control build');
  assert.deepEqual(result.replicates[1].arms.chronological_feed!.control, { run_status: 'finished', evidence: 'r2-chronological_feed-control' });
  assert.equal(typeof outcomes.segment_modularity, 'number');
  assert.equal(result.means.baseline.completion_rate.n, 2);
  assert.equal(result.means.baseline.control_themes.n, 2);
  assert.deepEqual(Object.keys(result.differences), ['chronological_feed']);
  assert.equal(result.differences.chronological_feed.llm_calls.n, 2);
  assert.equal(result.differences.chronological_feed.control_themes.n, 2);
  assert.deepEqual(readdirSync(out).sort(), ['defects.yaml', 'fixture.json', 'manifest.json', 'price-table.ts', 'r1-baseline', 'r1-baseline-control', 'r1-chronological_feed', 'r1-chronological_feed-control', 'r2-baseline', 'r2-baseline-control', 'r2-chronological_feed', 'r2-chronological_feed-control', 'results.json', 'results.md']);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.suite, 'evaluate');
  assert.deepEqual(manifest.gym.control, []);
  const control = JSON.parse(readFileSync(join(out, 'r1-baseline-control', 'report.json'), 'utf8'));
  assert.equal(control.status, 'finished');
  assert.equal(JSON.parse(readFileSync(join(out, 'r1-baseline-control', 'events.json'), 'utf8')).find((e: { type: string }) => e.type === 'run.started').payload.config.seed, result.replicates[0].seed, 'the control run keeps the seed');
  const md = readFileSync(join(out, 'results.md'), 'utf8');
  assert.match(md, /Behavioural validity: NOT_RUN[\s\S]*primary_metrics[\s\S]*Mapped defect recall: n\/a \(NOT_RUN\)[\s\S]*Intervals: exploratory/);
  assert.deepEqual(result.stability, { baseline: 1, chronological_feed: 1 }, 'scripted runs meet the same groups in every replicate');
  assert.match(md, /\| baseline \| 0 \| 0 \| 0 \| 1 \|/);
  assert.match(md, /\| n\/a \(fewer than three pairs\) \| 2 \|/);
});

test('with a mapper, a scripted evaluation writes the model mapping, a short sample sheet and per-run scores', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-evaluate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'run');
  const result = await runEvaluation(parseOptions(['--evaluate', '--repeats', '1', '--arms', 'baseline', '--personas', '4', '--mapper', 'deepseek:deepseek-v4-pro', '--out', out]));
  assert.equal(result.error, null);
  const sheet = JSON.parse(readFileSync(join(out, 'theme-mapping.json'), 'utf8'));
  assert.deepEqual([sheet.status, sheet.catalogue, sheet.mapper], ['MAPPED_BY_MODEL', 'defects.yaml', { provider: 'deepseek', model: 'deepseek-v4-pro' }]);
  assert.ok(sheet.items.length > 0 && sheet.items.every((item: { run: string; defect: null; notes: string }) => item.run === 'r1-baseline' && item.defect === null && /no model/.test(item.notes)), 'control runs are not mapped');
  assert.deepEqual(result.defect_metrics.status, 'MAPPED_BY_MODEL');
  assert.deepEqual(Object.keys(result.defect_metrics.runs!), ['r1-baseline']);
  assert.equal(result.defect_metrics.runs!['r1-baseline'].recall_high, 0);
  const attempts = readFileSync(join(out, 'attempts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(attempts.map((a) => [a.payload.role, a.payload.purpose]), [['judge', 'map_themes']]);
  assert.match(readFileSync(join(out, 'theme-mapping.md'), 'utf8'), /# Theme mapping sample[\s\S]*Mapped to no defect\. Scripted demo/);
  assert.match(readFileSync(join(out, 'results.md'), 'utf8'), /\| r1-baseline \| 0 \| 0 \|/);
});
