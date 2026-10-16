import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetPath, importAsset, importLocalFile, importText, readAsset } from './assets.ts';
import { createFsBlobStore } from './log/blobs.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test('pasted text and local files land in assets/ under a content id, and read back', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const blobs = createFsBlobStore(join(dir, 'project'));
  const pasted = await importText(blobs, '# Pricing\nStarter is €10.', 'Pricing');
  assert.match(pasted.id, /^[0-9a-f]{16}\.md$/);
  assert.deepEqual({ ...pasted, id: '' }, { id: '', name: 'Pricing.md', mime: 'text/markdown', bytes: 27 });
  assert.equal(new TextDecoder().decode(await readAsset(blobs, pasted.id)), '# Pricing\nStarter is €10.');
  assert.equal((await importText(blobs, '# Pricing\nStarter is €10.')).id, pasted.id, 'the same content is one asset');

  const file = join(dir, '../evil name.png');
  writeFileSync(file, PNG);
  t.after(() => rmSync(file, { force: true }));
  const image = await importLocalFile(blobs, file);
  assert.match(image.id, /^[0-9a-f]{16}\.png$/);
  assert.equal(image.name, 'evil name.png');
  assert.deepEqual(readdirSync(join(dir, 'project', 'assets')).sort(), [image.id, pasted.id].sort());
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'project', 'assets', image.id))), PNG);
});

test('imports refuse unknown types, wrong contents, empty or oversized files, and ids that are not ids', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const blobs = createFsBlobStore(dir);
  await assert.rejects(importAsset(blobs, { name: 'brief.pdf', data: new Uint8Array([1]) }), /imports \.md, \.txt, \.png, \.jpg, \.jpeg, \.webp files, not "brief\.pdf"/);
  await assert.rejects(importAsset(blobs, { name: 'shot.png', data: new TextEncoder().encode('<svg/>') }), /"shot\.png" is not a PNG image/);
  await assert.rejects(importAsset(blobs, { name: 'copy.txt', data: new Uint8Array([0xff, 0xfe, 0x00]) }), /"copy\.txt" is not UTF-8 text/);
  await assert.rejects(importAsset(blobs, { name: 'copy.txt', data: new Uint8Array() }), /"copy\.txt" is empty/);
  await assert.rejects(importText(blobs, 'x'.repeat(2 * 1024 * 1024 + 1)), /larger than 2 MB/);
  const elsewhere = mkdtempSync(join(tmpdir(), 'gnomi-assets-src-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  mkdirSync(join(elsewhere, 'folder.md'));
  await assert.rejects(importLocalFile(blobs, join(elsewhere, 'folder.md')), /"folder\.md" is not a file/);
  await assert.rejects(importLocalFile(blobs, join(elsewhere, 'missing.md')), /ENOENT/);
  for (const id of ['../project.sqlite', 'sessions/recruiter.session', '0123456789abcdef.md/../../x', '0123456789ABCDEF.md']) assert.throws(() => assetPath(id), /is not an asset id/);
  assert.deepEqual(readdirSync(dir), [], 'nothing was written');
});
