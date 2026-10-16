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
import type { Locator, Page } from 'playwright-core';
import { feedThreads, socialMemory } from '../engine/src/graph/feed.ts';
import { buildGraph, graphAtRound } from '../engine/src/graph/index.ts';
import { syntheticRun } from '../engine/src/graph/synthetic.ts';
import { openProject } from '../engine/src/log/sqlite.ts';
import { PROVIDER_DEFAULTS } from '../engine/src/settings.ts';
import type { GnomiEvent } from '../engine/src/types.ts';
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

/** Hovers and clicks the first node with this key prefix on the swarm canvas, found through the sigma instance on its container. */
async function clickNode(page: Page, prefix: string): Promise<string> {
  const canvas = page.locator('.sigma-container');
  await canvas.scrollIntoViewIfNeeded();
  const locate = () => canvas.evaluate((element, prefix) => {
    const sigma = (element as HTMLElement & { sigma: { getGraph(): { nodes(): string[] }; getNodeDisplayData(key: string): { x: number; y: number }; framedGraphToViewport(at: { x: number; y: number }): { x: number; y: number } } }).sigma;
    const key = sigma.getGraph().nodes().find((candidate) => candidate.startsWith(prefix))!;
    return { key, ...sigma.framedGraphToViewport(sigma.getNodeDisplayData(key)) };
  }, prefix);
  // The layout keeps moving nodes for seconds after the graph changes (SETTLE_MS in Swarm.tsx): aim once this one is still.
  let node = await locate();
  for (const deadline = Date.now() + 20_000; ; ) {
    await page.waitForTimeout(300);
    const next = await locate();
    if (Math.hypot(next.x - node.x, next.y - node.y) < 0.5) break;
    if (Date.now() > deadline) throw new Error(`the swarm layout was still moving ${node.key} after 20 seconds`);
    node = next;
  }
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + node.x, box.y + node.y);
  await page.getByRole('region', { name: 'Swarm graph' }).getByRole('status').waitFor(); // the hover card
  await page.mouse.click(box.x + node.x, box.y + node.y);
  return node.key.slice(prefix.length);
}

/** The report names at least one friction and its screenshot actually loaded (screenshots are fetched when they scroll into view). */
async function expectReport(page: Page) {
  const report = page.locator('section[aria-labelledby=report-title]');
  // The scripted judge and author name the themes and label their suggestions, so a key-free run shows ranked themes.
  // Problems more than one persona met come first; with a small swarm they can all be single reports, folded below them.
  const singles = report.locator('section[aria-labelledby=singles-title]');
  if (await singles.count()) await unfold(singles.locator('details').first());
  const findings = await report.locator('section[aria-labelledby=themes-title], section[aria-labelledby=singles-title]').allInnerTexts();
  assert.match(findings.join('\n'), /Scripted demo theme \d+: no model named it[\s\S]*Generated suggestion/);
  // Each persona's frictions are folded away: open the first persona with one.
  const persona = report.getByRole('region', { name: /How each persona did/ }).locator('details').filter({ has: page.locator('ol > li') }).first();
  await unfold(persona);
  const friction = persona.locator('ol > li').first();
  await friction.scrollIntoViewIfNeeded();
  const image = friction.getByRole('img');
  await image.waitFor();
  await page.waitForFunction((img) => (img as HTMLImageElement).naturalWidth > 0, await image.elementHandle());
}

/** Opens a fold of the report, whatever state an earlier run's report left it in. */
const unfold = (details: Locator) => details.evaluate((element) => { (element as HTMLDetailsElement).open = true; });

/** The methods appendix is folded away; open it before reading it. */
async function methodsText(page: Page) {
  const methods = page.locator('section[aria-labelledby=methods-title]');
  await unfold(methods.locator('details'));
  return methods.innerText();
}

async function openReport(page: Page, options: { timeout?: number } = {}) {
  await page.getByRole('tab', { name: 'Report', exact: true }).click(options);
  await page.getByRole('heading', { name: 'Report', exact: true }).waitFor(options);
}

async function showActivity(page: Page) {
  await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
  const activity = page.getByRole('region', { name: 'Activity', exact: true });
  const filters = activity.getByRole('button', { name: /^Filter/ });
  if (await filters.getAttribute('aria-expanded') === 'false') await filters.click();
  return activity;
}

/** Opens the Review step from Setup and waits until the project saved; returns its panel. */
async function openReview(page: Page) {
  await page.getByRole('button', { name: 'Review & start', exact: true }).click();
  const review = page.locator('#panel-review');
  const saved = review.getByRole('region', { name: 'What they will try' });
  await saved.or(review.getByRole('region', { name: 'Fix before you start' })).first().waitFor();
  assert.ok(await saved.isVisible(), `the project did not save: ${await review.innerText()}`);
  return review;
}

/** Opens the Review step, starts the run from its bar and waits until the run's page is showing. */
async function startRun(page: Page, runId: string) {
  const review = await openReview(page);
  await review.getByRole('button', { name: 'Start run', exact: true }).click();
  const heading = page.getByRole('region', { name: 'Run status' });
  await heading.or(review.getByRole('alert')).first().waitFor({ timeout: 60_000 });
  assert.ok(await heading.isVisible(), `the run did not start: ${await review.getByRole('alert').allInnerTexts()}`);
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
  const tab = (name: string) => page.locator(`#tab-${({ Project: 'project', Settings: 'settings', Audience: 'audience', Run: 'run' } as Record<string, string>)[name]}`);

  await stage('the window shows a project journey and a separate Settings control', async () => {
    await tab('Settings').waitFor();
    assert.deepEqual((await page.getByRole('navigation', { name: 'Project steps' }).getByRole('button').allInnerTexts()).map((text) => text.replace(/^\d/, '').trim()), ['Setup', 'Audience', 'Review', 'Activity']);
  });

  await stage('the engine started and opened the project', async () => {
    await page.getByText('Starting Gnomi...').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('alert').count(), 0, `the page reports: ${await page.getByRole('alert').allInnerTexts()}`);
    // The file exists only if node:sqlite ran inside Electron's utility process.
    assert.ok(existsSync(join(tmp, 'smoke.gnomi', 'project.sqlite')), 'the engine did not create project.sqlite');
  });

  await stage('each screen renders (screenshots in app/test-results)', async () => {
    for (const [name, heading] of [['Settings', 'Providers'], ['Project', 'What to test'], ['Audience', 'Audience'], ['Run', 'Every perspective starts with a first step.']]) {
      await tab(name).click();
      await page.getByRole('heading', { name: heading }).waitFor();
      await page.screenshot({ path: join(shots, `${name.toLowerCase()}.png`) });
    }
  });

  await stage('the page is isolated: no Node, a bounded bridge, a strict CSP', async () => {
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
    assert.deepEqual(seen, { node: ['undefined', 'undefined'], bridge: ['saveKey', 'listProviders', 'clearKey', 'testKey', 'saveFigmaToken', 'clearFigmaToken', 'testFigmaToken', 'listProjects', 'projectAction', 'reportThumbnails', 'saveReport', 'pathForFile'], inlineScriptRan: false, remote: 'blocked' });
  });

  await stage('provider keys and the session key are stored encrypted, one file each; a key is never returned and can be removed', async () => {
    const anthropic = 'sk-ant-smoke-test-key';
    const openai = 'sk-openai-smoke-test-key';
    const saved = await page.evaluate((key) => window.gnomi.saveKey('anthropic', key), `  ${anthropic}  `);
    await page.evaluate((key) => window.gnomi.saveKey('openai', key), openai);
    const listed = await page.evaluate(() => window.gnomi.listProviders());
    assert.deepEqual(listed.keys.map((entry) => [entry.provider, entry.masked]), [['anthropic', 'sk-…-key'], ['openai', 'sk-…-key']]);
    assert.ok(!JSON.stringify([saved, listed]).includes('smoke-test'), 'a key came back from main');
    const refused = await page.evaluate(() => (window.gnomi.saveKey as (provider: string, key: string) => Promise<unknown>)('mistral', 'x').then(() => 'accepted', (err: Error) => err.message));
    assert.match(refused, /Unknown provider/);
    if (saved.remembered) {
      assert.ok(!readFileSync(join(userData, 'anthropic.key')).includes(anthropic), 'the key file holds plain text');
      assert.ok(!readFileSync(join(userData, 'openai.key')).includes(openai), 'the key file holds plain text');
      // The session key is 64 hex characters when it is plain, so a file that matches is not encrypted.
      const sessionKey = join(userData, 'session.key');
      assert.ok(!/^[0-9a-f]{64}$/.test(readFileSync(sessionKey, 'latin1')), 'the session key file holds plain text');
      if (process.platform !== 'win32') assert.equal(statSync(sessionKey).mode & 0o777, 0o600);
    }
    await page.evaluate(() => Promise.all([window.gnomi.clearKey('anthropic'), window.gnomi.clearKey('openai')]));
    assert.deepEqual((await page.evaluate(() => window.gnomi.listProviders())).keys, []);
    assert.ok(!existsSync(join(userData, 'openai.key')), 'the removed key file is still there');
  });

  await stage('a full run on the Gym ends in a report with a screenshot', async () => {
    const started = await startGym({ port: 0, defects: 'all' });
    gym = started;
    await tab('Project').click();
    await page.getByLabel('Project name').fill('Gym');
    await page.getByLabel('What the product does').fill('An applicant tracking system for recruiters');
    await page.getByLabel('Start page URL').fill(started.url);
    await page.getByLabel('Goal', { exact: true }).fill('Post a job for a backend engineer');
    await page.screenshot({ path: join(shots, 'project-filled.png') });
    await startRun(page, 'r-0001');
    await openReport(page, { timeout: 180_000 });
    await expectReport(page);
    await page.screenshot({ path: join(shots, 'report.png'), fullPage: true });
    // The problems to fix at the window's size and at 720 px wide, for a look at the evidence layout.
    const themes = page.getByRole('region', { name: /What to fix first/ });
    await themes.screenshot({ path: join(shots, 'report-themes.png') });
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
    await app.evaluate(({ BrowserWindow }, [, height]) => BrowserWindow.getAllWindows()[0].setSize(720, height), size);
    await themes.screenshot({ path: join(shots, 'report-themes-720.png') });
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), size);
    ran = true;
  });

  await stage('the report exports to HTML, PDF, JSON and Markdown files', async () => {
    assert.ok(ran, 'needs the run above');
    const exported = join(tmp, 'exports');
    mkdirSync(exported);
    // The save dialog is replaced: each file lands under its suggested name.
    await app.evaluate(({ dialog }, dir) => {
      dialog.showSaveDialog = async (options: Electron.SaveDialogOptions) => ({ canceled: false, filePath: `${dir}/${options.defaultPath}` });
    }, exported);
    const file = (format: string) => readFileSync(join(exported, `gnomi-report-r-0001.${format}`));
    for (const format of ['html', 'pdf', 'json', 'md']) {
      await page.getByLabel('Export format').selectOption(format);
      await page.getByRole('button', { name: 'Export report' }).click();
      await page.getByText(new RegExp(`Report exported to .*gnomi-report-r-0001\\.${format}$`)).waitFor({ timeout: 60_000 });
      assert.ok(file(format).length > 0, `the ${format} file is empty`);
    }
    const html = file('html').toString();
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*(?!["']?data:)/i, 'the HTML loads something from outside the file');
    assert.match(html, /<img src="data:image\/jpeg;base64,/);
    assert.doesNotMatch(html, /<button\b/, 'the file has inspector links');
    assert.equal(file('pdf').subarray(0, 5).toString(), '%PDF-');
    assert.equal(JSON.parse(file('json').toString()).run_id, 'r-0001');
    assert.match(file('md').toString(), /^# Gnomi report: Post a job/);
    console.log(`      sizes: ${['html', 'pdf', 'json', 'md'].map((format) => `${format} ${file(format).length} B`).join(', ')}`);
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
      await openReport(page, { timeout: 180_000 });
      assert.match(await methodsText(page), /127\.0\.0\.1: \d+ requests?/);
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
      const banner = page.getByRole('alert', { name: 'Personas are waiting for you' });
      await banner.waitFor({ timeout: 60_000 });
      assert.match(await banner.innerText(), /hit a CAPTCHA \(recaptcha\)\. Gnomi never solves these/);
      await page.screenshot({ path: join(shots, 'blocked.png') });
      await banner.getByRole('button', { name: 'End run' }).click();
      await openReport(page, { timeout: 60_000 });
      assert.match(await page.locator('section[aria-labelledby=report-title]').innerText(), /Blocked/);
      assert.match(await methodsText(page), /a CAPTCHA.*did not resume/);
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
      await openReport(page, { timeout: 60_000 });
      const feed = await showActivity(page);
      await feed.scrollIntoViewIfNeeded(); // the feed draws only the rows on screen
      await feed.getByRole('listitem').first().waitFor();
      const activity = await feed.innerText();
      assert.match(activity, /safety stop/i); // the row label is upper-cased by CSS, which innerText reflects
      assert.match(activity, /The run was halted by a safety check/);
      await openReport(page);
      assert.match(await methodsText(page), /Safety stops\s+Live payment key found/);
      await page.screenshot({ path: join(shots, 'safety-stop.png'), fullPage: true });
    } finally {
      await site.close();
    }
  });

  await stage('the pre-run summary lists the allowed hosts and offers the reset for a project with a reset hook', async () => {
    await tab('Project').click();
    await page.locator('summary').filter({ hasText: 'Access & advanced options' }).click();
    await page.getByLabel('Add a host').fill('cdn.example.test');
    await page.getByRole('button', { name: 'Add host' }).click();
    await page.getByLabel('Reset hook URL (optional)').fill('http://localhost:9/reset');
    const review = await openReview(page);
    assert.match(await review.innerText(), /Allowed hosts[\s\S]*cdn\.example\.test[\s\S]*Everything else is blocked/);
    await review.getByLabel('Reset staging before the run').waitFor();
    await page.screenshot({ path: join(shots, 'summary.png') });
    await tab('Project').click();
  });

  await stage("Settings: providers are added, tested and removed, routes offer only configured ones, and a role's provider fills in its usual model", async () => {
    await tab('Settings').click();
    const settings = page.locator('#panel-settings');
    await settings.locator('summary').filter({ hasText: 'Model choices' }).click();
    const navigator = settings.getByLabel('Navigator provider');
    const options = () => navigator.locator('option').allTextContents();
    const add = async (provider: string, value: string) => {
      await settings.getByLabel('Provider', { exact: true }).selectOption(provider);
      await settings.getByLabel(provider === 'openai_compatible' ? 'Base URL' : 'API key', { exact: true }).fill(value);
      await settings.getByRole('button', { name: 'Add provider' }).click();
    };
    await settings.getByText('No provider yet. Add one to run personas.').waitFor();
    assert.deepEqual(await options(), ['Anthropic'], 'only the provider in use, flagged');
    await settings.getByText('The selected AI provider is not connected. Add it under Providers or choose a connected provider.').first().waitFor();

    const deepseek = 'sk-smoke-deepseek-0123456789abcd';
    await add('anthropic', 'sk-ant-smoke-0123456789');
    await add('deepseek', deepseek);
    await settings.getByText('sk-…abcd').waitFor();
    assert.equal(await settings.getByText('Not tested yet').count(), 2);
    assert.ok(!(await settings.innerText()).includes('smoke-deepseek') && (await settings.getByLabel('API key', { exact: true }).inputValue()) === '', 'the key is still on the page');
    await settings.getByText('Its servers are in China.').first().waitFor();
    assert.deepEqual(await options(), ['Anthropic', 'DeepSeek']);
    await navigator.selectOption('deepseek');
    assert.equal(await settings.getByLabel('Navigator model').inputValue(), PROVIDER_DEFAULTS.deepseek.navigator.model);
    await settings.getByText('DeepSeek reads text only, so the navigator will not see the screenshots.').waitFor();
    await settings.getByRole('button', { name: 'Remove DeepSeek' }).click();
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="Navigator provider"]')?.value === 'anthropic');
    assert.equal(await settings.getByLabel('Navigator model').inputValue(), PROVIDER_DEFAULTS.anthropic.navigator.model);
    assert.deepEqual(await options(), ['Anthropic'], 'a removed provider is no longer offered');
    assert.equal(await settings.getByText('The selected AI provider is not connected.', { exact: false }).count(), 0);

    // The local endpoint is saved with the project, and testing it asks a stand-in server for its model list.
    const hits: string[] = [];
    const endpoint = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      res.end('{"object":"list","data":[]}');
    });
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`;
      await add('openai_compatible', url);
      await settings.getByText(url).waitFor();
      await settings.getByRole('button', { name: 'Test Local endpoint' }).click();
      await settings.getByText('Works').waitFor();
      assert.deepEqual(hits, ['GET /v1/models']);
    } finally {
      endpoint.close();
    }
    // The provider list at the window's size and at 720 px wide.
    await page.screenshot({ path: join(shots, 'settings-providers.png') });
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
    await app.evaluate(({ BrowserWindow }, [, height]) => BrowserWindow.getAllWindows()[0].setSize(720, height), size);
    await page.screenshot({ path: join(shots, 'settings-providers-720.png') });
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), size);
  });

  await stage('Settings: budgets save with the project', async () => {
    const settings = page.locator('#panel-settings');
    assert.equal(await settings.getByText('Used from a later version.').count(), 2, 'the judge and author are marked as not used yet');
    await settings.getByLabel('Concurrency (1-32)', { exact: true }).fill('40');
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await settings.getByText('concurrency must be a whole number from 1 to 32.').waitFor();
    await settings.getByLabel('Concurrency (1-32)', { exact: true }).fill('3');
    await settings.getByLabel('Cost budget (USD)', { exact: true }).fill('2');
    await settings.getByLabel('Let personas read and post in a shared feed between stretches of use').check();
    assert.equal(await settings.getByLabel('Rounds (1-10)', { exact: true }).inputValue(), '5');
    await settings.getByLabel('Rounds (1-10)', { exact: true }).fill('10'); // with patience 2 below, the population run's slices are two steps
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await settings.getByText('Settings saved with the project.').waitFor();
    await page.screenshot({ path: join(shots, 'settings-models.png'), fullPage: true });
  });

  const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0);

  await stage('Audience: one segment, then proposed segments, and the shares always add up to 100', async () => {
    await tab('Audience').click();
    const audience = page.locator('#panel-audience');
    const sliders = audience.getByRole('list', { name: 'Segments', exact: true }).getByRole('slider'); // the share sliders, not the persona count
    const shares = () => sliders.evaluateAll((inputs) => inputs.map((input) => Number((input as HTMLInputElement).value)));
    await audience.getByRole('button', { name: 'Build my own' }).click();
    assert.deepEqual(await shares(), [100]);
    assert.ok(await sliders.first().isDisabled(), 'a lone segment is everyone');
    await audience.getByRole('button', { name: 'Add segment' }).click();
    assert.deepEqual(await shares(), [50, 50]);
    await sliders.first().fill('70');
    assert.deepEqual(await shares(), [70, 30]);
    await audience.getByRole('button', { name: 'Propose segments again' }).click();
    await audience.getByText(/Proposed \d+ segments/).waitFor({ timeout: 60_000 });
    const proposed = await shares();
    assert.ok(proposed.length >= 2, 'the proposal has segments');
    assert.equal(sum(proposed), 100);
    await sliders.nth(1).fill('17');
    const moved = await shares();
    assert.equal(moved[1], 17);
    assert.equal(sum(moved), 100, `after moving a slider: ${moved}`);
    await page.screenshot({ path: join(shots, 'audience.png'), fullPage: true });
  });

  await stage('Audience: personas are generated with progress, then edited, regenerated, added and removed', async () => {
    const audience = page.locator('#panel-audience');
    await audience.getByRole('button', { name: 'Start over' }).click();
    await audience.getByRole('button', { name: 'Build my own' }).click();
    await audience.getByRole('button', { name: 'Add segment' }).click();
    await audience.getByLabel('Segment name').nth(0).fill('Recruiters');
    await audience.getByLabel('Segment name').nth(1).fill('Hiring managers');
    await audience.getByLabel('Number of personas', { exact: true }).fill('6');
    await audience.getByRole('button', { name: 'Remove country United States' }).click();
    await audience.getByLabel('Add country').selectOption('DE');
    await audience.getByLabel('Employers for Recruiters').fill('Example GmbH');
    await audience.getByLabel('Employers for Hiring managers').fill('Beispiel AG');
    // Social phases stop once every episode has ended, and the scripted persona ends on its third step: a 20-step budget
    // over ten rounds gives slices of two steps, so the population run reaches a social phase before anyone ends.
    for (const options of await audience.locator('summary').filter({ hasText: 'Habits, devices & scenarios' }).all()) await options.click();
    for (const highest of await audience.getByLabel('Patience (1-5), highest', { exact: true }).all()) await highest.fill('2');
    // The generation may be quick, so a page observer keeps what the progress bar showed.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { progressSeen: string[] }).progressSeen = seen;
      new MutationObserver(() => {
        const bar = document.querySelector('[role=progressbar][aria-label="Writing personas"]');
        if (bar) seen.push(`${bar.getAttribute('aria-valuenow')}/${bar.getAttribute('aria-valuemax')}`);
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await audience.getByRole('button', { name: 'Generate personas' }).first().click();
    await audience.getByText(/6 personas are ready/).waitFor({ timeout: 120_000 });
    const seen = await page.evaluate(() => (window as unknown as { progressSeen: string[] }).progressSeen);
    assert.ok(seen.some((progress) => /^\d+\/12$/.test(progress)), `the progress bar never showed a total of 12 (a sketch and a write for each of 6): ${seen}`);
    await audience.getByRole('heading', { name: 'Personas (6)' }).waitFor();
    await audience.getByText('Recruiters (3)').waitFor();
    await audience.getByText('Hiring managers (3)').waitFor();
    const personaSection = audience.getByRole('heading', { name: 'Personas (6)', exact: true }).locator('..');
    const cards = personaSection.getByRole('listitem', { name: / persona$/, includeHidden: true });
    assert.equal(await cards.count(), 6);
    await audience.getByText('Hiring managers (3)', { exact: true }).click();
    for (const text of await cards.allTextContents()) { // collapsed cards still hold the full profile
      for (const value of ['Berlin', 'Germany', 'Europe/Berlin', 'de-DE, en']) assert.ok(text.includes(value), `missing ${value}`);
    }
    assert.equal(await cards.filter({ has: page.locator('dd').filter({ hasText: /^Example GmbH$/ }) }).count(), 3);
    assert.equal(await cards.filter({ has: page.locator('dd').filter({ hasText: /^Beispiel AG$/ }) }).count(), 3);
    await audience.getByRole('heading', { name: 'Personas (6)' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'personas.png') });

    await cards.first().locator('summary').click();
    await audience.getByRole('button', { name: /^Edit / }).first().click();
    await audience.getByLabel(/^Name \(/).fill('Renamed Person');
    await audience.getByRole('button', { name: /^Save edits to / }).click();
    await audience.getByText('Saved Renamed Person.').waitFor();
    await cards.nth(1).locator('summary').click();
    await audience.getByRole('button', { name: /^Regenerate / }).nth(1).click(); // another persona than the one just renamed
    await audience.getByText(/Wrote a new persona/).waitFor();

    // Only a persona added by hand stays removed; the ones the shares allot come back with the next generation.
    const hint = audience.getByText('It comes back when you generate again');
    assert.equal(await hint.count(), 6);
    await audience.getByRole('button', { name: 'Add a persona to Recruiters' }).click();
    await audience.getByRole('heading', { name: 'Personas (7)' }).waitFor();
    assert.equal(await hint.count(), 6, 'the added persona has no hint');
    const recruiters = audience.locator('details').filter({ has: page.getByText(/^Recruiters \(\d+\)$/, { exact: true }) });
    await recruiters.locator('li').last().locator('summary').click();
    await recruiters.locator('li').last().getByRole('button', { name: /^Remove / }).click();
    await audience.getByRole('heading', { name: 'Personas (6)' }).waitFor();
    await recruiters.locator('li').nth(1).getByRole('button', { name: /^Remove / }).click(); // not the renamed one
    await audience.getByRole('heading', { name: 'Personas (5)' }).waitFor();
    await audience.getByRole('button', { name: 'Generate personas' }).click();
    await audience.getByRole('heading', { name: 'Personas (6)' }).waitFor({ timeout: 120_000 });
    await audience.getByText('Renamed Person').first().waitFor(); // generating again keeps the personas it did not have to change
  });

  await stage('the pre-run summary shows who will browse and an estimate', async () => {
    await tab('Project').click();
    const review = await openReview(page);
    await review.getByText(/About \$/).waitFor();
    const text = await review.innerText();
    assert.match(text, /6 simulated people[\s\S]*Recruiters\s+3 personas[\s\S]*Hiring managers\s+3 personas/);
    assert.match(text, /About \$[\d.]+(–\$[\d.]+)? and \d+(–\d+)? minutes?/);
    assert.match(text, /Cost limit\s+\$2\.00[\s\S]*Time limit\s+60 minutes[\s\S]*Browsers at once\s+3/);
    assert.match(text, /billed cost can exceed the limit/);
    await page.screenshot({ path: join(shots, 'summary-estimate.png') });
    await tab('Project').click();
  });

  let population = false;
  await stage('a run of two segments with three personas each, three at a time, ends in a report with both segments', async () => {
    const site = await startGym({ port: 0, defects: 'all' });
    try {
      await tab('Project').click();
      await page.getByLabel('Start page URL').fill(site.url);
      await startRun(page, 'r-0005');
      await openReport(page, { timeout: 300_000 });
      const segments = await page.getByRole('region', { name: 'Results by segment' }).innerText();
      for (const name of ['Recruiters', 'Hiring managers', 'Weighted by share']) assert.match(segments, new RegExp(name));
      assert.equal(await page.getByRole('region', { name: /How each persona did/ }).locator('details').count(), 6, 'a card for each of the six personas');
      assert.match(await page.getByRole('region', { name: 'Run status' }).innerText(), /Personas finished\s+6 of 6/);
      assert.match(await methodsText(page), /3 browsers at a time/);
      await page.screenshot({ path: join(shots, 'report-population.png'), fullPage: true });
      // Social rounds are on: the scripted swarm reads its feeds and mostly stays silent, but someone posts.
      const activity = await showActivity(page);
      await activity.getByLabel('Kind of event').selectOption({ label: 'Feed, posts and reactions' });
      await page.waitForFunction(() => {
        const section = document.querySelector('section[aria-labelledby=activity-title]');
        section?.scrollIntoView({ block: 'end' }); // the list holds only the rows on screen, and the first posts are at its end
        return [...(section?.querySelectorAll('[role=listitem]') ?? [])].some((row) => row.textContent?.includes('Posted in the feed'));
      }, null, { timeout: 30_000 });
      await page.screenshot({ path: join(shots, 'activity-social.png') });
      await activity.getByLabel('Kind of event').selectOption({ label: 'Everything' });
      population = true;
    } finally {
      await site.close();
    }
  });

  await stage('a persona opens in the inspector with her steps and their screenshots', async () => {
    assert.ok(population, 'needs the run above');
    const inspector = page.getByRole('complementary', { name: 'Persona inspector' });
    await page.locator('summary').filter({ hasText: 'People in this run' }).click();
    await page.getByRole('button', { name: /^Inspect / }).first().click();
    await inspector.waitFor();
    // Opinions and the survey come first; the timeline's screenshots load once they are scrolled into view.
    const timeline = inspector.getByRole('region', { name: 'Timeline' });
    await timeline.scrollIntoViewIfNeeded();
    const image = timeline.getByRole('img').first();
    await image.waitFor();
    await page.waitForFunction((img) => (img as HTMLImageElement).naturalWidth > 0, await image.elementHandle());
    await inspector.getByText('Full profile').click();
    assert.match(await inspector.innerText(), /Biography/);
    assert.match(await inspector.innerText(), /Germany/);
    assert.match(await inspector.innerText(), /Europe\/Berlin/);
    const opinions = inspector.getByRole('region', { name: 'Current opinions' });
    assert.match(await opinions.innerText(), /Sentiment\s+-1 of −2 to \+2/);
    assert.match(await opinions.innerText(), /Self-reported confidence\s+50%/);
    assert.match(await opinions.innerText(), /Likes[\s\S]+Sample like from the scripted demo/);
    assert.match(await opinions.innerText(), /Frictions[\s\S]+Sample friction from the scripted demo/);
    const survey = inspector.getByRole('region', { name: 'Survey' });
    assert.match(await survey.innerText(), /Would keep using it\s+No/);
    assert.match(await survey.innerText(), /Scripted demo survey: no model was called/);
    await survey.screenshot({ path: join(shots, 'inspector-survey.png') });
    await opinions.getByRole('button', { name: 'View source step 2' }).click();
    const evidence = inspector.getByRole('region', { name: 'Timeline' }).locator('li.ring-2');
    assert.match(await evidence.innerText(), /Step 2[\s\S]+Scripted demo: logging a sample friction/i);
    await page.screenshot({ path: join(shots, 'inspector.png') });
    await page.keyboard.press('Escape');
    await inspector.waitFor({ state: 'detached' });
    // The report's persona cards open it too.
    await openReport(page);
    const card = page.getByRole('region', { name: /How each persona did/ }).locator('details').first();
    await unfold(card);
    await card.getByRole('button', { name: /timeline$/ }).click();
    await inspector.waitFor();
    await inspector.getByRole('button', { name: 'Close' }).click();
    await inspector.waitFor({ state: 'detached' });
  });

  await stage('personas hit a CAPTCHA: one banner covers those in flight, Retry blocks them again, and ending the run reports them as blocked', async () => {
    assert.ok(population, 'needs the population above');
    const site = await startGym({ port: 0, captcha: true });
    try {
      await tab('Project').click();
      await page.getByLabel('Start page URL').fill(`${site.url}/candidates`);
      await startRun(page, 'r-0006');
      const banner = page.getByRole('alert', { name: 'Personas are waiting for you' });
      const status = page.getByRole('region', { name: 'Run status' });
      await banner.waitFor({ timeout: 120_000 });
      // Three run at a time, so three stop at the challenge and the other three have not started.
      await status.getByText('Waiting for you 3').waitFor({ timeout: 120_000 });
      await status.getByText('Waiting to start 3').waitFor();
      const said = await banner.innerText();
      assert.match(said, /3 personas \(.*\) hit a CAPTCHA \(recaptcha\)\. Gnomi never solves these/);
      // The status line still says three until the engine has answered, so look at each persona's own rows: a second stop means she was blocked again.
      const names = /\((.+)\) hit a CAPTCHA/.exec(said)?.[1].split(/, | and /) ?? [];
      assert.equal(names.length, 3);
      await banner.getByRole('button', { name: 'Retry' }).click();
      const feed = await showActivity(page);
      await feed.getByLabel('Kind of event').selectOption({ label: 'Blocked and resumed' });
      // The feed holds only the rows on screen, so each poll brings its end into view before it counts.
      const rowsWith = (text: string, count: number) =>
        page.waitForFunction(
          ({ wanted, n }) => {
            const section = document.querySelector('section[aria-labelledby=activity-title]');
            section?.scrollIntoView({ block: 'end' });
            return [...(section?.querySelectorAll('[role=listitem]') ?? [])].filter((row) => row.textContent?.includes(wanted)).length >= n;
          },
          { wanted: text, n: count },
          { timeout: 120_000 },
        );
      for (const name of names) {
        await feed.getByLabel('Persona', { exact: true }).selectOption({ label: name });
        await rowsWith('Blocked by a CAPTCHA, waiting for you', 2); // the challenge is still there
      }
      await banner.getByRole('button', { name: 'End run' }).click();
      await openReport(page, { timeout: 120_000 });
      const outcomes = (await page.getByRole('region', { name: /How each persona did/ }).locator('summary').allInnerTexts()).join('\n');
      assert.equal((outcomes.match(/Blocked/g) ?? []).length, 3);
      // Each stopped twice: the first time they were let go again, the second time the run ended on them.
      const methods = await methodsText(page);
      assert.equal((methods.match(/then resumed/g) ?? []).length, 3);
      assert.equal((methods.match(/did not resume/g) ?? []).length, 3);
      await page.screenshot({ path: join(shots, 'blocked-personas.png') });
    } finally {
      await site.close();
    }
  });

  await stage('after a reload the page gets a fresh engine port, the project comes back and the past run opens', async () => {
    await page.reload();
    await page.getByText('Starting Gnomi...').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('alert').count(), 0, `the page reports: ${await page.getByRole('alert').allInnerTexts()}`);
    await tab('Settings').click();
    assert.equal(await page.locator('#panel-settings').getByLabel('Concurrency (1-32)', { exact: true }).inputValue(), '3');
    await page.locator('#panel-settings').getByText('sk-…6789').waitFor();
    await page.locator('#panel-settings').getByText('Works').waitFor(); // the local endpoint's last test outlives the page
    await tab('Audience').click();
    await page.locator('#panel-audience').getByRole('heading', { name: 'Personas (6)' }).waitFor();
    assert.equal(await page.locator('#panel-audience').getByRole('list', { name: 'Segments', exact: true }).getByRole('slider').count(), 2);
    if (!ran) return; // nothing to open: the first run failed
    await tab('Run').click();
    await page.getByLabel('Run history', { exact: true }).selectOption('r-0001');
    await openReport(page);
    await expectReport(page);
  });
  await stage('the swarm tab draws a run, scrubs its rounds, and a persona node opens the inspector with its social memory', async () => {
    assert.ok(population, 'needs the population run above');
    const inspector = page.getByRole('complementary', { name: 'Persona inspector' });
    const graph = page.getByRole('region', { name: 'Swarm graph' });
    // The scripted swarm run above: personas, the Gym, its used and friction edges, and its social rounds.
    await tab('Run').click();
    await page.getByLabel('Run history', { exact: true }).selectOption('r-0005');
    await page.getByRole('tab', { name: 'Connections' }).click();
    await graph.getByText(/^6 personas, 1 point of interest, [1-9]\d* connections$/).waitFor();
    assert.match(await graph.innerText(), /Used \([1-9]/);
    assert.match(await graph.innerText(), /Friction \([1-9]/);
    assert.ok(await graph.getByRole('slider').isEnabled(), 'its rounds can be scrubbed');
    await clickNode(page, 'persona:');
    await inspector.getByRole('region', { name: 'Social memory' }).getByText(/^Follows \(\d+\)$/).waitFor();
    await inspector.getByRole('button', { name: 'Close' }).click();

    // A synthetic social run of three rounds, written to the open project's log as the social engine would.
    const { config: synthetic, events } = syntheticRun({ personas: 12, pois: 3, rounds: 3, seed: 4 });
    const store = openProject(join(tmp, 'smoke.gnomi'));
    const { run_id: _, ...snapshot } = synthetic;
    const config = store.createRun(snapshot);
    const logged = [...events, { ...events.at(-1)!, seq: events.length + 1, persona_id: null, poi_id: null, type: 'run.finished', payload: {} } as GnomiEvent]
      .map((event) => ({ ...event, run_id: config.run_id, ...(event.type === 'run.started' && { payload: { config } }) }) as GnomiEvent);
    for (const { seq, ts, ...event } of logged) store.append(event);
    store.finishRun(config.run_id, 'finished', null, 0);
    store.close();
    await page.reload();
    await page.getByText('Starting Gnomi...').waitFor({ state: 'detached' });
    await tab('Run').click();
    await page.getByLabel('Run history', { exact: true }).selectOption(config.run_id);
    await page.getByRole('tab', { name: 'Connections' }).click();
    await graph.getByText(`12 personas, 3 points of interest, ${buildGraph(logged).edges.size} connections`).waitFor();
    const feed = page.getByRole('region', { name: 'Feed' });
    await feed.getByRole('heading', { name: `Feed (${feedThreads(logged).length} threads)` }).waitFor();
    assert.ok(await feed.getByText('Injected by the test harness').count() >= 1, 'the injected post is labelled');
    await page.screenshot({ path: join(shots, 'swarm.png') });

    // Scrub back to round 1: the graph and the feed are rebuilt from the log up to that round.
    const slider = graph.getByRole('slider');
    await slider.focus();
    await page.keyboard.press('Home');
    await graph.getByText('Round 1 of 3').waitFor();
    await graph.getByText(`${graphAtRound(logged, 1).edges.size} connections`, { exact: false }).waitFor();
    await feed.getByRole('heading', { name: `Feed (${feedThreads(logged.filter((event) => event.round <= 1)).length} threads)` }).waitFor();
    await page.keyboard.press('End');
    await graph.getByText('Round 3 of 3 (latest)').waitFor();

    const id = await clickNode(page, 'persona:');
    const memory = socialMemory(logged, id);
    const social = inspector.getByRole('region', { name: 'Social memory' });
    await social.getByText(`Follows (${memory.follows.length})`).waitFor();
    await social.getByText(`Posts seen (${memory.seen.length})`).waitFor();
    await social.getByText(`Own posts (${memory.own.length})`).waitFor();
    await social.screenshot({ path: join(shots, 'inspector-social.png') });
    await inspector.getByRole('button', { name: 'Close' }).click();
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
    await app.evaluate(({ BrowserWindow }, [, height]) => BrowserWindow.getAllWindows()[0].setSize(720, height), size);
    await page.screenshot({ path: join(shots, 'swarm-720.png'), fullPage: true });
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), size);
  });
} finally {
  await app.close();
  await gym?.close();
  if (failures) console.log(`The project folder, with the event log and screenshots, is kept in ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
