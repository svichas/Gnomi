import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionTarget, EventPayloads, EventType, GnomiEvent, ScreenLead, Viewport } from '../types.ts';
import { boxesOn, leadsOf, screenLeads } from './pins.ts';

const VIEW: Viewport = [0, 0, 1000, 500];
const JOBS = 'http://gym.test/jobs/new';
const PAGE = 'gym.test/jobs/new';
const [TITLE, SAVE, DEPT] = ['textbox "Job title *"', 'button "Save draft"', 'combobox "Department"'];

test('an element is boxed where its one snapshot line puts it, in percent of the screenshot; missing, on two lines, off screen or in a frame it is not', () => {
  const snapshot = [
    '- main:',
    '  - textbox "Job title *" [ref=e3] [box=100,50,200,25]',
    '  - button "Save draft" [ref=e5] [cursor=pointer] [box=400,450,100,50]',
    '  - link "Help" [ref=e6] [box=100,900,50,20] (off screen, below)',
    '  - button "Delete" [ref=e7] [box=100,100,50,20]',
    '  - button "Delete" [ref=e8] [box=300,100,50,20]',
    '  - iframe [ref=e9]:',
    '    - button "Pay" [ref=f1e2] [box=10,10,80,30]',
  ].join('\n');
  assert.deepEqual(boxesOn(snapshot, [TITLE, SAVE, 'link "Help"', 'button "Delete"', 'button "Pay"', 'link "Gone"'], VIEW), [
    { left: 10, top: 10, width: 20, height: 5, element: TITLE },
    { left: 40, top: 90, width: 10, height: 10, element: SAVE },
  ]);
  // A name with quotes: escaped as the snapshot and a named element have it, unescaped as an action's target has it.
  const quoted = ['button "Say \\"hi\\""', 'button "Say "hi""'];
  assert.deepEqual(boxesOn('- button "Say \\"hi\\"" [ref=e1] [box=0,0,100,50]', quoted, VIEW).map((b) => b.element), quoted);
});

function log(...entries: [type: EventType, persona_id: string | null, payload: object][]): GnomiEvent[] {
  return entries.map(([type, persona_id, payload], i) => ({ run_id: 'r-1', round: 1, persona_id, poi_id: 'poi', type, payload, seq: i + 1, ts: i }) as GnomiEvent);
}
const started = (device = 'desktop', perception?: string) => ({ poi_id: 'poi', device, start_url: JOBS, ...(perception && { perception }) });
const step = (hash: string, viewport: Viewport | null = VIEW, target: ActionTarget = { role: 'button', name: 'Next', box: null }): EventPayloads['persona.step'] => ({
  step_no: 1,
  action: { type: 'click', ref: 'e1', text: null },
  target,
  result: { ok: true, url_before: JOBS, url_after: JOBS, dom_changed: true, error: null },
  thought: '',
  feeling: 0,
  snapshot_hash: hash,
  screenshot: `shots/${hash}.jpg`,
  ...(viewport && { viewport }),
  duration_ms: 1,
  heard_post_ids: [],
});
const about = (element: string): EventPayloads['persona.friction_reported'] => {
  const [, role, name] = /^(\S+) "(.*)"$/.exec(element)!;
  return { step_no: 1, severity: 2, what: `${element} confused me`, expected: 'Something clearer', where: { url: JOBS, ref: 'e2' }, heard_post_ids: [], about: { role, name, box: null } };
};
const line = (element: string, y: number) => `- ${element} [ref=e2] [box=100,${y},200,25]`;
// One page as four steps saw it: the title only (Save below the fold), title and Save, all three, and only a link nobody named.
const snapshots: Record<string, string> = {
  h1: [line(TITLE, 50), line(SAVE, 900)].join('\n'),
  h2: [line(TITLE, 50), line(SAVE, 400)].join('\n'),
  h3: [line(TITLE, 50), line(SAVE, 400), line(DEPT, 200)].join('\n'),
  help: line('link "Help"', 50),
};
const read = async (hash: string) => snapshots[hash] ?? null;
const boxed = (element: string, y: number) => ({ left: 10, top: (y / 500) * 100, width: 20, height: 5, element });

test('a page\'s lead step is the one whose snapshot shows the most of the elements its findings name there, whoever took it', async () => {
  const events = log(
    ['persona.episode_started', 'a1', started()],
    ['persona.step', 'a1', step('h1')],
    ['persona.friction_reported', 'a1', about(TITLE)],
    ['persona.episode_started', 'a2', started()],
    ['persona.step', 'a2', step('h2')],
    ['persona.friction_reported', 'a2', about(SAVE)],
    ['persona.episode_started', 'a3', started()],
    ['persona.step', 'a3', step('h3')],
    ['persona.friction_reported', 'a3', about(DEPT)],
  );
  const lead: ScreenLead = { poi_id: 'poi', page: PAGE, device: 'desktop', persona_id: 'a3', step_seq: 8, screenshot: 'shots/h3.jpg', boxes: [boxed(TITLE, 50), boxed(SAVE, 400), boxed(DEPT, 200)] };
  assert.deepEqual(await screenLeads(events, 'poi', read), [lead]);
  assert.deepEqual(await screenLeads(events.slice(0, 6), 'poi', read), [{ ...lead, persona_id: 'a2', step_seq: 5, screenshot: 'shots/h2.jpg', boxes: [boxed(TITLE, 50), boxed(SAVE, 400)] }], 'whatever shows fewer loses');
  assert.deepEqual(leadsOf([...events, { ...events[0], seq: 10, persona_id: null, type: 'report.screens', payload: { screens: [lead] } } as GnomiEvent]), new Map([[JSON.stringify(['poi', PAGE, 'desktop']), lead]]));
});

test('each device has its own lead; a persona with simulated perception leads only when no other step shows any element; ties go to the earliest', async () => {
  const events = log(
    ['persona.episode_started', 'a1', started('desktop', 'blurredVision')],
    ['persona.step', 'a1', step('h3')],
    ['persona.friction_reported', 'a1', about(TITLE)],
    ['persona.episode_started', 'a2', started()],
    ['persona.step', 'a2', step('h1')],
    ['persona.friction_reported', 'a2', about(SAVE)],
    ['persona.episode_started', 'a3', started()],
    ['persona.step', 'a3', step('h1')],
    ['persona.friction_reported', 'a3', about(DEPT)],
    ['persona.episode_started', 'b1', started('mobile')],
    ['persona.step', 'b1', step('h2', [0, 0, 400, 800])],
  );
  assert.deepEqual((await screenLeads(events, 'poi', read)).map((l) => [l.device, l.persona_id, l.boxes.map((b) => b.element)]), [
    ['desktop', 'a2', [TITLE]], // a1's blurred screenshot shows all three, a3's shows as much as a2's
    ['mobile', 'b1', [TITLE, SAVE]], // b1 named nothing, yet its screen shows what the others did
  ]);
  assert.deepEqual((await screenLeads(events.slice(0, 3), 'poi', read)).map((l) => l.persona_id), ['a1'], 'alone, a1 leads');
});

test('no lead from a step that stored no viewport or whose snapshot is gone, nor for an element only a weak signal names', async () => {
  const old = log(['persona.episode_started', 'a1', started()], ['persona.step', 'a1', step('h3', null)], ['persona.friction_reported', 'a1', about(TITLE)]);
  assert.deepEqual(await screenLeads(old, 'poi', read), [], 'older logs and texts and designs have none');
  const gone = log(['persona.episode_started', 'a1', started()], ['persona.step', 'a1', step('gone')], ['persona.friction_reported', 'a1', about(TITLE)]);
  assert.deepEqual(await screenLeads(gone, 'poi', read), [], 'a snapshot file that is gone shows nothing');
  const help = { role: 'link', name: 'Help', box: [100, 50, 10, 10] as [number, number, number, number] };
  const weak = log(['persona.episode_started', 'a1', started('mobile')], ['persona.step', 'a1', step('help', VIEW, help)], ['signal.small_target', 'a1', { step_no: 1, url: JOBS, ref: 'e1', box: help.box }]);
  assert.deepEqual(await screenLeads(weak, 'poi', read), [], 'a small tap target alone is never a finding');
});
