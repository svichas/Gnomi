import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, generic, germanProbe, gym, subset } from './fixture.ts';
import { createGateway } from '../llm/gateway.ts';
import { DEFECT_IDS } from '../../../demo/GymSite/server.ts';
import { applyMapping, assess, controlThemes, createAllowance, defectScores, executionCriterion, mappingScores, observeAttempt, pairedDifference, parseOptions, t95, topOverlap, validateOptions, webDefects } from './checks.ts';
import { mapThemes, rescoreEvaluation, runEvaluation, unmappedRuns } from './run.ts';
import { traitFree } from '../persona.ts';
import type { LlmAttempt, LlmGateway } from '../seams.ts';
import { profileBlock } from '../agent/prompt.ts';
import type { Persona, Report, ReportTheme } from '../types.ts';

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

test('defect hints match whole words with a regular ending, not parts of words', () => {
  const catalogue = '- id: D25\n  poi: web\n  pages: [settings]\n  hints: [covered, re-enter, 404, broken link, retype]\n';
  const found = (title: string) => defectScores([themeOf(1, 'observed', ['h/settings'], title)], catalogue, ['D25']).found;
  assert.equal(found('I discovered the Save button'), 0);
  assert.equal(found('Error 4040'), 0);
  assert.equal(found('The Save button is Covered.'), 1);
  assert.equal(found('Save (covered) did nothing'), 1);
  assert.equal(found('Had to re-enter it'), 1);
  assert.equal(found('A 404, twice'), 1);
  assert.equal(found('Broken links in the sidebar'), 1);
  assert.equal(found('Two 404s'), 1);
  assert.equal(found('She retyped it'), 1, 'a hint ending in e takes d');
  assert.equal(found('Re-entering it'), 1);
  assert.equal(found('Broken linkage'), 0);
});

test('the Gym hints catch ordinary wording of its defects', () => {
  const catalogue = readFileSync(new URL('../../../demo/GymSite/defects.yaml', import.meta.url), 'utf8');
  for (const [id, title] of [
    ['D03', 'Broken links in the sidebar'], ['D02', 'Required fields are not flagged'], ['D02', 'No errors shown on save'],
    ['D11', 'Page redirects to the dashboard'], ['D11', 'Could not log into the review'], ['D09', 'Candidates list is slower than expected'],
    ['D09', 'Long delays on the list'], ['D15', 'The review page is slower'], ['D21', 'Only hovering shows it'], ['D25', 'The callout overlaps Save'],
  ]) {
    const [defect] = webDefects(catalogue, [id]);
    assert.equal(defectScores([themeOf(1, 'observed', [`h/${defect.pages[0]}`], title)], catalogue, [id]).found, 1, `${id}: ${title}`);
  }
});

test('control themes count confirmed and observed themes, not reported ones', () => {
  assert.equal(controlThemes([{ trust: 'confirmed' }, { trust: 'observed' }, { trust: 'reported' }]), 2);
  assert.equal(controlThemes([{ trust: 'reported' }]), 0);
  assert.equal(controlThemes([]), 0);
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

test('a mapper answer keeps a catalogue id, an unknown id becomes null and an omitted theme stays unanswered, not a false positive', () => {
  const catalogue = '- id: D01\n  poi: web\n  severity: high\n  pages: [jobs]\n';
  const item = (theme_id: string, run = 'a') => ({ run, theme_id, rank: 1, trust: 'observed', defect: null as string | null | undefined, notes: '' });
  const applied = applyMapping([item('valid'), item('unknown'), item('none'), item('omitted')], [
    { theme_id: 'valid', defect: 'D01', reason: 'Same button.' },
    { theme_id: 'unknown', defect: 'D99', reason: 'A guess.' },
    { theme_id: 'none', defect: null, reason: 'No defect fits.' },
    { theme_id: 'stray', defect: 'D01', reason: 'No such theme.' },
  ], ['D01']);
  assert.deepEqual(applied.slice(0, 3).map(({ defect, notes }) => [defect, notes]), [['D01', 'Same button.'], [null, 'A guess.'], [null, 'No defect fits.']]);
  assert.equal(applied[3].defect, undefined);
  assert.match(applied[3].notes, /left this theme out/);
  assert.ok(!('defect' in JSON.parse(JSON.stringify(applied[3]))), 'absent in theme-mapping.json, where null is an answer');
  assert.deepEqual(mappingScores(applied, catalogue, ['D01']).a, { found: ['D01'], defects_high: 1, recall_high: 1, matched: 1, top: 3, precision: 1 / 3 }, 'three answers, so the omitted theme is no false positive');
  assert.deepEqual(mappingScores(applyMapping([item('omitted', 'b')], [], ['D01']), catalogue, ['D01']), {}, 'a run with no answers has no scores');
});

test('the mapping stops at the allowance and keeps what it paid for, so a run it did not reach is not scored', async () => {
  const catalogue = readFileSync(new URL('../../../demo/GymSite/defects.yaml', import.meta.url), 'utf8');
  const mapper = { provider: 'deepseek', model: 'deepseek-v4-pro' } as const;
  const theme = { ...themeOf(1, 'observed', ['h/jobs']), id: 't1', seqs: [1] };
  const runs = ['a', 'b', 'c'].map((name) => ({ name, report: { themes: [theme] } as Report }));
  const answer = { object: { mappings: [{ theme_id: 't1', defect: 'D03', reason: 'The same link.' }] }, cost_usd: 1 };
  const gateway = (call: () => Promise<unknown>) => ({ call }) as unknown as LlmGateway;

  const reached = createAllowance(1);
  let calls = 0;
  const stopped = await mapThemes(runs, catalogue, mapper, gateway(async () => { calls++; reached.observe(attempt(1)); return answer; }), reached);
  assert.equal(calls, 1, 'the second call is never made');
  assert.equal(stopped.failure, null, 'a stop, not a failure');
  assert.deepEqual(stopped.items!.map((item) => [item.run, item.defect]), [['a', 'D03']]);
  assert.deepEqual(Object.keys(mappingScores(stopped.items!, catalogue, DEFECT_IDS)), ['a'], 'b and c are not scored as false positives');
  assert.deepEqual(unmappedRuns(runs, stopped.items), ['b', 'c']);
  assert.deepEqual(unmappedRuns(runs, null), ['a', 'b', 'c']);
  assert.deepEqual(unmappedRuns([...runs, { name: 'quiet', report: { themes: [] } as Partial<Report> as Report }], stopped.items), ['b', 'c'], 'a run with no themes has nothing to map');

  const retried = createAllowance(1); // a failed paid attempt that reaches the allowance makes the gateway throw the abort
  let turn = 0;
  const midCall = await mapThemes(runs, catalogue, mapper, gateway(async () => {
    if (++turn === 1) return answer;
    retried.observe(attempt(1));
    retried.check();
  }), retried);
  assert.deepEqual([midCall.items!.map((item) => item.run), midCall.failure], [['a'], null]);

  let silent = 0;
  const partly = await mapThemes(runs, catalogue, mapper, gateway(async () => (silent++ ? answer : { object: { mappings: [] } })), createAllowance(1));
  assert.deepEqual(unmappedRuns(runs, partly.items), ['a'], 'a run with no answers is unmapped, as a rescore calls it');
  assert.deepEqual(Object.keys(mappingScores(partly.items!, catalogue, DEFECT_IDS)), ['b', 'c']);

  const unanswered = await mapThemes(runs, catalogue, mapper, gateway(async () => ({ object: { mappings: [] } })), createAllowance(1));
  assert.equal(unanswered.items, null, 'no answer at all is no mapping');
  assert.deepEqual(unmappedRuns(runs, unanswered.items), ['a', 'b', 'c']);
});

test('a provider failure in the mapping is a failure with its own message, not a budget stop, and keeps the paid mappings', async (t) => {
  const catalogue = readFileSync(new URL('../../../demo/GymSite/defects.yaml', import.meta.url), 'utf8');
  const mapper = { provider: 'deepseek', model: 'deepseek-v4-pro' } as const;
  const runs = ['a', 'b'].map((name) => ({ name, report: { themes: [{ ...themeOf(1, 'observed', ['h/jobs']), id: 't1', seqs: [1] }] } as Report }));
  const refused = (status: number) => () => Response.json({ error: { message: `Refused with ${status}` } }, { status });
  const paid = () => Response.json({
    id: 'c', object: 'chat.completion', created: 1, model: mapper.model, usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ mappings: [{ theme_id: 't1', defect: 'D03', reason: 'The same link.' }] }) }, finish_reason: 'stop' }],
  });
  // The real gateway against a stubbed fetch, wrapped as guardedGateway wraps it live: a failed attempt reports no usage, so the allowance aborts it.
  const queue: (() => Response)[] = [];
  t.mock.method(globalThis, 'fetch', async () => queue.shift()!());
  const mapped = async (...answers: (() => Response)[]) => {
    queue.push(...answers);
    const allowance = createAllowance(1);
    const real = createGateway({ secrets: { get: () => 'fixture-key' }, localBaseUrl: null, record: () => { throw new Error('The mapping judge logs no run events.'); } });
    const llm: LlmGateway = { call: (req) => real.call({ ...req, signal: allowance.signal, onAttempt: (value) => observeAttempt(value, req.onAttempt, allowance, () => {}) }) };
    const { items, failure } = await mapThemes(runs, catalogue, mapper, llm, allowance);
    return { runs: items?.map((item) => item.run) ?? null, failure, aborted: allowance.signal.aborted, missing: allowance.unknown() };
  };
  assert.deepEqual(await mapped(refused(401)), { runs: null, failure: 'Refused with 401', aborted: true, missing: 1 }, 'nothing mapped, so no mapping to claim');
  assert.deepEqual(await mapped(refused(500)), { runs: null, failure: 'Refused with 500', aborted: true, missing: 1 });
  assert.deepEqual(await mapped(paid, refused(500)), { runs: ['a'], failure: 'Refused with 500', aborted: true, missing: 1 });
});

test('--rescore takes the evaluation folder and nothing that would run', () => {
  const options = parseOptions(['--rescore', '/tmp/example']);
  assert.deepEqual([options.rescore, options.out, options.mode], [true, '/tmp/example', 'scripted']);
  assert.equal(parseOptions([]).rescore, undefined);
  for (const other of ['--live', '--evaluate', '--m3']) assert.throws(() => parseOptions(['--rescore', '/tmp/example', other]), /--rescore takes only/);
  assert.throws(() => parseOptions(['--rescore', '/tmp/example', '--out', '/tmp/other']), /--rescore takes only/);
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
  assert.equal(parseOptions(['--evaluate']).arms?.length, 11);
  assert.deepEqual(parseOptions(['--evaluate', '--arms', 'baseline,finding_check']).arms, ['baseline', 'finding_check']);
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

test('a persona\'s own reading of the task goes too, which the fixture\'s prose hid: it only ever repeated the segment\'s goal', () => {
  const base = subset(fixture('http://localhost:4317'), 4);
  assert.deepEqual(generic(base).personas.map((p) => p.goal_interpretation), base.personas.map((p) => p.goal_interpretation), 'the fixture\'s control is as it was');
  const written = base.personas.map((p) => ({ ...p, goal_interpretation: `Written for ${p.name}` }));
  assert.deepEqual(new Set(traitFree(written, base.project).map((p) => p.goal_interpretation)), new Set(base.project.audience!.segments.map((s) => s.goal_override)));
  const audience = { ...base.project.audience!, segments: base.project.audience!.segments.map((s) => ({ ...s, goal_override: null })) };
  assert.ok(traitFree(written, { audience, goal: 'The project goal' }).every((p) => p.goal_interpretation === 'The project goal'));
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

test('the finding_check arm runs the check on its own runs only', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-evaluate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'run');
  const result = await runEvaluation(parseOptions(['--evaluate', '--repeats', '1', '--arms', 'baseline,finding_check', '--personas', '4', '--out', out]));
  assert.equal(result.error, null);
  const checks = (run: string) => (JSON.parse(readFileSync(join(out, run, 'events.json'), 'utf8')) as { type: string }[]).filter((e) => e.type === 'report.checks').length;
  assert.deepEqual([checks('r1-baseline'), checks('r1-finding_check') > 0], [0, true]);
});

test('the accessibility arm scans the real Gym on its own runs only, and nothing on the control build', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-evaluate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'run');
  const result = await runEvaluation(parseOptions(['--evaluate', '--repeats', '1', '--arms', 'baseline,accessibility', '--personas', '4', '--out', out]));
  assert.equal(result.error, null);
  const events = (run: string) => JSON.parse(readFileSync(join(out, run, 'events.json'), 'utf8')) as { type: string; payload: { error?: string | null; rule?: string } }[];
  const scans = (run: string) => events(run).filter((e) => e.type === 'accessibility.scanned');
  assert.equal(scans('r1-baseline').length, 0);
  assert.ok(scans('r1-accessibility').length > 0);
  assert.ok(scans('r1-accessibility').every((e) => e.payload.error === null), 'every scan of the Gym went through');
  assert.equal(scans('r1-baseline-control').length, 0);
  assert.ok(scans('r1-accessibility-control').length > 0);
  assert.deepEqual(events('r1-accessibility-control').filter((e) => e.type === 'signal.accessibility'), [], 'the control build is clean');
});

test('with a mapper, a scripted evaluation writes the model mapping, a short sample sheet and per-run scores', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-evaluate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'run');
  const result = await runEvaluation(parseOptions(['--evaluate', '--repeats', '1', '--arms', 'baseline', '--personas', '4', '--mapper', 'deepseek:deepseek-v4-pro', '--out', out]));
  assert.equal(result.error, null);
  const sheet = JSON.parse(readFileSync(join(out, 'theme-mapping.json'), 'utf8'));
  assert.deepEqual([sheet.status, sheet.catalogue, sheet.mapper], ['NOT_RUN', 'defects.yaml', { provider: 'deepseek', model: 'deepseek-v4-pro' }], 'no model mapped a scripted run');
  assert.ok(sheet.items.length > 0 && sheet.items.every((item: { run: string; defect: null; notes: string }) => item.run === 'r1-baseline' && item.defect === null && /no model/.test(item.notes)), 'control runs are not mapped');
  assert.deepEqual(result.defect_metrics.status, 'NOT_RUN');
  assert.match(result.defect_metrics.detail, /no model mapped the themes/);
  assert.doesNotMatch(result.defect_metrics.detail, /A model mapped/);
  assert.equal(result.status, 'NOT_RUN', 'every run with themes was mapped');
  assert.deepEqual(Object.keys(result.defect_metrics.runs!), ['r1-baseline']);
  assert.equal(result.defect_metrics.runs!['r1-baseline'].recall_high, 0);
  const attempts = readFileSync(join(out, 'attempts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(attempts.map((a) => [a.payload.role, a.payload.purpose]), [['judge', 'map_themes']]);
  assert.match(readFileSync(join(out, 'theme-mapping.md'), 'utf8'), /# Theme mapping sample[\s\S]*Mapped to no defect\. Scripted demo/);
  assert.match(readFileSync(join(out, 'results.md'), 'utf8'), /\| r1-baseline \| 0 \| 0 \|/);

  // A person corrects the mapping: the numbers move, the estimates stay, and nothing runs.
  const items: { defect?: string | null; trust: string }[] = sheet.items;
  const correct = (change: (list: typeof items) => typeof items) => writeFileSync(join(out, 'theme-mapping.json'), JSON.stringify({ ...sheet, items: change(structuredClone(items)) }));
  const attempted = readFileSync(join(out, 'attempts.jsonl'), 'utf8');
  correct(([first, ...rest]) => [{ ...first, defect: 'D03', trust: 'confirmed' }, { ...rest[0], defect: undefined }, ...rest.slice(1)]);
  const rescored = rescoreEvaluation(out);
  const answered = items.length - 1;
  assert.deepEqual([rescored.defect_metrics.runs!['r1-baseline'].recall_high, rescored.defect_metrics.runs!['r1-baseline'].precision], [0.1, 1 / answered]);
  assert.deepEqual([rescored.means.baseline.recall_high.mean, rescored.means.baseline.precision.mean], [0.1, 1 / answered], 'the scoreboard moves too');
  assert.equal(rescored.replicates[0].arms.baseline!.outcomes!.defect_proxy.recall_high, 0, 'the hint-based estimate is kept');
  assert.deepEqual(rescored.stability, result.stability, 'stability does not come from the mapping');
  assert.equal(rescored.defect_metrics.status, 'NOT_RUN', 'a scripted rehearsal stays one');
  assert.match(rescored.defect_metrics.detail, /1 theme has no answer and counts in no score/);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')).defect_metrics, rescored.defect_metrics);
  const scoreboard = readFileSync(join(out, 'results.md'), 'utf8');
  assert.match(scoreboard, new RegExp(`\\| r1-baseline \\| 0\\.1 \\| ${Number((1 / answered).toFixed(4))} \\|`));
  assert.match(scoreboard, /## Scoreboard\n\nMeans per arm\. recall_high and precision come from theme-mapping\.json/);
  assert.match(scoreboard, new RegExp(`\\| baseline \\| 0\\.1 \\| ${Number((1 / answered).toFixed(4))} \\| 0 \\|`));
  assert.equal(readFileSync(join(out, 'attempts.jsonl'), 'utf8'), attempted, 'no model call');
  correct(() => []);
  const empty = rescoreEvaluation(out);
  assert.deepEqual([empty.defect_metrics.runs, empty.means.baseline.recall_high.mean, empty.replicates[0].arms.baseline!.outcomes!.precision], [{}, null, null], 'a run the mapping does not cover has no score, not an estimate');
  assert.match(empty.defect_metrics.detail, /Not mapped, so not scored: r1-baseline/);
  assert.equal(empty.status, 'INCOMPLETE', 'as a run gives for the same coverage');
  assert.match(readFileSync(join(out, 'results.md'), 'utf8'), /INCOMPLETE: 1 of 1 replicates/);
  correct((list) => list);
  assert.equal(rescoreEvaluation(out).status, 'NOT_RUN', 'a rehearsal with every run scored');
  const resave = (change: object) => writeFileSync(join(out, 'results.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')), ...change }));
  resave({ stability: undefined });
  assert.equal(rescoreEvaluation(out).status, 'NOT_RUN', 'an evaluation saved before stability existed still rescores');
  assert.match(readFileSync(join(out, 'results.md'), 'utf8'), /\| baseline \|.*\| n\/a \|\n/);
  resave({ mode: 'live', status: 'INCOMPLETE', allowance_stop_reason: 'The acceptance recorded-spend allowance was reached.' });
  assert.equal(rescoreEvaluation(out).status, 'REVIEW_NEEDED', 'a person mapped the runs the allowance stopped');
  const finished = readFileSync(join(out, 'results.md'), 'utf8');
  assert.doesNotMatch(finished, /INCOMPLETE:/);
  assert.match(finished, /Stopped early: The acceptance recorded-spend allowance was reached\./);
  resave({ repeats: 2 });
  assert.equal(rescoreEvaluation(out).status, 'INCOMPLETE', 'an unfinished replicate');
  resave({ repeats: 1, status: 'REVIEW_NEEDED' });
  correct(() => []);
  assert.equal(rescoreEvaluation(out).status, 'INCOMPLETE');
  resave({ status: 'FAIL', error: 'DeepSeek answered 401' });
  assert.equal(rescoreEvaluation(out).status, 'FAIL', 'a failed evaluation stays failed');
  correct(([first, ...rest]) => [{ ...first, defect: 'D3' }, ...rest]);
  const before = readFileSync(join(out, 'results.json'), 'utf8');
  assert.throws(() => rescoreEvaluation(out), /D3/, 'a mistyped id would score as a false positive');
  assert.equal(readFileSync(join(out, 'results.json'), 'utf8'), before);
  assert.throws(() => rescoreEvaluation(dir), /evaluation folder with results\.json/);
});

test('after a partial mapping the scoreboard means take the replicates mapped in every arm, so the arms average the same seeds', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-evaluate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'run');
  await runEvaluation(parseOptions(['--evaluate', '--repeats', '2', '--arms', 'baseline,social_off', '--personas', '4', '--mapper', 'deepseek:deepseek-v4-pro', '--out', out]));
  const sheet = JSON.parse(readFileSync(join(out, 'theme-mapping.json'), 'utf8'));
  // r2-social_off lost its mapping, and r2-baseline scores well: alone it would be the whole gap between the arms.
  const items = sheet.items.filter((item: { run: string }) => item.run !== 'r2-social_off').map((item: { run: string }) => (item.run === 'r2-baseline' ? { ...item, defect: 'D03', trust: 'confirmed' } : item));
  writeFileSync(join(out, 'theme-mapping.json'), JSON.stringify({ ...sheet, items }));
  const { means, differences, status } = rescoreEvaluation(out);
  assert.deepEqual([means.baseline.recall_high, means.social_off.recall_high], [{ n: 1, mean: 0 }, { n: 1, mean: 0 }]);
  assert.deepEqual([means.baseline.precision.n, means.social_off.precision.n], [1, 1]);
  assert.equal(means.baseline.completion_rate.n, 2, 'a metric with no mapping keeps every complete replicate');
  assert.equal(differences.social_off.recall_high.n, 1);
  assert.equal(status, 'INCOMPLETE');
  assert.match(readFileSync(join(out, 'results.md'), 'utf8'), /over the 1 of 2 complete replicates mapped in every arm/);

  const saved = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
  saved.replicates[1].arms.social_off.outcomes.themes = 0;
  writeFileSync(join(out, 'results.json'), JSON.stringify(saved));
  const quiet = rescoreEvaluation(out);
  assert.deepEqual([quiet.means.baseline.recall_high.n, quiet.means.social_off.recall_high.n, quiet.status], [2, 2, 'NOT_RUN'], 'a run with no themes has nothing to map, so its replicate stays in');
});
