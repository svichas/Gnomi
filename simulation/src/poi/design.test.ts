// The static-design POI on Gym v3's frames (demo/GymSite/defects.yaml D26): a scripted "vision" model reads each frame through a lookup of
// what the frame's HTML says, so the test checks the expectation loop, not a model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { assetFile, gymAssets } from '../../../demo/GymSite/assets.ts';
import { framePlan } from '../../../demo/GymSite/design.ts';
import { importLocalFile } from '../assets.ts';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, DEMO_NAVIGATOR, DEMO_SURVEY } from '../llm/scripted.ts';
import { createFsBlobStore } from '../log/blobs.ts';
import { openProject } from '../log/sqlite.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import { reportToMarkdown } from '../report/markdown.ts';
import { createRecorder, newRunConfig, startRun } from '../run.ts';
import type { BrowserPool, LlmRequest, UserPart } from '../seams.ts';
import { DEFAULT_SETTINGS, PROVIDER_DEFAULTS } from '../settings.ts';
import type { DesignPoi, EventOf, ProjectConfig } from '../types.ts';
import { designSchema } from './design-prompt.ts';
import { decodePng, encodePng, FRAME_EDGE, frameForModel } from './frames.ts';
import { preflight } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'gnomi-design-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const visible = (html: string) => html.replace(/<style>.*?<\/style>/s, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// What each Gym frame shows, keyed by the downscaled image the model is sent.
const shows = new Map(framePlan().map(({ key, html }) => [sha(frameForModel(readFileSync(assetFile(key)), 'image/png').data), visible(html)]));

/** A shopper who expects a confirmation once the order is placed, and says so when a screen is not one. */
function shopper(req: LlmRequest<unknown>) {
  if (req.purpose === 'survey') return DEMO_SURVEY;
  assert.equal(req.purpose, 'design');
  assert.doesNotMatch(req.system, /no more than about|screens, or fewer/, 'the engine-enforced budget does not show through');
  const images = req.user.filter((p): p is Extract<UserPart, { type: 'image' }> => p.type === 'image');
  assert.ok(images.length >= 1 && images.length <= 2, 'only the current screen and the one before it');
  const screen = shows.get(sha(images.at(-1)!.data));
  assert.ok(screen, 'every image sent is a downscaled Gym frame');
  const text = req.user.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  const expected = /expected next: "([^"]*)"/.exec(text)?.[1] ?? null;
  const confirmation = expected?.includes('confirmation') ?? false;
  const matched = expected === null ? null : !confirmation || screen.includes('Your order is placed');
  return {
    thought: matched === false ? 'Wait, I just paid. Why is it asking me to sign in now?' : 'Looks fine so far.',
    feeling: matched === false ? -2 : 0,
    matched,
    sees: screen.slice(0, 120),
    would_do: screen.includes('Place order') ? 'Click Place order' : 'Carry on',
    expects_next: screen.includes('Place order') ? 'A confirmation that my order is placed' : 'The next step',
    action: 'continue',
    reason: null,
    friction: matched === false ? { severity: 3, what: 'Expected a confirmation, saw a sign-in prompt', expected: 'A confirmation that my order is placed' } : null,
    opinion: null,
  };
}

const project = (pois: DesignPoi[], navigator = PROVIDER_DEFAULTS.anthropic.navigator): ProjectConfig => ({
  name: 'Fieldhouse', description: '', pois, goal: 'Buy the rain jacket in the cart as a guest', role: null, audience: null,
  settings: { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, navigator } },
});

const noBrowser = { newPage: () => Promise.reject(new Error('A design run opens no page')) } as unknown as BrowserPool;

async function runCheckout(defects: 'D26' | 'none', navigator = shopper, name: string = defects) {
  const folder = join(dir, name);
  const store = openProject(folder);
  const blobs = createFsBlobStore(folder);
  const frames = await Promise.all(gymAssets({ defects }).frames.checkout.map((path) => importLocalFile(blobs, path)));
  const poi: DesignPoi = { id: 'checkout', type: 'design', name: 'Checkout', segments: null, frames: frames.map((f, i) => ({ asset: f.id, name: i === 3 ? 'After placing the order' : null })) };
  const config = store.createRun(newRunConfig(project([poi]), { personas: [BUILTIN_PERSONA], sessions: [], reset: false }));
  const record = createRecorder(store, () => {});
  const llm = createScriptedGateway({ navigator, judge: DEMO_JUDGE, author: DEMO_AUTHOR }, record);
  const report = await startRun(config, { store, blobs, browsers: noBrowser, llm, record, sessions: null }).done;
  const events = store.events(config.run_id);
  store.close();
  return { poi, report, events };
}

test('a PNG frame is shrunk to the model edge and decodes again; a small one goes as it is', () => {
  const big = readFileSync(gymAssets({ defects: 'D26' }).frames.checkout[3]);
  const sent = frameForModel(big, 'image/png');
  const decoded = decodePng(sent.data);
  assert.deepEqual([decoded?.width, decoded?.height], [FRAME_EDGE, 640], '1280 × 800 keeps its shape');
  assert.ok(sent.data.length < big.length * 2);
  // Two red and two blue columns average to one red and one blue pixel.
  const rgb = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
  const small = frameForModel(encodePng(4, 2, rgb), 'image/png', 2);
  assert.deepEqual([...decodePng(small.data)!.rgb], [255, 0, 0, 0, 0, 255]);
  const tiny = encodePng(4, 2, rgb);
  assert.equal(frameForModel(tiny, 'image/png').data, tiny, 'already under the edge');
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(frameForModel(jpeg, 'image/jpeg').data, jpeg, 'JPEG is not decoded here');
});

test('a design run refuses a navigator that cannot see images, an empty design and a missing frame', () => {
  const poi: DesignPoi = { id: 'd', type: 'design', name: 'Checkout', segments: null, frames: [{ asset: '0123456789abcdef.png', name: null }] };
  const has = () => true;
  assert.equal(preflight(project([poi]), has), null);
  assert.equal(preflight(project([poi], PROVIDER_DEFAULTS.deepseek.navigator), has), null, 'DeepSeek V4.1-Flash reads images');
  assert.match(preflight(project([poi], { provider: 'deepseek', model: 'deepseek-v4-pro' }), has) ?? '', /^"Checkout" is a design, and the navigator model \(DeepSeek deepseek-v4-pro\) reads text only\./);
  assert.match(preflight(project([poi], PROVIDER_DEFAULTS.openai_compatible.navigator), has) ?? '', /cannot tell whether the local endpoint's navigator model \(gemma4:e4b\) can see images/);
  assert.equal(preflight(project([{ ...poi, frames: [] }]), has), '"Checkout" has no frames. Add at least one image, or remove it.');
  assert.equal(preflight(project([poi]), () => false), 'Frame 1 of "Checkout" is missing from the project\'s assets. Add the image again, or remove the frame.');
});

test('D26: the checkout run reports the expectation mismatch on frame 4 with the frame as evidence; the control run has none', async () => {
  const defect = await runCheckout('D26');
  const frictions = defect.events.filter((e): e is EventOf<'persona.friction_reported'> => e.type === 'persona.friction_reported');
  assert.deepEqual(frictions.map((f) => f.payload.frame), [3], 'one mismatch, on the frame where the expectation failed');
  assert.equal(frictions[0].payload.where.url, `asset:${defect.poi.frames[3].asset}`);
  const steps = defect.events.filter((e): e is EventOf<'persona.step'> => e.type === 'persona.step');
  assert.deepEqual(steps.map((s) => s.payload.frame), [0, 1, 2, 3, 4, 5], 'one step per frame, in order');
  assert.equal(steps[3].payload.target?.name, 'After placing the order');
  assert.ok(defect.events.some((e) => e.type === 'persona.goal_done'), 'the persona looked through every frame');

  const [friction] = defect.report.frictions;
  assert.equal(friction.frame, 3);
  assert.equal(friction.quote, 'Wait, I just paid. Why is it asking me to sign in now?', 'the persona is quoted');
  assert.equal(friction.screenshot, `assets/${defect.poi.frames[3].asset}`, 'the frame is the evidence image');
  const evidence = defect.report.themes?.flatMap((t) => t.evidence) ?? [];
  assert.ok(evidence.some((e) => e.frame === 3 && e.screenshot === friction.screenshot));
  const markdown = reportToMarkdown(defect.report);
  assert.match(markdown, /- Frame: 4/);

  const control = await runCheckout('none');
  assert.equal(control.events.filter((e) => e.type === 'persona.friction_reported').length, 0, 'the control frame 4 is the confirmation');
  assert.equal(control.report.frictions.length, 0);
  assert.ok(control.events.some((e) => e.type === 'persona.goal_done'), 'and its persona still saw every frame');
});

test('a mismatch the persona gave no words for is filed on the frame whose expectation broke, with what was expected and shown', async () => {
  const wordless = (req: LlmRequest<unknown>) => ({ ...shopper(req), ...(req.purpose === 'design' && { friction: null }) });
  const { poi, events } = await runCheckout('D26', wordless, 'D26-wordless');
  const frictions = events.filter((e): e is EventOf<'persona.friction_reported'> => e.type === 'persona.friction_reported');
  assert.deepEqual(frictions.map((f) => [f.payload.frame, f.payload.step_no, f.payload.where.url]), [[2, 3, `asset:${poi.frames[2].asset}`]]);
  assert.match(frictions[0].payload.what, /^Expected A confirmation that my order is placed, but the next screen showed: \S/);
  assert.equal(frictions[0].payload.expected, 'A confirmation that my order is placed');
});

test('the demo responder answers design screens in the schema, with a labelled sample mismatch on the second', () => {
  const ask = (screen: number) => DEMO_NAVIGATOR({ role: 'navigator', model: PROVIDER_DEFAULTS.anthropic.navigator, run_id: 'r', persona_id: 'p', round: 1, purpose: 'design', system: '', user: [{ type: 'text', text: `Screen ${screen} of 3.` }], schema: designSchema });
  const [first, second] = [designSchema.parse(ask(1)), designSchema.parse(ask(2))];
  assert.equal(first.matched, null);
  assert.equal(second.matched, false);
  assert.match(second.friction?.what ?? '', /scripted demo/);
});
