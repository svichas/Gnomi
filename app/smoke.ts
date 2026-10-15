// Smoke test of the built app: `npm run build -w @gnomi/app && node app/smoke.ts`.
// It drives the real window with Playwright's Electron support and the scripted persona (GNOMI_FAKE_LLM=1),
// so it needs no key and costs nothing. Screenshots land in app/test-results/.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import type { Page } from 'playwright-core';

const appDir = import.meta.dirname;
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'gnomi-smoke-'));
const userData = join(tmp, 'user-data');

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

  await stage('the key is stored encrypted, never returned, and can be removed', async () => {
    const secret = 'sk-ant-smoke-test-key';
    const saved = await page.evaluate((key) => window.gnomi.saveKey(key), `  ${secret}  `);
    assert.equal(await page.evaluate(() => window.gnomi.hasKey()), true);
    if (saved.remembered) assert.ok(!readFileSync(join(userData, 'anthropic.key')).includes(secret), 'the key file holds plain text');
    await page.evaluate(() => window.gnomi.clearKey());
    assert.equal(await page.evaluate(() => window.gnomi.hasKey()), false);
  });

  await stage('a full run on the Gym ends in a report with a screenshot', async () => {
    const { startGym } = await import('../gym/server.ts');
    const started = await startGym({ port: 0, defects: 'all' });
    gym = started;
    await tab('Project').click();
    await page.getByLabel('Project name').fill('Gym');
    await page.getByLabel('What the product does').fill('An applicant tracking system for recruiters');
    await page.getByLabel('Start page URL').fill(started.url);
    await page.getByLabel('Goal').fill('Post a job for a backend engineer');
    await page.screenshot({ path: join(shots, 'project-filled.png') });
    await page.getByRole('button', { name: 'Start run' }).click();
    const heading = page.getByRole('heading', { name: 'Run r-0001' });
    await heading.or(page.getByRole('alert')).first().waitFor({ timeout: 60_000 });
    assert.ok(await heading.isVisible(), `the run did not start: ${await page.getByRole('alert').allInnerTexts()}`);
    await page.getByRole('heading', { name: 'Report' }).waitFor({ timeout: 180_000 });
    await expectReport(page);
    await page.screenshot({ path: join(shots, 'report.png'), fullPage: true });
    ran = true;
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
