import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createFsBlobStore } from './blobs.ts';

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-blobs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a nested blob round-trips through the store', async (t) => {
  const blobs = createFsBlobStore(tempDir(t));
  const path = 'runs/r-0001/shots/p-001-0001.jpg';
  await blobs.put(path, new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(await blobs.get(path)), new Uint8Array([1, 2, 3]));
});

test('paths that are absolute or resolve outside the root are rejected', async (t) => {
  const blobs = createFsBlobStore(tempDir(t));
  for (const path of ['../x', '/etc/passwd', 'a/../../x', '.']) {
    await assert.rejects(blobs.put(path, new Uint8Array([1])), /outside the project/, path);
    await assert.rejects(blobs.get(path), /outside the project/, path);
  }
});
