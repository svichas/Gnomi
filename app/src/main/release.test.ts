import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { AppUpdater } from 'electron-updater';
import { fetchUpdate } from './release.ts';
import type { UpdateState } from './release.ts';

type Check = Awaited<ReturnType<AppUpdater['checkForUpdates']>>;
const updater = (check: () => Promise<Check>) => Object.assign(new EventEmitter(), { checkForUpdates: check }) as unknown as AppUpdater;
const found = (downloadPromise: Promise<string[]>) => async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.3.0' }, downloadPromise }) as Check;
const accepted = () => Promise.resolve();
/** Runs a check and returns every state it reported, the last one being the result. */
async function steps(target: AppUpdater, installable = accepted, during?: (target: AppUpdater, seen: UpdateState[]) => void) {
  const seen: UpdateState[] = [];
  const result = fetchUpdate(target, installable, (state) => { seen.push(state); during?.(target, seen); });
  const last = await result;
  assert.deepEqual(seen.at(-1), last);
  return seen;
}

test('a downloaded release that the platform accepts is ready, with the download reported on the way', async () => {
  let gate!: () => void;
  const target = updater(found(new Promise((resolve) => { gate = () => resolve([]); })));
  const seen = await steps(target, accepted, (updater, sofar) => { if (sofar.length === 2) { updater.emit('download-progress', { percent: 40, total: 100, delta: 40, transferred: 40, bytesPerSecond: 1 }); gate(); } });
  assert.deepEqual(seen, [{ status: 'checking' }, { status: 'downloading', version: '0.3.0', percent: 0 }, { status: 'downloading', version: '0.3.0', percent: 40 }, { status: 'ready', version: '0.3.0' }]);
  assert.equal(target.listenerCount('download-progress'), 0);
});

test('a release that cannot be downloaded or installed is available from the release page', async () => {
  assert.deepEqual((await steps(updater(found(Promise.reject(new Error('404')))))).at(-1), { status: 'available', version: '0.3.0' });
  assert.deepEqual((await steps(updater(found(Promise.resolve([]))), () => Promise.reject(new Error('code signature')))).at(-1), { status: 'available', version: '0.3.0' });
});

test('with autoDownload off there is no download to wait for', async () => {
  const notDownloaded = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.3.0' }, downloadPromise: null }) as Check;
  assert.deepEqual(await steps(updater(notDownloaded), () => new Promise(() => {})), [{ status: 'checking' }, { status: 'available', version: '0.3.0' }]);
});

test('no newer release is current; an inactive updater or a failed check has failed', async () => {
  assert.deepEqual((await steps(updater(async () => ({ isUpdateAvailable: false }) as Check))).at(-1), { status: 'current' });
  assert.deepEqual((await steps(updater(async () => null))).at(-1), { status: 'failed' });
  assert.deepEqual((await steps(updater(() => Promise.reject(new Error('offline'))))).at(-1), { status: 'failed' });
});
