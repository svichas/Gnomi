// Smoke test of the built app: `npm run build -w @gnomi/app && node app/smoke.ts`.
// It drives the real window with Playwright's Electron support and the scripted persona (GNOMI_FAKE_LLM=1),
// so it needs no key and costs nothing. Screenshots land in app/test-results/.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import type { Page } from 'playwright-core';
import { startGym } from '../gym/server.ts';

const appDir = import.meta.dirname;
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'gnomi-smoke-'));
const userData = join(tmp, 'user-data');

// A stuck stage must not hang the run: stop everything after ten minutes. Playwright takes the launched app down with the process.
setTimeout(() => {
  console.error('The smoke test did not finish in ten minutes.');
  process.exit(1);
}, 600_000).unref();

let failures = 0;
async function stage(name: string, body: () => Promise<void>) {
  try {
    await body();
    console.log(`ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${(err instanceof Error ? err.message : String(err)).split('\n').slice(0, 3).join('\n      ')}`);
  }
}

/** The report names at least one friction and its screenshot actually loaded. */
async function expectReport(page: Page) {
  const report = page.locator('section[aria-labelledby=report-title]');
  assert.match(await report.innerText(), /Frictions found \([1-9]/);
  const image = report.getByRole('img').first();
  await image.waitFor();
  await page.waitForFunction((img) => (img as HTMLImageElement).naturalWidth > 0, await image.elementHandle());
}

/** Presses Start run, confirms the pre-run summary and waits until the run's page is showing. */
async function startRun(page: Page, runId: string) {
  await page.getByRole('button', { name: 'Start run' }).click();
  const summary = page.getByRole('dialog');
  await summary.or(page.getByRole('alert')).first().waitFor();
  assert.ok(await summary.isVisible(), `the pre-run summary did not open: ${await page.getByRole('alert').allInnerTexts()}`);
  await summary.getByRole('button', { name: 'Start run' }).click();
  const heading = page.getByRole('heading', { name: `Run ${runId}` });
  await heading.or(summary.getByRole('alert')).first().waitFor({ timeout: 60_000 });
  assert.ok(await heading.isVisible(), `the run did not start: ${await summary.getByRole('alert').allInnerTexts()}`);
}

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as string,
  // The mock keychain keeps macOS from asking for Keychain access while the key storage is exercised.
  args: ['--use-mock-keychain', `--user-data-dir=${userData}`, join(appDir, 'out/main/index.js')],
  env: { ...process.env, GNOMI_FAKE_LLM: '1', GNOMI_PROJECT_DIR: join(tmp, 'smoke.gnomi') },
});
let gym: { close(): Promise<void> } | undefined;
let ran = false;
try {
  const page = await app.firstWindow();
  const tab = (name: string) => page.getByRole('tab', { name });

  await stage('the window shows the Settings, Project and Run tabs', async () => {
    await tab('Settings').waitFor();
    assert.deepEqual(await page.getByRole('tab').allInnerTexts(), ['Settings', 'Project', 'Run']);
  });

  await stage('the engine started and opened the project', async () => {
    await page.getByText('Starting Gnomi...').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('alert').count(), 0, `the page reports: ${await page.getByRole('alert').allInnerTexts()}`);
    // The file exists only if node:sqlite ran inside Electron's utility process.
    assert.ok(existsSync(join(tmp, 'smoke.gnomi', 'project.sqlite')), 'the engine did not create project.sqlite');
  });

  await stage('each screen renders (screenshots in app/test-results)', async () => {
    for (const [name, heading] of [['Settings', 'Anthropic API key'], ['Project', 'What to test'], ['Run', 'Runs']]) {
      await tab(name).click();
      await page.getByRole('heading', { name: heading }).waitFor();
      await page.screenshot({ path: join(shots, `${name.toLowerCase()}.png`) });
    }
  });

  await stage('the page is isolated: no Node, a three-method bridge, a strict CSP', async () => {
    const seen = await page.evaluate(async () => {
      const script = document.createElement('script');
      script.textContent = 'window.inlineScriptRan = true';
      document.head.append(script);
      const remote = await fetch('http://127.0.0.1:9/').then(() => 'reached', () => 'blocked');
      return {
        node: [typeof require, typeof process],
        bridge: Object.keys(window.gnomi),
        inlineScriptRan: 'inlineScriptRan' in window,
        remote,
      };
    });
    assert.deepEqual(seen, { node: ['undefined', 'undefined'], bridge: ['saveKey', 'hasKey', 'clearKey'], inlineScriptRan: false, remote: 'blocked' });
  });

  await stage('the API key and the session key are stored encrypted; the API key is never returned and can be removed', async () => {
    const secret = 'sk-ant-smoke-test-key';
    const saved = await page.evaluate((key) => window.gnomi.saveKey(key), `  ${secret}  `);
    assert.equal(await page.evaluate(() => window.gnomi.hasKey()), true);
    if (saved.remembered) {
      assert.ok(!readFileSync(join(userData, 'anthropic.key')).includes(secret), 'the key file holds plain text');
      // The session key is 64 hex characters when it is plain, so a file that matches is not encrypted.
      const sessionKey = join(userData, 'session.key');
      assert.ok(!/^[0-9a-f]{64}$/.test(readFileSync(sessionKey, 'latin1')), 'the session key file holds plain text');
      if (process.platform !== 'win32') assert.equal(statSync(sessionKey).mode & 0o777, 0o600);
    }
    await page.evaluate(() => window.gnomi.clearKey());
    assert.equal(await page.evaluate(() => window.gnomi.hasKey()), false);
  });

  await stage('a full run on the Gym ends in a report with a screenshot', async () => {
    const started = await startGym({ port: 0, defects: 'all' });
    gym = started;
    await tab('Project').click();
    await page.getByLabel('Project name').fill('Gym');
    await page.getByLabel('What the product does').fill('An applicant tracking system for recruiters');
    await page.getByLabel('Start page URL').fill(started.url);
    await page.getByLabel('Goal').fill('Post a job for a backend engineer');
    await page.screenshot({ path: join(shots, 'project-filled.png') });
    await startRun(page, 'r-0001');
    await page.getByRole('heading', { name: 'Report' }).waitFor({ timeout: 180_000 });
    await expectReport(page);
    await page.screenshot({ path: join(shots, 'report.png'), fullPage: true });
    ran = true;
  });

  await stage('a third-party host is blocked: the report lists it and it received nothing', async () => {
    const hits: string[] = [];
    const thirdParty = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.end();
    });
    await new Promise<void>((resolve) => thirdParty.listen(0, '127.0.0.1', resolve));
    const site = await startGym({ port: 0, defects: 'all', thirdParty: `http://127.0.0.1:${(thirdParty.address() as AddressInfo).port}` });
    try {
      await tab('Project').click();
      await page.getByLabel('Start page URL').fill(site.url);
      await startRun(page, 'r-0002');
      await page.getByRole('heading', { name: 'Report' }).waitFor({ timeout: 180_000 });
      const methods = page.locator('section[aria-labelledby=methods-title]');
      assert.match(await methods.innerText(), /127\.0\.0\.1: \d+ requests?/);
      await page.screenshot({ path: join(shots, 'report-methods.png'), fullPage: true });
      assert.deepEqual(hits, [], 'the third-party server was reached');
    } finally {
      await site.close();
      // The browser may have opened a speculative connection to it, which would keep close() waiting.
      await new Promise((resolve) => {
        thirdParty.close(resolve);
        thirdParty.closeAllConnections();
      });
    }
  });

  await stage('a CAPTCHA pauses the persona, and ending the run from the banner reports it as blocked', async () => {
    const site = await startGym({ port: 0, captcha: true });
    try {
      await tab('Project').click();
      await page.getByLabel('Start page URL').fill(`${site.url}/candidates`);
      await startRun(page, 'r-0003');
      const banner = page.getByRole('alert', { name: 'The persona is waiting for you' });
      await banner.waitFor({ timeout: 60_000 });
      assert.match(await banner.innerText(), /hit a CAPTCHA \(recaptcha\)\. Gnomi never solves these/);
      await page.screenshot({ path: join(shots, 'blocked.png') });
      await banner.getByRole('button', { name: 'End run' }).click();
      await page.getByRole('heading', { name: 'Report' }).waitFor({ timeout: 60_000 });
      assert.match(await page.locator('section[aria-labelledby=report-title]').innerText(), /Blocked/);
      assert.match(await page.locator('section[aria-labelledby=methods-title]').innerText(), /a CAPTCHA.*did not resume/);
    } finally {
      await site.close();
    }
  });

  await stage('a live payment key on the page halts the run with a safety stop', async () => {
    const site = await startGym({ port: 0, liveKey: true });
    try {
      await tab('Project').click();
      await page.getByLabel('Start page URL').fill(`${site.url}/billing`);
      await startRun(page, 'r-0004');
      await page.getByRole('heading', { name: 'Report' }).waitFor({ timeout: 60_000 });
      const activity = await page.getByRole('region', { name: 'Activity' }).innerText();
      assert.match(activity, /safety stop/i); // the row label is upper-cased by CSS, which innerText reflects
      assert.match(activity, /The run was halted by a safety check/);
      assert.match(await page.locator('section[aria-labelledby=methods-title]').innerText(), /Safety stops\s+Live payment key found/);
      await page.screenshot({ path: join(shots, 'safety-stop.png'), fullPage: true });
    } finally {
      await site.close();
    }
  });

  await stage('the pre-run summary lists the allowed hosts and offers the reset for a project with a reset hook', async () => {
    await tab('Project').click();
    await page.getByLabel('Add a host').fill('cdn.example.test');
    await page.getByRole('button', { name: 'Add host' }).click();
    await page.getByLabel('Reset hook URL (optional)').fill('http://localhost:9/reset');
    await page.getByRole('button', { name: 'Start run' }).click();
    const summary = page.getByRole('dialog');
    await summary.or(page.getByRole('alert')).first().waitFor();
    assert.ok(await summary.isVisible(), `the pre-run summary did not open: ${await page.getByRole('alert').allInnerTexts()}`);
    assert.match(await summary.innerText(), /Allowed hosts[\s\S]*cdn\.example\.test[\s\S]*Everything else is blocked/);
    await summary.getByLabel('Reset staging before the run').waitFor();
    await page.screenshot({ path: join(shots, 'summary.png') });
    await summary.getByRole('button', { name: 'Cancel' }).click();
    await summary.waitFor({ state: 'hidden' });
  });

  await stage('after a reload the page gets a fresh engine port and the past run opens', async () => {
    await page.reload();
    await page.getByText('Starting Gnomi...').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('alert').count(), 0, `the page reports: ${await page.getByRole('alert').allInnerTexts()}`);
    if (!ran) return; // nothing to open: the run above failed
    await tab('Run').click();
    await page.getByRole('button', { name: /r-0001/ }).click();
    await page.getByRole('heading', { name: 'Report' }).waitFor();
    await expectReport(page);
  });
} finally {
  await app.close();
  await gym?.close();
  if (failures) console.log(`The project folder, with the event log and screenshots, is kept in ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
