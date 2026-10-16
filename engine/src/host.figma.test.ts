// The Figma requests of host.ts, through a fake parent port and the fixture API (GNOMI_FAKE_FIGMA): the token is a secret
// main sends, frames are listed and imported into the open project's assets/, and every failure comes back as a sentence.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FAKE_EXPIRED_TOKEN, FAKE_KEY } from './figma/fake.ts';
import type { Api, EngineToClient, Method } from './protocol.ts';

type Listener = (e: { data: unknown; ports: [] }) => void;
const listeners: Listener[] = [];
const replies = new Map<number, (msg: EngineToClient) => void>();
(process as unknown as { parentPort: unknown }).parentPort = {
  on: (event: string, listener: Listener) => event === 'message' && listeners.push(listener),
  postMessage: (msg: EngineToClient) => msg.kind === 'response' && replies.get(msg.id)?.(msg),
};
process.env.GNOMI_FAKE_LLM = '1';
process.env.GNOMI_FAKE_FIGMA = '1';
await import('./host.ts');
const send = (data: unknown) => listeners.forEach((listener) => listener({ data, ports: [] }));
after(() => send({ kind: 'shutdown' }));

let nextId = 1;
function call<M extends Method>(method: M, params: Api[M]['params']): Promise<Api[M]['result']> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    replies.set(id, (msg) => (msg.kind === 'response' && msg.ok ? resolve(msg.result as Api[M]['result']) : reject(new Error(msg.kind === 'response' && !msg.ok ? msg.error : ''))));
    send({ kind: 'request', id, method, params });
  });
}
const dir = mkdtempSync(join(tmpdir(), 'gnomi-host-figma-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const link = `https://www.figma.com/design/${FAKE_KEY}/Acme?node-id=1-3`;

test('without a token every Figma request says to add one; a bad one is refused with its reason', async () => {
  assert.deepEqual(await call('figma_test', {}), { ok: false, error: 'Add a Figma access token in Settings first.' });
  await assert.rejects(call('figma_frames', { link }), /Add a Figma access token in Settings first/);
  await call('set_secret', { name: 'figma_token', value: FAKE_EXPIRED_TOKEN });
  const test = await call('figma_test', {});
  assert.equal(test.ok, false);
  assert.match(test.error!, /wrong, revoked or expired/);
  await assert.rejects(call('figma_frames', { link }), /wrong, revoked or expired/);
});

test('with a token: frames are listed, previewed and imported into the open project, and the token is forgotten when cleared', async () => {
  await call('set_secret', { name: 'figma_token', value: 'figd_host_test_0123456789' });
  assert.deepEqual(await call('figma_test', {}), { ok: true, error: null });
  await assert.rejects(call('figma_frames', { link: 'https://example.com/design/x' }), /not a Figma link/);
  const file = await call('figma_frames', { link });
  assert.equal(file.frames.length, 50);
  assert.equal(file.node, '1:3');

  const previews = await call('figma_previews', { file: file.key, version: file.version, frames: file.frames.slice(0, 3) });
  assert.deepEqual(Object.keys(previews), ['1:2', '1:3', '1:4']);

  await assert.rejects(call('figma_import', { file: file.key, version: file.version, frames: file.frames.slice(0, 1).map((f) => ({ ...f, name: f.name })) }), /No project is open/);
  await call('open_project', { dir });
  const result = await call('figma_import', { file: file.key, version: file.version, frames: file.frames.slice(0, 2) });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.frames.map((f) => f.id), ['1:2', '1:3']);
  for (const { asset } of result.frames) {
    assert.ok(existsSync(join(dir, 'assets', asset.id)));
    assert.equal((await call('get_blob', { path: `assets/${asset.id}` })).mime, 'image/png');
  }

  await call('set_secret', { name: 'figma_token', value: null });
  await assert.rejects(call('figma_frames', { link }), /Add a Figma access token/);
});
