import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PERSONA } from '../persona.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { EventPayloads, EventType, GnomiEvent, Poi, ProjectConfig, ReportCoverage, ReportPersona, ReportTheme, RunConfig, WebPoi } from '../types.ts';
import { buildReport } from './build.ts';
import { buildCoverage, CURVE_MIN } from './coverage.ts';
import { RETEST_REACH } from './diff.ts';
import { reportToMarkdown } from './markdown.ts';

const web = (id: string, over: Partial<WebPoi> = {}): WebPoi => ({ id, type: 'web', name: id, start_url: `http://${id}.test/`, allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null, ...over });

interface Visit { persona: string; poi?: string; pages?: string[]; problems?: string[]; failed?: true } // each problem is a page of its own, so it is a theme of its own

/** A run where personas begin in the order of `visits`, one after another. */
function run(visits: Visit[], { pois = [web('app')], stopped, old = false, unstarted = [] }: { pois?: Poi[]; stopped?: EventPayloads['run.stopped']; old?: boolean; unstarted?: string[] } = {}) {
  const ids = [...new Set([...visits.map((visit) => visit.persona), ...unstarted])];
  const project: ProjectConfig = { name: 'App', description: '', goal: 'Post a job', role: null, audience: null, settings: DEFAULT_SETTINGS, pois };
  const personas = ids.map((id) => ({ ...BUILTIN_PERSONA, id, name: id }));
  const config: RunConfig = { run_id: 'r-1', seed: 1, project, personas, sessions: [], reset: false, pause_timeout_ms: 1000, app_version: '0' };
  const events: GnomiEvent[] = [];
  const log = <K extends EventType>(type: K, payload: EventPayloads[K], persona_id: string | null = null, poi_id: string | null = null) => events.push({ run_id: 'r-1', round: 1, persona_id, poi_id, type, payload, seq: events.length + 1, ts: events.length } as GnomiEvent);
  log('run.started', { config });
  for (const persona of personas) log('persona.created', { persona }, persona.id);
  for (const { persona, poi = pois[0].id, pages = ['/'], problems = [], failed } of visits) {
    const place = (page: string) => { const at = pois.find(({ id }) => id === poi)!; return at.type === 'web' ? new URL(page, at.start_url).href : page; };
    const where = old ? null : poi; // logs before M5 name no POI
    if (!old) log('persona.episode_started', { poi_id: poi, device: 'desktop', start_url: place(pages[0]) }, persona, poi);
    [...pages, ...problems.map((problem) => `/${problem}`)].forEach((page, i) => {
      const url = place(page);
      log('persona.step', { step_no: i + 1, action: { type: 'click', ref: 'e1', text: null }, target: null, result: { ok: true, url_before: url, url_after: url, dom_changed: false, error: null }, thought: '', feeling: 0, snapshot_hash: 'h', screenshot: null, duration_ms: 1, heard_post_ids: [] }, persona, where);
      if (i >= pages.length) log('persona.friction_reported', { step_no: i + 1, severity: 3, what: problems[i - pages.length], expected: 'It works', where: { url, ref: null }, heard_post_ids: [] }, persona, where);
    });
    if (failed) log('signal.repeated_failure', { step_no: 1, action: 'click', error: 'invalid_output' }, persona, where);
  }
  if (stopped) log('run.stopped', stopped);
  else log('run.finished', {});
  return { events, report: buildReport(events) };
}

const personas = (n: number) => Array.from({ length: n }, (_, i) => `p-${String(i + 1).padStart(2, '0')}`);
const visiting = (n: number, problems: Record<number, string[]>): Visit[] => personas(n).map((persona, i) => ({ persona, problems: problems[i] ?? [] }));
const only = (coverage: ReportCoverage[] | undefined) => { assert.equal(coverage?.length, 1); return coverage![0]; };

test('a curve that flattens says the last fifth found nothing new, about this run only', () => {
  const { curve, last_fifth, hint } = only(run(visiting(12, { 0: ['save', 'menu'], 1: ['save', 'filter'], 2: ['search'] })).report.coverage);
  assert.deepEqual(curve, [2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'a theme counts for the first persona to meet it');
  assert.deepEqual(last_fifth, { personas: 3, themes: 0 });
  assert.equal(hint, 'The last 3 personas found nothing new in this simulated run.');
});

test('a curve that does not flatten says a larger run may find more', () => {
  const { curve, last_fifth, hint } = only(run(visiting(50, { 0: ['save'], 40: ['menu'], 41: ['filter', 'search'], 49: ['export'] })).report.coverage);
  assert.equal(curve?.length, 50);
  assert.deepEqual(last_fifth, { personas: 10, themes: 4 });
  assert.equal(hint, 'The last 10 personas still found 4 new problems in this simulated run, so a larger run may find more.');
});

test('personas count in the order they began, whichever came first in the population', () => {
  const visits = visiting(3, { 0: ['save'], 1: ['menu'] });
  assert.deepEqual(only(run([visits[2], visits[1], visits[0]]).report.coverage).curve, [0, 1, 1]);
});

test(`under ${CURVE_MIN} personas the curve is too short to read and nothing is claimed from it`, () => {
  const few = CURVE_MIN - 1;
  const { curve, last_fifth, hint } = only(run(visiting(few, { 0: ['save'] })).report.coverage);
  assert.equal(curve?.length, few, 'the curve stays in the report');
  assert.deepEqual(last_fifth, { personas: 2, themes: 0 });
  assert.equal(hint, 'With 9 personas the curve is too short to read.');
  assert.equal(only(run(visiting(1, { 0: ['save'] })).report.coverage).hint, 'With 1 persona the curve is too short to read.');
});

test('each POI has its own curve and its own order', () => {
  const pois = [web('app'), web('docs')];
  const { report } = run([
    { persona: 'p-1', poi: 'app', problems: ['save'] },
    { persona: 'p-2', poi: 'docs' },
    { persona: 'p-1', poi: 'docs', problems: ['menu', 'filter'] },
    { persona: 'p-2', poi: 'app', problems: ['search'] },
  ], { pois });
  assert.deepEqual(report.coverage?.map(({ poi_id, curve }) => [poi_id, curve]), [['app', [1, 1]], ['docs', [0, 2]]]);
  assert.match(reportToMarkdown(report), /- Coverage of docs: New problems per persona, in the order they began: 0, 2\./);
});

test("a competitor has no coverage, and its themes count on nobody's curve", () => {
  const { report } = run([
    { persona: 'p-1', poi: 'app', problems: ['save'] },
    { persona: 'p-1', poi: 'rival', problems: ['menu'] },
    { persona: 'p-2', poi: 'rival' },
  ], { pois: [web('app'), web('rival', { mode: 'observe_only' })] });
  assert.ok(report.reach?.some(({ poi_id }) => poi_id === 'rival'), 'reach still has it');
  assert.deepEqual(only(report.coverage).poi_id, 'app');
  assert.deepEqual(only(report.coverage).curve, [1]);
});

test('an old log with no episode events and no POI ids counts from each first step', () => {
  const visits = visiting(3, { 0: ['save'], 1: ['menu'] });
  const { report } = run([visits[2], visits[1], visits[0]], { old: true });
  assert.deepEqual(only(report.coverage).curve, [0, 1, 1]);
});

test('a stopped run keeps what it found, leaves out who never began, and claims no saturation', () => {
  const stopped = { reason: 'cost_budget', detail: null } as const;
  const flat = only(run(visiting(10, { 0: ['save'] }), { stopped, unstarted: ['p-11', 'p-12'] }).report.coverage);
  assert.equal(flat.curve?.length, 10);
  assert.equal(flat.hint, 'The last 2 personas found nothing new, but the run stopped early, so they may not have got far.');
  assert.match(only(run(visiting(10, { 9: ['save'] }), { stopped }).report.coverage).hint, /^The last 2 personas still found 1 new problem in this simulated run/);
  assert.match(only(run(visiting(9, { 0: ['save'] }), { stopped }).report.coverage).hint, /too short to read/);
});

test('a persona the model stopped answering that met no problem adds no flat tail and counts towards no page', () => {
  const visits: Visit[] = [...visiting(10, { 9: ['save'] }), { persona: 'p-11', failed: true }, { persona: 'p-12', failed: true }, { persona: 'p-13', failed: true }];
  const { curve, last_fifth } = only(run(visits).report.coverage);
  assert.equal(curve?.length, 10);
  assert.deepEqual(last_fifth, { personas: 2, themes: 1 });
  const reached = (ids: string[], failed: string[]) => run([...ids.map((persona) => ({ persona, pages: ['/rare'] })), ...failed.map((persona): Visit => ({ persona, pages: ['/rare'], failed: true }))]);
  assert.deepEqual(only(reached(['a', 'b'], ['c']).report.coverage).thin_pages, [{ page: 'app.test/rare', personas: 2 }]);
});

test('a problem reported before the model stopped answering counts for the persona who met it', () => {
  const { curve, last_fifth, left_out, hint, thin_pages } = only(run([...visiting(11, { 0: ['save'] }), { persona: 'p-12', problems: ['export'], failed: true }]).report.coverage);
  assert.deepEqual(curve, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(last_fifth, { personas: 3, themes: 1 });
  assert.equal(left_out, undefined, 'it has a first-hand persona on record');
  assert.equal(hint, 'The last 3 personas still found 1 new problem in this simulated run, so a larger run may find more.');
  assert.deepEqual(thin_pages, [{ page: 'app.test/export', personas: 1 }, { page: 'app.test/save', personas: 1 }]);

  const alone = only(run([{ persona: 'a', problems: ['export'], failed: true }]).report.coverage);
  assert.deepEqual([alone.curve, alone.left_out], [[1], undefined]);
  assert.equal(alone.hint, 'With 1 persona the curve is too short to read.');

  const later = run([{ persona: 'a', problems: ['save'] }, { persona: 'b', problems: ['save'], failed: true }, { persona: 'c', failed: true }]);
  assert.deepEqual(only(later.report.coverage).curve, [1, 0], 'the same problem again adds nothing, and whoever met none is not on the curve');
});

const theme = (id: string, over: Partial<ReportTheme>) => ({ id, poi_id: 'app', pages: [], first_hand: [], ...over }) as unknown as ReportTheme;
const rated = (id: string) => ({ id, outcome: 'done' }) as ReportPersona;
const reach = [{ poi_id: 'app', started: ['a', 'b'], surveyed: [], pages: {} }];
const direct = (themes: ReportTheme[]) => only(buildCoverage([web('app')], [rated('a'), rated('b')], themes, reach, 'finished'));

test('a theme with no first-hand personas, from an older report, is left out with a note, and with none there is no curve', () => {
  const some = direct([theme('g1', { first_hand: ['b'] }), theme('g2', { first_hand: undefined }), theme('g3', { first_hand: [] })]);
  assert.deepEqual([some.curve, some.left_out], [[0, 1], 2]);
  assert.match(some.hint, /2 problems with no first-hand persona on record are left out\.$/);
  const none = direct([theme('g1', { first_hand: undefined })]);
  assert.deepEqual([none.curve, none.last_fifth, none.left_out], [undefined, undefined, 1]);
  assert.equal(none.hint, 'No problem here has a first-hand persona on record, so there is no curve.');
  assert.equal(direct([]).curve, undefined, 'a POI with no themes has nothing to plot');
});

test('objections are attitudes, not problems found, so they stay off the curve and the note', () => {
  const { curve, left_out } = direct([theme('g1', { first_hand: ['a'] }), theme('g2', { first_hand: ['b'], category: 'objection' })]);
  assert.deepEqual([curve, left_out], [[1, 0], undefined]);
});

test(`pages under ${RETEST_REACH} personas are listed fewest first, and only where a page means something`, () => {
  const { report } = run(['a', 'b', 'c'].map((persona, i) => ({ persona, pages: ['/', ...(i ? ['/rare'] : []), ...(i === 2 ? ['/lone'] : [])] })));
  const { thin_pages } = only(report.coverage);
  assert.deepEqual(thin_pages, [{ page: 'app.test/lone', personas: 1 }, { page: 'app.test/rare', personas: 2 }], 'a page three reached is not listed');
  assert.match(reportToMarkdown(report), /- Coverage: Barely tested, reached by fewer than 3 personas: app\.test\/lone \(1\), app\.test\/rare \(2\)\./);

  const text: Poi = { id: 'copy', type: 'text', name: 'Pricing copy', segments: null, asset: '0123456789abcdef.md' };
  const read = run([{ persona: 'a', pages: ['asset:0123456789abcdef.md'], problems: ['wording'] }], { pois: [text] }).report;
  assert.deepEqual(only(read.coverage).thin_pages, [], 'a text is one place, and the report already says how few read it');
  assert.deepEqual(only(read.coverage).curve, [1]);

  const design: Poi = { id: 'flow', type: 'design', name: 'Checkout', segments: null, frames: [{ asset: '0123456789abcdef.png', name: null }, { asset: 'fedcba9876543210.png', name: null }] };
  const seen = run(['a', 'b', 'c'].map((persona, i) => ({ persona, pages: ['asset:0123456789abcdef.png', ...(i ? [] : ['asset:fedcba9876543210.png'])] })), { pois: [design] }).report;
  assert.deepEqual(only(seen.coverage).thin_pages.map(({ personas: n }) => n), [1], 'a screen few reached is listed');
});

test('nobody on a POI means no coverage for it, and the rebuild is identical', () => {
  const { report, events } = run([{ persona: 'a', poi: 'app' }], { pois: [web('app'), web('docs')] });
  assert.deepEqual(report.coverage?.map(({ poi_id }) => poi_id), ['app']);
  assert.deepEqual(buildReport(structuredClone(events)), report);
});
