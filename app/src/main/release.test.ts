import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppUpdater } from 'electron-updater';
import { fetchUpdate } from './release.ts';

type Check = Awaited<ReturnType<AppUpdater['checkForUpdates']>>;
const updater = (check: () => Promise<Check>) => ({ checkForUpdates: check });
const found = (downloadPromise: Promise<string[]>) => async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.3.0' }, downloadPromise }) as Check;
const accepted = () => Promise.resolve();

test('a newer release is ready once it is downloaded and the platform accepts it', async () => {
  assert.deepEqual(await fetchUpdate(updater(found(Promise.resolve([]))), accepted), { version: '0.3.0', ready: true });
});

test('a failed download, or an install the platform refuses (unsigned macOS), offers the download page', async () => {
  assert.deepEqual(await fetchUpdate(updater(found(Promise.reject(new Error('404')))), accepted), { version: '0.3.0', ready: false });
  assert.deepEqual(await fetchUpdate(updater(found(Promise.resolve([]))), () => Promise.reject(new Error('code signature'))), { version: '0.3.0', ready: false });
});

test('a build that does not download (unsigned macOS) offers the download page at once, never waiting on the platform', async () => {
  const notDownloaded = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.3.0' }, downloadPromise: null }) as Check;
  assert.deepEqual(await fetchUpdate(updater(notDownloaded), () => new Promise(() => {})), { version: '0.3.0', ready: false });
});

test('no newer release, an inactive updater or a failed check shows nothing', async () => {
  assert.equal(await fetchUpdate(updater(async () => ({ isUpdateAvailable: false }) as Check), accepted), null);
  assert.equal(await fetchUpdate(updater(async () => null), accepted), null);
  assert.equal(await fetchUpdate(updater(() => Promise.reject(new Error('offline'))), accepted), null);
});
