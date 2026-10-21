import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gymAssets } from '../../../demo/GymSite/assets.ts';
import { preflight } from '../poi/index.ts';
import { PROVIDER_DEFAULTS } from '../settings.ts';
import type { GnomiEvent, Report } from '../types.ts';
import { parseOptions } from './checks.ts';
import { fixture, subset } from './fixture.ts';
import { atScale, buyerTextCriterion, controlFrameCriterion, d28Criterion, D26_FRAME, designCase, designSkipped, FIGMA_LISTING, frameMismatchCriterion, frameMismatches, textCase } from './m5.ts';
import { runM5Acceptance } from './run.ts';

const dir = mkdtempSync(join(tmpdir(), 'gnomi-m5-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// Hand-built design logs: `reached` personas see the frame, `flagged` of them report a friction on it (and one on frame 0 that never counts).
let seq = 0;
const ev = (type: string, payload: object, persona_id: string | null = null) => ({ run_id: 'r-1', seq: ++seq, ts: 0, round: 1, persona_id, poi_id: 'poi-checkout', type, payload }) as GnomiEvent;
const step = (persona: string, frame: number) => ev('persona.step', { step_no: frame + 1, frame }, persona);
const friction = (persona: string, frame: number, what = 'Expected a confirmation, saw a sign-in prompt') => ev('persona.friction_reported', { step_no: frame + 1, severity: 3, what, expected: 'A confirmation', where: { url: 'asset:x.png', ref: null }, frame, heard_post_ids: [] }, persona);
function design(reached: number, flagged: number, finished = true): GnomiEvent[] {
  seq = 0;
  const people = Array.from({ length: reached }, (_, i) => `p${i + 1}`);
  return [
    ev('run.started', {}),
    ...people.flatMap((p, i) => [step(p, 0), friction(p, 0, 'an earlier, unrelated friction'), step(p, D26_FRAME), ...(i < flagged ? [friction(p, D26_FRAME)] : [])]),
    ...(finished ? [ev('run.finished', {})] : [ev('run.stopped', {})]),
  ];
}
const seeds = (...runs: ([reached: number, flagged: number] | null)[]) => runs.map((run) => (run ? frameMismatches(design(...run)) : null));

test('a mismatch is a friction on the frame where D26 shows the sign-in prompt, counted per persona, and only a finished run answers', () => {
  const found = frameMismatches(design(5, 3))!;
  assert.deepEqual([found.frame, found.reached, found.flagged.length], [D26_FRAME, 5, 3], 'the friction on frame 0 is not counted');
  assert.deepEqual(found.flagged.map((f) => f.persona_id), ['p1', 'p2', 'p3']);
  assert.equal(frameMismatches(design(5, 3, false)), null, 'a stopped run says nothing');
  assert.deepEqual(frameMismatches(design(2, 0))!.flagged, []);
});

test('D26_FRAME is the frame the Gym changes: only checkout frame 4 differs between the defect and control sequences', () => {
  const [defect, control] = [gymAssets({ defects: 'D26' }).frames.checkout, gymAssets({ defects: 'none' }).frames.checkout];
  assert.equal(defect.length, 6);
  assert.deepEqual(defect.flatMap((file, i) => (readFileSync(file).equals(readFileSync(control[i])) ? [] : [i]) ), [D26_FRAME]);
  assert.match(readFileSync(new URL('../../../demo/GymSite/defects.yaml', import.meta.url), 'utf8'), /id: D26[\s\S]*?frames: \[checkout\/4\]/);
});

test('frame_mismatch passes only live, in four of five seeds; two seeds without it fail; missing seeds leave it undecided', () => {
  const status = (runs: Parameters<typeof seeds>, mode: 'live' | 'scripted' = 'live') => frameMismatchCriterion(mode, seeds(...runs)).status;
  assert.equal(status([[20, 14], [20, 9], [20, 1], [20, 7], [20, 0]]), 'PASS');
  assert.equal(status([[20, 14], [20, 9], [20, 1], [20, 7], null]), 'PASS', 'four hits decide it whatever the fifth shows');
  assert.equal(status([[20, 0], [20, 9], [20, 1], [20, 7], [20, 3]]), 'PASS', 'one miss leaves four hits');
  assert.equal(status([[20, 0], [20, 9], [20, 1], [20, 7], null]), 'NOT_RUN', 'three hits and a miss, the fifth seed decides');
  assert.equal(status([[20, 14], [20, 9], [20, 1], null, null]), 'NOT_RUN', 'three hits and two seeds missing');
  assert.equal(status([[20, 0], [20, 0], [20, 5], [20, 5], [20, 5]]), 'FAIL', 'two misses leave at most three hits');
  assert.equal(status([[20, 0], [20, 0], null, null, null]), 'FAIL');
  assert.equal(status([[20, 0], null, null, null, null]), 'NOT_RUN');
  assert.equal(status([[20, 14], [20, 9], [20, 1], [20, 7], [20, 3]], 'scripted'), 'NOT_RUN', 'a rehearsal never passes');
  const { detail } = frameMismatchCriterion('live', seeds([20, 14], [20, 0], null, null, null));
  assert.match(detail, /in 1 of 2 measured seeds \(3 missing\); needs 4 of 5/);
  assert.match(detail, /14\/20, 0\/20, missing, missing, missing\./);
});

test('the control frame passes with no friction, goes to a reader with one, and is not measured without a finished control run', () => {
  const control = (reached: number, flagged: number, mode: 'live' | 'scripted' = 'live') => controlFrameCriterion(mode, frameMismatches(design(reached, flagged)));
  assert.equal(control(20, 0).status, 'PASS');
  assert.equal(control(20, 2).status, 'REVIEW_NEEDED', 'a false positive is for a reader to confirm, not for the runner to fail');
  assert.match(control(20, 2).detail, /2 of 20 personas.*Expected a confirmation/);
  assert.equal(control(20, 0, 'scripted').status, 'NOT_RUN');
  assert.equal(controlFrameCriterion('live', null).status, 'NOT_RUN');
});

test('a smaller run keeps its figures but cannot pass or fail on them', () => {
  const pass = frameMismatchCriterion('live', seeds([4, 3], [4, 3], [4, 3], [4, 3], [4, 3]));
  assert.equal(pass.status, 'PASS');
  const small = atScale(pass, '4 of 20 personas, 2 of 5 seeds');
  assert.equal(small.status, 'NOT_RUN');
  assert.match(small.detail, /^Reduced scale \(4 of 20 personas, 2 of 5 seeds\): A friction landed on frame 4/);
  assert.equal(atScale({ ...pass, status: 'FAIL' }, 'x').status, 'NOT_RUN');
  assert.equal(atScale({ ...pass, status: 'REVIEW_NEEDED' }, 'x').status, 'REVIEW_NEEDED');
  assert.equal(atScale(pass, null), pass);
});

// A pricing-page report with a buyer segment, as the report builder shapes it (only the fields the criterion reads).
const evidence = (passage?: string) => ({ quote: 'Team says SSO, the FAQ says Business', ...(passage ? { passage: { start: 0, end: passage.length, text: passage } } : {}) });
const theme = (rank: number, passage?: string) => ({ rank, evidence: [evidence(passage)] });
const segment = (id: string, name: string) => ({ id, name });
const rated = (id: string, surveyed = 3, sentiment: number | null = -0.5) => ({ segment_id: id, name: id, surveyed, sentiment, would_continue: 0 });
function pricing(over: Record<string, unknown> = {}) {
  return {
    status: 'finished', segments: [segment('seg-1', 'Recruiting'), segment('seg-buyers', 'Procurement')],
    sentiment: [rated('seg-1'), rated('seg-buyers')], buyers: [{ poi_id: 'poi-pricing', segment_id: 'seg-buyers', name: 'Procurement', surveyed: 3 }],
    themes: [theme(1, 'Single sign-on (SAML SSO)'), theme(2)], ...over,
  } as unknown as Report;
}

test('buyer_text needs a sentiment for every segment, the buyers\' answers and ranked confusions that quote the text, and passes only live', () => {
  assert.equal(buyerTextCriterion('live', pricing()).status, 'PASS');
  assert.match(buyerTextCriterion('live', pricing()).detail, /Sentiment for all 2 segments, buying survey answers from Procurement, 2 ranked confusions of which 1 quote a passage/);
  assert.equal(buyerTextCriterion('scripted', pricing()).status, 'NOT_RUN', 'a rehearsal never passes');
  const fails = (over: Record<string, unknown>, problem: RegExp) => {
    const result = buyerTextCriterion('live', pricing(over));
    assert.equal(result.status, 'FAIL');
    assert.match(result.detail, problem);
  };
  fails({ sentiment: [rated('seg-1')], buyers: [] }, /no sentiment for Procurement/);
  assert.equal(buyerTextCriterion('live', pricing({ sentiment: [rated('seg-1'), rated('seg-buyers', 0, null)] })).status, 'PASS', "a buyer segment's sentiment is in its buying survey");
  fails({ buyers: [] }, /no buying survey answers/);
  fails({ buyers: undefined }, /no buying survey answers/);
  fails({ themes: [] }, /no confusions/);
  fails({ themes: [theme(1), theme(2)] }, /no confusion quotes a passage/);
  fails({ themes: [theme(1, 'SSO'), theme(3, 'SSO')] }, /ranks are not 1…n/);
  assert.equal(buyerTextCriterion('live', pricing({ status: 'stopped' })).status, 'NOT_RUN');
  assert.equal(buyerTextCriterion('live', undefined).status, 'NOT_RUN');
});

test('the D28 mapping is a review, ready only for a live pair of finished text runs', () => {
  const finished = { status: 'finished' } as const;
  assert.equal(d28Criterion('live', { d28: finished, control: finished }).status, 'REVIEW_NEEDED');
  assert.equal(d28Criterion('scripted', { d28: finished, control: finished }).status, 'NOT_RUN');
  assert.equal(d28Criterion('live', { d28: finished }).status, 'NOT_RUN');
  assert.equal(d28Criterion('live', { d28: finished, control: { status: 'stopped' } }).status, 'NOT_RUN');
  assert.match(d28Criterion('live', { d28: finished, control: finished }).detail, /none can be confirmed or observed/);
});

test('the cases give the fixture\'s people a pricing page with buyers, and an unnamed checkout', () => {
  const base = subset(fixture('http://localhost'), 20);
  const text = textCase(base, '0123456789abcdef.md');
  const segments = text.project.audience!.segments;
  assert.equal(text.personas.length, 24, 'one buyer in five more people, at least three');
  assert.equal(segments.at(-1)!.kind, 'buyer');
  assert.equal(segments.reduce((sum, s) => sum + s.share, 0), 100);
  assert.deepEqual(text.personas.filter((p) => p.segment_id === 'seg-buyers').map((p) => p.id), ['p-segbuyers-01', 'p-segbuyers-02', 'p-segbuyers-03', 'p-segbuyers-04']);
  assert.equal(new Set(text.personas.map((p) => p.name)).size, 24, 'no name repeats');
  assert.ok(text.personas.every((p) => /single sign-on/.test(p.goal_interpretation)), 'nobody is left with an applicant-tracking task');
  assert.equal(textCase(subset(fixture('http://localhost'), 4), 'a'.repeat(16) + '.md').personas.length, 7, 'at least three buyers');
  assert.equal(preflight(text.project), null);

  const checkout = designCase(base, Array.from({ length: 6 }, (_, i) => `${String(i).repeat(16)}.png`));
  assert.equal(checkout.personas.length, 20);
  const [poi] = checkout.project.pois;
  assert.ok(poi.type === 'design' && poi.frames.length === 6 && poi.frames.every((f) => f.name === null), 'a frame\'s name would give the defect away');
  assert.ok(checkout.personas.every((p) => /rain jacket/.test(p.goal_interpretation)));
});

test('the design runner\'s preflight refuses a navigator that cannot read images, which is what skips the design case', () => {
  const frames = Array.from({ length: 6 }, (_, i) => `${String(i).repeat(16)}.png`);
  const project = designCase(fixture('http://localhost'), frames).project;
  assert.equal(preflight(project), null);
  const text = { ...project, settings: { ...project.settings, routing: PROVIDER_DEFAULTS.deepseek } };
  assert.match(preflight(text) ?? '', /reads text only/);
  assert.deepEqual(designSkipped('reads text only').map((c) => [c.id, c.status]), [['frame_mismatch', 'NOT_RUN'], ['design_control', 'NOT_RUN']]);
});

test('--m5 is a mode of its own', () => {
  assert.equal(parseOptions(['--m5']).m5, true);
  assert.equal(parseOptions([]).m5, undefined);
  assert.throws(() => parseOptions(['--m5', '--m3']), /one of/);
  assert.throws(() => parseOptions(['--m4', '--m5']), /one of/);
});

test('a scripted rehearsal runs both text cases and the design cases end to end and passes no live criterion', async () => {
  const out = join(dir, 'rehearsal');
  const result = await runM5Acceptance({ ...parseOptions(['--m5', '--out', out]) });
  assert.equal(result.error, null);
  assert.equal(result.status, 'NOT_RUN');
  assert.deepEqual(result.criteria.map((c) => [c.id, c.status]), [['buyer_text', 'NOT_RUN'], ['d28_theme', 'NOT_RUN'], ['frame_mismatch', 'NOT_RUN'], ['design_control', 'NOT_RUN'], ['figma_listing', 'NOT_RUN']]);
  assert.ok(result.criteria.every((c) => c.live_required));
  assert.equal(result.recorded_cost_usd, 0);
  assert.match(result.criteria[0].detail, /^Sentiment for all 5 segments/, 'the rehearsal shows the structure, though it cannot pass');
  assert.deepEqual(result.design.seeds.map((s) => s.run_status), Array(5).fill('finished'));
  assert.equal(result.design.control.run_status, 'finished');
  assert.deepEqual([result.design.seeds[0].mismatch?.reached, result.design.seeds[0].mismatch?.flagged.length], [20, 0], 'every persona reached frame 4; the demo mismatch is on frame 2');
  for (const name of ['text-d28', 'text-control', 'design-control', 'design-20261015']) {
    assert.deepEqual(readdirSync(join(out, name)).sort(), ['attempts.jsonl', 'events.json', 'project', 'report.json', 'report.md', 'transcripts.json']);
  }
  assert.ok(readdirSync(join(out, 'text-d28/project/assets')).every((file) => /\.md$/.test(file)));
  assert.deepEqual(readdirSync(out).filter((file) => !file.startsWith('design-') && !file.startsWith('text-')).sort(), ['acceptance.json', 'd28-themes.json', 'd28-themes.md', 'defects.yaml', 'manifest.json', 'price-table.ts']);
  assert.deepEqual(result.criteria.at(-1), FIGMA_LISTING);
  await assert.rejects(runM5Acceptance(parseOptions(['--m5', '--out', out])), /already exists/);
});

test('with a navigator that reads text only, the design case is skipped with the preflight\'s reason and nothing is spent on it', async () => {
  const out = join(dir, 'text-only');
  const result = await runM5Acceptance(parseOptions(['--m5', '--provider', 'deepseek', '--out', out]));
  assert.equal(result.error, null);
  const design = result.criteria.filter((c) => c.id === 'frame_mismatch' || c.id === 'design_control');
  assert.equal(design.length, 2);
  for (const c of design) assert.match(c.detail, /^Design case not run: "Checkout" is a design, and the navigator model \(DeepSeek deepseek-flash\) reads text only\./);
  assert.match(result.design.skipped ?? '', /reads text only/);
  assert.deepEqual(readdirSync(out).filter((file) => file.startsWith('design-')), [], 'no design run was started');
  assert.deepEqual(readdirSync(out).filter((file) => file.startsWith('text-')).sort(), ['text-control', 'text-d28']);
  assert.equal(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).design.skipped, result.design.skipped);
});
