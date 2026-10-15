import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import type { Browser, LaunchOptions } from 'playwright-core';
import { launchBrowserPool } from './pool.ts';

test('tries Playwright Chromium, then Chrome, then Edge, then says to install Chrome', async (t) => {
  const launch = t.mock.method(chromium, 'launch', async () => {
    throw new Error('not installed');
  });
  await assert.rejects(launchBrowserPool({ headless: false }), (e: Error) => /Install Google Chrome/.test(e.message) && (e.cause as Error).message === 'not installed');
  assert.deepEqual(
    launch.mock.calls.map((call) => [call.arguments[0]?.channel, call.arguments[0]?.headless]),
    [[undefined, false], ['chrome', false], ['msedge', false]],
  );
});

test('falls through to the next channel and runs headless by default', async (t) => {
  let closed = false;
  const browser = { close: async () => void (closed = true) } as unknown as Browser;
  const launch = t.mock.method(chromium, 'launch', async (options?: LaunchOptions) => {
    if (options?.channel !== 'chrome') throw new Error('not installed');
    return browser;
  });
  const pool = await launchBrowserPool();
  assert.deepEqual(launch.mock.calls.map((call) => [call.arguments[0]?.channel, call.arguments[0]?.headless]), [[undefined, true], ['chrome', true]]);
  await pool.close();
  assert.equal(closed, true);
});
