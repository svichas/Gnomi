import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GnomiEvent, Outcome, Poi, Report, ReportFlow, ReportPersona, WebPoi } from '../types.ts';
import { buildReport } from './build.ts';
import { buildFlow, FLOW_PAGES } from './flow.ts';
import { reportToMarkdown } from './markdown.ts';

const at = (path: string) => `http://gym.test${path}`;
const page = (path: string) => `gym.test${path}`;
const web = (id: string, mode: WebPoi['mode'] = 'full'): WebPoi => ({ id, type: 'web', name: id, start_url: at('/'), allowed_hosts: [], production_domains: [], reset_hook_url: null, mode, segments: null });
const persona = (id: string, outcome: Outcome, pois?: Record<string, Outcome>) => ({ id, outcome, ...(pois && { pois }) }) as ReportPersona;

/** A persona's steps: each pair of paths is where a step started and ended. */
function steps(persona_id: string, moves: [from: string, to: string][], poi_id: string | null = 'poi'): GnomiEvent[] {
  return moves.map(([from, to], i) => ({
    run_id: 'r-1', round: 1, persona_id, poi_id, type: 'persona.step', seq: 0, ts: 0,
    payload: { step_no: i + 1, action: { type: 'click', ref: 'e1', text: null }, target: null, result: { ok: true, url_before: at(from), url_after: at(to), dom_changed: true, error: null }, thought: '', feeling: 0, snapshot_hash: 'h', screenshot: null, duration_ms: 1, heard_post_ids: [] },
  }) as GnomiEvent);
}

const flow = (events: GnomiEvent[], personas: ReportPersona[], pois: WebPoi[] = [web('poi')]) => buildFlow(events, pois, personas, 'poi');
const pageOf = (f: ReportFlow, path: string) => f.pages.find((p) => p.page === page(path));

test('a persona going back and forth counts once per direction and once per page, and ends where it stopped', () => {
  const [f] = flow(steps('a', [['/', '/jobs'], ['/jobs', '/'], ['/', '/jobs'], ['/jobs', '/jobs/new']]), [persona('a', 'done')]);
  assert.equal(f.personas, 1);
  assert.deepEqual(f.pages.map((p) => [p.page, p.reached, p.ended]), [[page('/'), 1, {}], [page('/jobs'), 1, {}], [page('/jobs/new'), 1, { done: 1 }]]);
  assert.deepEqual(f.moves.map((m) => [m.from, m.to, m.personas]), [[page('/'), page('/jobs'), 1], [page('/jobs'), page('/'), 1], [page('/jobs'), page('/jobs/new'), 1]]);
});

test('moves count personas, not steps, and the page a persona ended on takes its outcome', () => {
  const events = [...steps('a', [['/', '/jobs']]), ...steps('b', [['/', '/jobs'], ['/jobs', '/help']]), ...steps('c', [['/', '/jobs']])];
  const [f] = flow(events, [persona('a', 'done'), persona('b', 'budget_exceeded'), persona('c', 'abandoned')]);
  assert.deepEqual(pageOf(f, '/jobs'), { page: page('/jobs'), reached: 3, ended: { done: 1, abandoned: 1 } });
  assert.deepEqual(pageOf(f, '/help')?.ended, { budget_exceeded: 1 });
  assert.equal(f.moves.find((m) => m.to === page('/jobs'))?.personas, 3);
});

test('a persona who never moves reached one page and made no move, and ids in a URL are one page', () => {
  const [f] = flow(steps('a', [['/jobs/12', '/jobs/12'], ['/jobs/34', '/jobs/34']]), [persona('a', 'repeated_failure')]);
  assert.deepEqual(f.pages, [{ page: page('/jobs/:id'), reached: 1, ended: { repeated_failure: 1 } }]);
  assert.deepEqual(f.moves, []);
});

test('giving up on the first page ends there', () => {
  const [f] = flow([...steps('a', [['/', '/']]), ...steps('b', [['/', '/jobs']])], [persona('a', 'abandoned'), persona('b', 'done')]);
  assert.deepEqual(pageOf(f, '/'), { page: page('/'), reached: 2, ended: { abandoned: 1 } });
});

test('a redirect that lands between two steps is a move too', () => {
  const [f] = flow(steps('a', [['/', '/'], ['/home', '/home']]), [persona('a', 'done')]);
  assert.deepEqual(f.moves.map((m) => [m.from, m.to]), [[page('/'), page('/home')]]);
});

test('past the cap the most reached pages stay and the rest are counted, with who ended there', () => {
  const walk = Array.from({ length: FLOW_PAGES + 3 }, (_, i): [string, string] => [`/a${i}`, `/a${i + 1}`]);
  const events = [...steps('a', walk), ...steps('b', walk.slice(0, 2)), ...steps('c', walk.slice(0, 2))];
  const [f] = flow(events, [persona('a', 'abandoned'), persona('b', 'done'), persona('c', 'done')]);
  assert.equal(f.pages.length, FLOW_PAGES);
  assert.deepEqual(f.pages.slice(0, 3).map((p) => p.reached), [3, 3, 3]);
  assert.deepEqual(f.left_out, { pages: 4, ended: 1 });
  const shown = new Set(f.pages.map((p) => p.page));
  assert.ok(f.moves.every((m) => shown.has(m.from) && shown.has(m.to)), 'no move points at a page that is not there');
});

test('each POI gets its own flow from its own steps, with its own outcome', () => {
  const events = [...steps('a', [['/', '/jobs']], 'one'), ...steps('a', [['/', '/billing']], 'two')];
  const flows = flow(events, [persona('a', 'abandoned', { one: 'done', two: 'abandoned' })], [web('one'), web('two')]);
  assert.deepEqual(flows.map((f) => [f.poi_id, f.pages.at(-1)?.page, f.pages.at(-1)?.ended]), [['one', page('/jobs'), { done: 1 }], ['two', page('/billing'), { abandoned: 1 }]]);
});

test('a POI nobody stepped on gets no flow', () => {
  assert.deepEqual(flow(steps('a', [['/', '/']], 'one'), [persona('a', 'done')], [web('one'), web('two')]).map((f) => f.poi_id), ['one']);
});

// The report's own fold: a competitor and a text are left out, and a log from before POIs has its steps on no POI.
function logged(pois: Poi[], extra: GnomiEvent[]): Report {
  const config = { run_id: 'r-1', seed: 1, personas: [{ id: 'a', name: 'A', segment_id: null, device: 'desktop' }], sessions: [], project: { name: 'Gym', pois, goal: 'Post a job', role: null } };
  const started = { run_id: 'r-1', round: 0, persona_id: null, poi_id: null, type: 'run.started', seq: 0, ts: 0, payload: { config } } as unknown as GnomiEvent;
  return buildReport([started, ...extra].map((e, i) => ({ ...e, seq: i + 1 })));
}

test("a competitor's site gets no flow, and neither does a text", () => {
  const text = { id: 'text', type: 'text', name: 'Terms', blob: 'b', chars: 10, segments: null } as unknown as Poi;
  const report = logged([web('ours'), web('rival', 'observe_only'), text], [...steps('a', [['/', '/jobs']], 'ours'), ...steps('a', [['/', '/pricing']], 'rival'), ...steps('a', [['/', '/']], 'text')]);
  assert.deepEqual(report.flows?.map((f) => [f.poi_id, f.pages.map((p) => p.page)]), [['ours', [page('/'), page('/jobs')]]]);
});

test('a log whose steps name no POI is read as its first, and a run with no step has no flow', () => {
  const report = logged([web('ours')], steps('a', [['/', '/jobs']], null));
  assert.deepEqual(report.flows?.map((f) => [f.poi_id, f.personas]), [['ours', 1]]);
  assert.equal(logged([web('ours')], []).flows, undefined);
});

test('Markdown carries the same counts, says what was left out and says "ended here"', () => {
  const walk = Array.from({ length: FLOW_PAGES + 1 }, (_, i): [string, string] => [`/a${i}`, `/a${i + 1}`]);
  const md = reportToMarkdown(logged([web('ours')], steps('a', walk, 'ours')));
  assert.match(md, /## Where personas went/);
  assert.match(md, /\| gym\.test\/a0 \| 1 \| 0 \| gym\.test\/a1 \(1\) \|/);
  assert.match(md, /2 less visited pages left out, where 1 persona ended/);
  assert.match(md, /Ended here" says where an episode ended, not why/);
  assert.doesNotMatch(md, /dropped off/i);
  assert.equal(reportToMarkdown({ ...logged([web('ours')], []), flows: undefined }).includes('Where personas went'), false, 'an older report has no such section');
});
