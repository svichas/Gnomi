// Real Electron with disposable data. Hold engine requests to inspect long-running UI states,
// then release them to the scripted engine so completion uses the real saved population.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { syntheticRun } from '../engine/src/graph/synthetic.ts';
import { openProject } from '../engine/src/log/sqlite.ts';
import type { PersonaProgress } from '../engine/src/types.ts';

type HeldRequest = { release(): void; progress(done: number, total: number, detail?: Partial<PersonaProgress>): void; fail(): void };
declare global { interface Window { audienceSmoke: HeldRequest | null; } }
const dir = mkdtempSync(join(tmpdir(), 'gnomi-audience-'));
const projectDir = join(dir, 'audience.gnomi');
const shots = join(import.meta.dirname, 'test-results');
mkdirSync(shots, { recursive: true });
const project = syntheticRun({ personas: 3, pois: 1, rounds: 1, seed: 4 }).config.project;
project.audience = null;
const store = openProject(projectDir);
store.saveProject(project);
store.close();
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as string,
  args: ['--use-mock-keychain', `--user-data-dir=${join(dir, 'user-data')}`, join(import.meta.dirname, 'out/main/index.js')],
  env: { ...process.env, GNOMI_FAKE_LLM: '1', GNOMI_PROJECT_DIR: projectDir },
});
setTimeout(() => { console.error('Audience smoke timed out.'); process.exit(1); }, 120_000).unref();
let passed = false;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  await page.addInitScript(() => {
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, options) {
      const transfer = Array.isArray(options) ? { transfer: options } : options;
      if (message?.kind === 'request' && ['propose_audience', 'generate_personas'].includes(message.method)) {
        const port = this;
        window.audienceSmoke = {
          release() { window.audienceSmoke = null; post.call(port, message, transfer); },
          progress(done, total, detail = {}) { port.dispatchEvent(new MessageEvent('message', { data: { kind: 'progress', task: 'generate_personas', done, total, ...detail } })); },
          fail() { window.audienceSmoke = null; port.dispatchEvent(new MessageEvent('message', { data: { kind: 'response', id: message.id, ok: false, error: 'The provider is temporarily unavailable. Try again.' } })); },
        };
      } else post.call(this, message, transfer);
    };
  });
  await page.reload();
  await page.locator('#tab-audience').click();
  const panel = page.locator('#panel-audience');
  const review = panel.getByRole('button', { name: 'Review & start', exact: true });
  const generate = panel.getByRole('button', { name: 'Generate personas', exact: true });
  await panel.getByRole('button', { name: 'Suggest an audience', exact: true }).click();
  await panel.getByRole('heading', { name: 'Finding the right mix.' }).waitFor();
  await page.waitForFunction(() => window.audienceSmoke !== null && window.audienceSmoke !== undefined);
  assert.ok(await review.isDisabled());
  assert.equal(await panel.getByRole('progressbar').count(), 0, 'planning does not invent a percentage');
  assert.notEqual(await panel.locator('.build-person').first().evaluate((el) => getComputedStyle(el).animationName), 'none');
  await page.screenshot({ path: join(shots, 'audience-planning.png') });
  await page.evaluate(() => window.audienceSmoke!.fail());
  await panel.getByRole('alert').filter({ hasText: 'temporarily unavailable' }).waitFor();
  assert.equal(await panel.locator('.build-progress').count(), 0);
  await panel.getByRole('button', { name: 'Suggest an audience', exact: true }).click();
  await page.waitForFunction(() => !!window.audienceSmoke);
  await page.evaluate(() => window.audienceSmoke!.release());
  await generate.waitFor();
  assert.ok(await review.isDisabled(), 'audience planning alone does not unlock the run');
  await panel.getByLabel('Number of personas', { exact: true }).fill('50');
  await page.screenshot({ path: join(shots, 'audience-next-step.png') });
  await page.locator('#tab-project').click();
  await page.getByRole('button', { name: 'Build personas first', exact: true }).click();
  await generate.waitFor();
  await generate.click();
  await page.waitForFunction(() => !!window.audienceSmoke);
  const meter = panel.getByRole('progressbar', { name: 'Writing personas' });
  await page.evaluate(() => window.audienceSmoke!.progress(0, 50, { stage: 'sketching', calls: 12, failed_attempts: 1 }));
  await panel.getByText('Choosing varied profiles…', { exact: true }).waitFor();
  await panel.getByText(/12 model attempts · 1 failed attempts/).waitFor();
  await page.evaluate(() => window.audienceSmoke!.progress(0, 50, { stage: 'repairing_names' }));
  await panel.getByText('Resolving duplicate names…', { exact: true }).waitFor();
  await page.evaluate(() => window.audienceSmoke!.progress(0, 50, { stage: 'sketching', sketched: 3 }));
  await meter.waitFor();
  assert.equal(await meter.getAttribute('aria-valuenow'), '3', 'the meter moves with the first sketches');
  await page.evaluate(() => window.audienceSmoke!.progress(1, 50, { stage: 'writing', calls: 51, sketched: 12, recent: ['Ana Ruiz'] }));
  await panel.getByText('Writing the selected biographies…', { exact: true }).waitFor();
  await panel.getByText('Just written: Ana Ruiz', { exact: true }).waitFor();
  assert.equal(await meter.getAttribute('aria-valuenow'), '13');
  assert.equal(await meter.getAttribute('aria-valuetext'), '1 of 50 personas written');
  assert.equal(await panel.locator('.build-counter strong').innerText(), '1 / 50');
  assert.ok(await review.isDisabled());
  assert.ok(await panel.getByLabel('Number of personas', { exact: true }).isDisabled());
  await page.evaluate(() => window.audienceSmoke!.progress(12, 50));
  await page.waitForFunction(() => document.querySelector('.build-counter strong')?.textContent === '12 / 50');
  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await panel.locator('.build-progress').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `audience overflow at ${width}`);
    await page.screenshot({ path: join(shots, `audience-personas-${width}.png`) });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await panel.locator('.build-person').first().evaluate((el) => getComputedStyle(el).animationName), 'none');
  await page.evaluate(() => window.audienceSmoke!.progress(50, 50));
  await panel.getByText('Finishing touches', { exact: true }).waitFor();
  assert.ok(await review.isDisabled(), 'all drafts written still waits for saving');
  await page.evaluate(() => window.audienceSmoke!.fail());
  await generate.waitFor();
  assert.ok(await review.isDisabled(), 'a failed build does not unlock the run');
  await page.setViewportSize({ width: 1100, height: 900 });
  await generate.click();
  await page.waitForFunction(() => !!window.audienceSmoke);
  await page.evaluate(() => window.audienceSmoke!.release());
  await panel.getByRole('status').filter({ hasText: '50 personas are ready' }).waitFor();
  assert.ok(await review.isEnabled());
  assert.equal(await panel.locator('.build-progress').count(), 0);
  await panel.getByRole('heading', { name: 'Personas (50)', exact: true }).waitFor();
  await generate.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'audience-ready.png') });
  const details = panel.locator('details').filter({ has: page.locator('summary', { hasText: 'Generation details' }) });
  await details.locator('summary').click();
  assert.equal(await details.getByRole('cell', { name: 'Sketches', exact: true }).count(), 50);
  assert.equal(await details.getByRole('cell', { name: 'Biography', exact: true }).count(), 50);
  await details.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'audience-generation-details.png') });
  await page.setViewportSize({ width: 320, height: 960 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'diagnostics fit a narrow viewport');
  await page.setViewportSize({ width: 1100, height: 900 });
  await panel.getByRole('button', { name: 'Add segment', exact: true }).click();
  await panel.getByRole('button', { name: 'Add segment', exact: true }).click();
  assert.equal(await panel.getByRole('list', { name: 'Segments', exact: true }).locator(':scope > li').count(), 5);
  const count = panel.getByLabel('Number of personas', { exact: true });
  assert.equal(await count.getAttribute('min'), '1');
  await count.fill('1');
  assert.ok(await count.evaluate((el) => (el as HTMLInputElement).checkValidity()));
  await generate.click();
  await page.waitForFunction(() => !!window.audienceSmoke);
  await page.evaluate(() => window.audienceSmoke!.release());
  await panel.getByRole('status').filter({ hasText: '1 persona is ready' }).waitFor();
  await panel.getByRole('heading', { name: 'Personas (1)', exact: true }).waitFor();
  assert.ok(await review.isEnabled());
  await page.screenshot({ path: join(shots, 'audience-single-persona.png') });
  await review.click();
  const reviewStep = page.locator('#panel-review');
  await reviewStep.getByText('1 simulated person', { exact: true }).waitFor();
  assert.equal(await page.locator('.step-nav [aria-current]').innerText(), '3\nReview');
  await reviewStep.getByRole('button', { name: 'Back to audience', exact: true }).click();
  await page.locator('#tab-settings').click();
  await page.getByLabel('Writer concurrency (1-32)', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved with the project.', { exact: true }).waitFor();
  await page.reload();
  await page.locator('#tab-audience').click();
  assert.equal(await panel.getByLabel('Number of personas', { exact: true }).inputValue(), '1');
  await panel.getByRole('heading', { name: 'Personas (1)', exact: true }).waitFor();
  await page.locator('#tab-settings').click();
  assert.equal(await page.getByLabel('Writer concurrency (1-32)', { exact: true }).inputValue(), '4');
  assert.deepEqual(errors, []);
  console.log('ok    audience planning, stages/attempts, failure/retry, completion, call diagnostics, single-persona generation/review/persistence, saved concurrency, responsive layouts and reduced motion');
  passed = true;
} finally {
  await app.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Audience smoke artifacts: ${dir}`);
}
