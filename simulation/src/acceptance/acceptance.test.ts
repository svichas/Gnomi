import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, generic, germanProbe, gym, subset } from './fixture.ts';
import { assess, createAllowance, defectScores, executionCriterion, observeAttempt, pairedDifference, parseOptions, t95, validateOptions } from './checks.ts';
import { runEvaluation } from './run.ts';
import type { LlmAttempt } from '../seams.ts';
import type { ReportTheme } from '../types.ts';

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
  assert.deepEqual(pairedDifference([5], [3]), { n: 1, mean: 2, lower: null, upper: null }, 'one pair has no interval');
  assert.deepEqual(pairedDifference([null], [3]), { n: 0, mean: null, lower: null, upper: null });
});

test('defect scores map themes to enabled web defects by the catalogue pages they reached; only confirmed or observed themes find one', () => {
  const catalogue = '- id: D01\n  poi: web\n  pages: [jobs/new]\n- id: D02\n  poi: web\n  pages: [dashboard, "jobs/:id"]\n- id: D03\n  poi: web\n  pages: [settings]\n- id: D28\n  poi: text\n  pages: [pricing]\n';
  const theme = (rank: number, trust: ReportTheme['trust'], pages: string[]) => ({ rank, trust, pages }) as ReportTheme;
  const themes = [theme(1, 'observed', ['localhost:1/jobs/new']), theme(2, 'reported', ['localhost:1/']), theme(3, 'confirmed', ['localhost:1/candidates'])];
  assert.deepEqual(defectScores(themes, catalogue, ['D01', 'D02', 'D28']), { found: 1, defects: 2, recall: 0.5, matched: 2, top: 3, precision: 2 / 3 });
  assert.deepEqual(defectScores([], catalogue, []), { found: 0, defects: 0, recall: null, matched: 0, top: 0, precision: null });
});

test('evaluate mode takes repeats and arms, always with the baseline', () => {
  const options = parseOptions(['--evaluate', '--arms', 'baseline,social_off']);
  assert.deepEqual([options.evaluate, options.repeats, options.arms, options.mode], [true, 5, ['baseline', 'social_off'], 'scripted']);
  assert.equal(parseOptions(['--evaluate']).arms?.length, 7);
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

test('a scripted evaluation of two replicates and two arms writes matched results labelled unvalidated and inconclusive', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-evaluate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'run');
  const result = await runEvaluation(parseOptions(['--evaluate', '--repeats', '2', '--arms', 'baseline,chronological_feed', '--personas', '4', '--out', out]));
  assert.equal(result.error, null);
  assert.equal(result.status, 'NOT_RUN');
  assert.deepEqual(result.labels, { behavioural_validity: 'NOT_VALIDATED', efficiency: 'INCONCLUSIVE' });
  assert.ok(result.missing_benchmark.includes('human_reference_dataset'));
  assert.equal(result.recorded_cost_usd, 0);
  assert.deepEqual(result.replicates.map((r) => [r.seed - result.replicates[0].seed, Object.keys(r.arms)]), [[0, ['baseline', 'chronological_feed']], [1, ['baseline', 'chronological_feed']]]);
  const outcomes = result.replicates[0].arms.baseline!.outcomes!;
  assert.equal(outcomes.personas, 4);
  assert.equal(outcomes.segments.reduce((sum, s) => sum + s.personas, 0), 4);
  assert.equal(outcomes.defects.defects, 25);
  assert.equal(typeof outcomes.segment_assortativity, 'number');
  assert.equal(result.means.baseline.completion_rate.n, 2);
  assert.deepEqual(Object.keys(result.differences), ['chronological_feed']);
  assert.equal(result.differences.chronological_feed.llm_calls.n, 2);
  assert.deepEqual(readdirSync(out).sort(), ['defects.yaml', 'fixture.json', 'manifest.json', 'price-table.ts', 'r1-baseline', 'r1-chronological_feed', 'r2-baseline', 'r2-chronological_feed', 'results.json', 'results.md']);
  assert.equal(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).suite, 'evaluate');
  assert.match(readFileSync(join(out, 'results.md'), 'utf8'), /NOT_VALIDATED[\s\S]*INCONCLUSIVE[\s\S]*human_reference_dataset/);
});
