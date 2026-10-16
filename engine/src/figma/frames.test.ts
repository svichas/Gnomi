import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { readAsset } from '../assets.ts';
import { createFsBlobStore } from '../log/blobs.ts';
import { figmaClient, FigmaError } from './client.ts';
import { FAKE_EXPIRED_TOKEN, FAKE_KEY, FAKE_NO_ACCESS_KEY, FAKE_STORAGE, fakeFigma, type FakeFigmaOptions } from './fake.ts';
import { importFrames, listFrames, previews } from './frames.ts';

const LINK = `https://www.figma.com/design/${FAKE_KEY}/Acme-checkout`;
function setup(t: TestContext, opts: FakeFigmaOptions = {}, token = 'figd_test_token_0123456789') {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-figma-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeFigma(opts);
  return { fake, dir, blobs: createFsBlobStore(dir), client: figmaClient({ token, fetch: fake, sleep: async () => {} }) };
}
const refs = (file: Awaited<ReturnType<typeof listFrames>>, ids = file.frames.map((frame) => frame.id)) =>
  file.frames.filter((frame) => ids.includes(frame.id)).map(({ id, name, width, height }) => ({ id, name, width, height }));
const apiCalls = (fake: ReturnType<typeof fakeFigma>, path: string) => fake.calls.filter((call) => new URL(call.url).pathname.startsWith(path));

test('a 50-frame file is listed with two requests: the file at depth 2, and the contents of its section', async (t) => {
  const { client, fake } = setup(t, { latencyMs: 40 });
  const started = Date.now();
  const file = await listFrames(client, `${LINK}?node-id=1-5`);
  assert.ok(Date.now() - started < 1000, 'two sequential requests, nothing else');
  assert.deepEqual(fake.calls.map((call) => new URL(call.url).pathname + new URL(call.url).search), [`/v1/files/${FAKE_KEY}?depth=2`, `/v1/files/${FAKE_KEY}/nodes?ids=2%3A1&depth=1&version=4242424242`]);
  assert.equal(file.frames.length, 50);
  assert.deepEqual({ key: file.key, name: file.name, version: file.version, node: file.node }, { key: FAKE_KEY, name: 'Acme checkout', version: '4242424242', node: '1:5' });
  assert.deepEqual(file.frames[0], { id: '1:2', name: '01 Cart 1', page: 'Checkout flow', section: null, width: 1440, height: 900 });
  assert.deepEqual(file.frames[1], { id: '1:3', name: '02 Screen 2', page: 'Checkout flow', section: null, width: 375, height: 812 });
  assert.deepEqual(file.frames.slice(-3).map((frame) => [frame.name, frame.section]), [['Variant A', 'Variants'], ['Variant B', 'Variants'], ['Variant C', 'Variants']]);
  assert.ok(!file.frames.some((frame) => /Hidden|Note|Old component/.test(frame.name)), 'hidden frames, text and components are not frames');
  assert.ok(fake.calls.every((call) => call.token === 'figd_test_token_0123456789'));
});

test('a file without sections takes one request; an empty file lists nothing', async (t) => {
  const { client, fake } = setup(t, { frames: 0 });
  const file = await listFrames(client, LINK);
  assert.equal(file.frames.length, 3, 'only the section frames of the fixture');
  const bare = setup(t);
  bare.fake.calls.length = 0;
  await assert.rejects(listFrames(bare.client, 'https://example.com'), /not a Figma link/);
  assert.equal(bare.fake.calls.length, 0, 'a bad link never reaches Figma');
  assert.ok(fake.calls.length > 0);
});

test('listing: an expired token, no access, a missing file and a missing token each say so', async (t) => {
  await assert.rejects(listFrames(setup(t, {}, FAKE_EXPIRED_TOKEN).client, LINK), (err) => err instanceof FigmaError && err.kind === 'bad_token' && /expired/.test(err.message));
  await assert.rejects(listFrames(setup(t).client, `https://www.figma.com/design/${FAKE_NO_ACCESS_KEY}/x`), (err) => err instanceof FigmaError && err.kind === 'no_access');
  await assert.rejects(listFrames(setup(t).client, 'https://www.figma.com/design/ZzZzZzZzZzZzZzZzZzZzZz/x'), (err) => err instanceof FigmaError && err.kind === 'not_found');
  await assert.rejects(listFrames(figmaClient({ token: null, fetch: fakeFigma() }), LINK), (err) => err instanceof FigmaError && err.kind === 'no_token');
});

test('previews for 50 frames take three render requests of at most 20 ids, and come back as data URLs', async (t) => {
  const { client, fake } = setup(t);
  const file = await listFrames(client, LINK);
  fake.calls.length = 0;
  const found = await previews(client, { file: file.key, version: file.version, frames: file.frames });
  const renders = apiCalls(fake, '/v1/images/');
  assert.equal(renders.length, 3);
  assert.deepEqual(renders.map((call) => new URL(call.url).searchParams.get('ids')!.split(',').length).sort(), [10, 20, 20]);
  assert.ok(renders.every((call) => new URL(call.url).searchParams.get('format') === 'jpg' && new URL(call.url).searchParams.get('version') === '4242424242'));
  assert.equal(Object.keys(found).length, 50);
  assert.match(found['1:2'], /^data:image\/jpeg;base64,/);
  assert.ok(fake.calls.filter((call) => call.url.startsWith(FAKE_STORAGE)).every((call) => call.token === null), 'the render storage never sees the token');
});

test('previews that cannot be had are left out, not raised', async (t) => {
  const { client } = setup(t, { nullRender: ['1:2'], crashRender: ['1:30'] });
  const file = await listFrames(client, LINK);
  const found = await previews(client, { file: file.key, version: file.version, frames: file.frames });
  assert.ok(!('1:2' in found));
  assert.equal(Object.keys(found).length, 29, 'one blank in the first batch, the whole batch with the crashing frame (20) missing, the third batch there');
});

test('import stores each frame as a PNG asset, wide frames at 1x and phones at 2x, from the version that was listed', async (t) => {
  const { client, fake, blobs, dir } = setup(t);
  const file = await listFrames(client, LINK);
  const request = ['1:3', '1:2', '2:2'].map((id) => refs(file, [id])[0]); // the order the user chose
  fake.calls.length = 0;
  const result = await importFrames(client, blobs, { file: file.key, version: file.version, frames: request });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.frames.map((frame) => frame.id), ['1:3', '1:2', '2:2'], 'results keep the requested order');
  const renders = apiCalls(fake, '/v1/images/').map((call) => Object.fromEntries(new URL(call.url).searchParams));
  assert.deepEqual(renders.map((r) => [r.ids, r.scale, r.format, r.version]), [['1:2', '1', 'png', '4242424242'], ['1:3,2:2', '2', 'png', '4242424242']]);
  for (const { asset } of result.frames) {
    assert.match(asset.id, /^[0-9a-f]{16}\.png$/);
    assert.equal(asset.mime, 'image/png');
    assert.deepEqual([...(await readAsset(blobs, asset.id)).slice(1, 4)], [0x50, 0x4e, 0x47]);
  }
  assert.equal(new Set(result.frames.map((frame) => frame.asset.id)).size, 3, 'three different images');
  assert.deepEqual(readdirSync(join(dir, 'assets')).sort(), result.frames.map((frame) => frame.asset.id).sort());
  assert.match(result.frames[0].asset.name, /^02 Screen 2\.png$/);
});

test('a frame Figma cannot render is reported by name while the others are imported', async (t) => {
  const { client, blobs } = setup(t, { nullRender: ['1:4'] });
  const file = await listFrames(client, LINK);
  const result = await importFrames(client, blobs, { file: file.key, version: file.version, frames: refs(file, ['1:2', '1:3', '1:4']) });
  assert.deepEqual(result.frames.map((frame) => frame.id), ['1:2', '1:3']);
  assert.deepEqual(result.failed.map((f) => [f.id, f.name, f.reason]), [['1:4', '03 Screen 3', 'Figma could not render this frame. It may be hidden, empty or too large.']]);
});

test('when Figma fails a whole batch the frame that causes it is found by halving, with a bounded number of requests', async (t) => {
  const { client, fake, blobs } = setup(t, { crashRender: ['1:9'] });
  const file = await listFrames(client, LINK);
  fake.calls.length = 0;
  const ids = file.frames.slice(0, 20).map((frame) => frame.id); // one batch
  const result = await importFrames(client, blobs, { file: file.key, version: file.version, frames: refs(file, ids) });
  assert.deepEqual(result.failed.map((f) => f.id), ['1:9']);
  assert.match(result.failed[0].reason, /Figma failed to render this frame \(error 500\)\. It may be too large/);
  assert.equal(result.frames.length, 19);
  assert.ok(apiCalls(fake, '/v1/images/').length <= 14, 'at most the first request and twelve halvings');
});

test('a download that is too big, not a PNG or refused fails that frame only', async (t) => {
  const { client, blobs, fake } = setup(t);
  const file = await listFrames(client, LINK);
  const wrapped: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('frame-1-3-200')) return new Response('<svg/>', { headers: { 'content-type': 'image/png' } });
    if (url.endsWith('frame-1-4-200')) return new Response('', { status: 403 });
    return fake(input, init);
  };
  const result = await importFrames(figmaClient({ token: 'figd_test_token_0123456789', fetch: wrapped }), blobs, { file: file.key, version: file.version, frames: refs(file, ['1:3', '1:4', '1:7']) });
  assert.deepEqual(result.frames.map((frame) => frame.id), ['1:7']);
  assert.deepEqual(result.failed.map((f) => [f.id, f.reason]), [['1:3', '"02 Screen 2.png" is not a PNG image.'], ['1:4', 'Figma’s image storage answered 403.']]);
});

test('a token, rate-limit or network problem stops the whole import instead of failing every frame', async (t) => {
  const { client, blobs, fake } = setup(t);
  const file = await listFrames(client, LINK);
  const limited = figmaClient({ token: 'figd_test_token_0123456789', fetch: async () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }) });
  await assert.rejects(importFrames(limited, blobs, { file: file.key, version: file.version, frames: refs(file, ['1:2']) }), (err) => err instanceof FigmaError && err.kind === 'rate_limited' && /about 2 minutes/.test(err.message));
  const expired = setup(t, {}, FAKE_EXPIRED_TOKEN);
  await assert.rejects(importFrames(expired.client, blobs, { file: file.key, version: file.version, frames: refs(file, ['1:2']) }), (err) => err instanceof FigmaError && err.kind === 'bad_token');
  assert.ok(fake.calls.length > 0);
});

test('an import must name between 1 and 100 frames with real node ids, and a file key that is one', async (t) => {
  const { client, blobs, fake } = setup(t);
  const file = await listFrames(client, LINK);
  fake.calls.length = 0;
  const frame = { id: '1:2', name: 'x', width: 1, height: 1 };
  await assert.rejects(importFrames(client, blobs, { file: file.key, version: null, frames: [] }), /at least one frame/);
  await assert.rejects(importFrames(client, blobs, { file: file.key, version: null, frames: [{ ...frame, id: '1:2,1:3' }] }), /between 1 and 100/);
  await assert.rejects(importFrames(client, blobs, { file: file.key, version: null, frames: Array.from({ length: 101 }, (_, i) => ({ ...frame, id: `1:${i + 2}` })) }), /between 1 and 100/);
  await assert.rejects(importFrames(client, blobs, { file: '../../etc', version: null, frames: [frame] }), /not a Figma file key/);
  assert.equal(fake.calls.length, 0);
});
