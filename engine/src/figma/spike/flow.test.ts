import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseFile, type FigmaFile } from './flow.ts';

const file: FigmaFile = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const [checkout, ...rest] = parseFile(file);
const hot = (screen: string, id: string) => checkout.screens[screen].hotspots.find((h) => h.id === id);

test('only pages with a flow starting point are prototypes, and only screens reachable from it are kept', () => {
  assert.equal(rest.length, 0, 'the Scratch page has no starting point');
  assert.deepEqual(checkout.flows, [{ name: 'Guest checkout', start: '1:1' }]);
  // 6:1 is on the canvas but nothing leads to it; 2:7 is only a scroll target, not a screen.
  assert.deepEqual(Object.keys(checkout.screens).sort(), ['1:1', '2:1', '3:1', '3:4', '4:1', '5:1']);
});

test('hotspot boxes are relative to their screen; hidden layers and layers without interactions are skipped', () => {
  assert.deepEqual(checkout.screens['1:1'].hotspots.map((h) => h.id), ['1:2', '1:3', '1:6']);
  assert.deepEqual(hot('1:1', '1:2'), {
    id: '1:2', name: 'Checkout button', box: [24, 700, 327, 48], fixed: false, trigger: 'click', ms: null,
    actions: [{ kind: 'navigate', to: '2:1', transition: 'SMART_ANIMATE', at: null }],
  });
  assert.deepEqual(hot('2:1', '2:3')?.box, [8, 12, 32, 32], 'shifted by the Shipping frame at x=500');
});

test('overlays, swaps, back, close, links and scroll targets become actions', () => {
  assert.deepEqual(hot('1:1', '1:3')?.actions, [{ kind: 'overlay', to: '3:1', transition: null, at: { x: 37, y: 300 } }]);
  assert.deepEqual(hot('3:1', '3:3')?.actions, [{ kind: 'swap', to: '3:4', transition: null, at: null }]);
  assert.deepEqual(hot('3:1', '3:2')?.actions, [{ kind: 'close' }]);
  assert.deepEqual(hot('2:1', '2:3')?.actions, [{ kind: 'back' }]);
  assert.deepEqual(hot('2:1', '2:5')?.actions, [{ kind: 'link', url: 'https://example.test/terms' }]);
  assert.deepEqual(hot('2:1', '2:6')?.actions, [{ kind: 'scroll_to', to: '2:7', transition: 'SCROLL_ANIMATE', at: null }]);
});

test('scrolling and fixed layers: a scroll frame has hotspots below its fold, a fixed header does not move', () => {
  const shipping = checkout.screens['2:1'];
  assert.equal(shipping.scroll, 'vertical');
  assert.equal(checkout.screens['1:1'].scroll, 'none');
  const below = shipping.hotspots.filter((h) => h.box[1] >= shipping.size[1]).map((h) => h.id);
  assert.deepEqual(below, ['2:4', '2:5'], 'Continue (y=1100) and Terms (y=900) are past an 812px viewport');
  assert.equal(hot('2:1', '2:3')?.fixed, true);
  assert.equal(hot('2:1', '2:4')?.fixed, false);
});

test("a frame's own timer is a whole-screen hotspot", () => {
  const timer = checkout.screens['4:1'].hotspots[0];
  assert.deepEqual([timer.id, timer.box, timer.trigger, timer.ms], ['4:1', [0, 0, 375, 812], 'timeout', 3000]);
  assert.equal(timer.actions[0].kind, 'navigate');
});

test('what cannot be rebuilt is reported, and conditional branches that can be followed are kept and marked', () => {
  assert.deepEqual(checkout.unsupported.map((u) => `${u.at} ${u.kind}`).sort(), ['1:6 CHANGE_TO', '2:4 CONDITIONAL', '2:4 MISSING_DESTINATION', '2:4 SET_VARIABLE']);
  assert.deepEqual(hot('2:1', '2:4')?.actions, [{ kind: 'navigate', to: '4:1', transition: 'DISSOLVE', at: null, conditional: true }]);
  assert.deepEqual(hot('1:1', '1:6')?.actions, [], 'still tappable, but nothing to play');
});

test('a response without a DOCUMENT node is refused', () => {
  assert.throws(() => parseFile({} as FigmaFile), /no DOCUMENT/);
});

test('nothing outside the spike folder imports it', () => {
  const root = join(import.meta.dirname, '../../../..');
  const spike = join('figma', 'spike');
  const offenders = ['engine/src', 'simulation/src', 'app/src'].flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && !f.includes(spike))
      .filter((f) => readFileSync(join(root, dir, f), 'utf8').includes('figma/spike'))
      .map((f) => join(dir, f)),
  );
  assert.deepEqual(offenders, []);
});
