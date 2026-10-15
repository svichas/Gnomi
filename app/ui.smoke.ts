// Project journey and timeline interactions in real Electron, using a disposable synthetic run.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { syntheticRun } from '../engine/src/graph/synthetic.ts';
import { openProject } from '../engine/src/log/sqlite.ts';
import { toRows } from './src/renderer/src/activity.ts';

const dir = mkdtempSync(join(tmpdir(), 'gnomi-ui-'));
const projectDir = join(dir, 'perspectives.gnomi');
const shots = join(import.meta.dirname, 'test-results');
mkdirSync(shots, { recursive: true });
const { config: synthetic, events } = syntheticRun({ personas: 6, pois: 1, rounds: 2, seed: 4 });
synthetic.project.name = 'Hiring app';
const store = openProject(projectDir);
store.saveProject(synthetic.project);
const { run_id: _, ...snapshot } = synthetic;
const config = store.createRun(snapshot);
for (const { seq, ts, ...event } of events) store.append({ ...event, run_id: config.run_id, ...(event.type === 'run.started' && { payload: { config } }) } as typeof event);
store.append({ run_id: config.run_id, persona_id: null, poi_id: null, round: 2, type: 'run.finished', payload: {} });
store.finishRun(config.run_id, 'finished', null, 0);
store.close();
const launch = () => electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as string,
  args: ['--use-mock-keychain', `--user-data-dir=${join(dir, 'user-data')}`, join(import.meta.dirname, 'out/main/index.js')],
  env: { ...process.env, GNOMI_FAKE_LLM: '1', GNOMI_PROJECT_DIR: projectDir },
});
let app = await launch();
setTimeout(() => { console.error('UI smoke timed out.'); process.exit(1); }, 180_000).unref();
let passed = false;
try {
  let page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.getByAltText('Gnomi', { exact: true }).evaluate((image) => (image as HTMLImageElement).naturalWidth > 0));
  assert.ok(await page.evaluate(() => [...document.fonts].some((font) => font.family === 'Inter' && font.status === 'loaded')));
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(246, 245, 240)');
  await page.getByRole('button', { name: 'Continue to audience' }).click();
  await page.getByRole('heading', { name: 'A few different perspectives.' }).waitFor();
  await page.getByRole('button', { name: 'Back to setup', exact: true }).first().click();
  assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Hiring app');
  console.log('ok    bundled logo/font load, brand palette applies, and the guided journey preserves setup');

  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `setup overflow at ${width}`);
    await page.screenshot({ path: join(shots, `revamp-setup-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.locator('#tab-run').click();
  await page.getByRole('heading', { name: 'Report', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
  const activity = page.getByRole('region', { name: 'Activity', exact: true });
  await activity.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
  await activity.getByRole('button', { name: 'Filter', exact: true }).click();
  await activity.getByLabel('Kind of event').selectOption('steps');
  await activity.scrollIntoViewIfNeeded();
  const row = activity.locator('.timeline-item').filter({ has: page.locator('.event-message') }).first();
  await row.waitFor();
  const trigger = row.locator('.timeline-trigger');
  await trigger.hover();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'hover leaves activity details collapsed');
  assert.equal(await row.locator('.timeline-detail').isVisible(), false);
  await trigger.focus();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'focus alone leaves details collapsed');
  await trigger.click();
  await row.locator('.timeline-detail').waitFor({ state: 'visible' });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: join(shots, 'revamp-timeline-detail.png') });
  await page.mouse.move(0, 0);
  assert.ok(await row.locator('.timeline-detail').isVisible(), 'clicked details remain open after leaving the row');
  await trigger.click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'click again collapses details');
  await page.keyboard.press('Enter');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'Enter expands details');
  await page.keyboard.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await page.locator('#tab-run').focus();
  await trigger.focus();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  const inspector = page.getByRole('dialog', { name: 'Persona details' });
  const personaName = await row.locator('.timeline-persona-name').innerText();
  const persona = config.personas.find((candidate) => candidate.name === personaName)!;
  const personaRows = toRows(events.filter((event) => event.persona_id === persona.id));
  assert.ok(personaRows.some((item) => item.label === 'Feed'), 'fixture includes routine activity outside the steps filter');
  for (const target of [row.locator('.timeline-persona-name'), row.locator('button.timeline-marker')]) {
    await target.click();
    await inspector.waitFor();
    await inspector.getByRole('heading', { name: personaName, exact: false }).waitFor();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'opening a persona does not expand the activity');
    const history = inspector.getByRole('region', { name: 'Timeline', exact: true }).getByRole('listitem');
    await history.first().waitFor();
    assert.equal(await history.count(), personaRows.length, 'profile includes the entire persona history despite feed filters');
    await inspector.getByText('Full profile', { exact: true }).click();
    assert.ok(await inspector.getByLabel('Profile', { exact: true }).getAttribute('open') !== null);
    await page.screenshot({ path: join(shots, 'revamp-timeline-persona.png') });
    await page.keyboard.press('Escape');
    await inspector.waitFor({ state: 'detached' });
    assert.ok(await target.evaluate((element) => element === document.activeElement), `focus returns to the persona control, got ${await page.evaluate(() => document.activeElement?.tagName)}`);
  }
  await trigger.focus();
  await page.keyboard.press('Space');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'Space expands details');
  await row.getByRole('button', { name: 'View persona & evidence' }).click();
  await inspector.waitFor();
  assert.ok(await inspector.evaluate((dialog) => dialog.contains(document.activeElement)), 'focus enters inspector');
  await page.keyboard.press('Escape');
  await inspector.waitFor({ state: 'detached' });
  await activity.getByRole('button', { name: 'Clear filters' }).click();
  assert.equal(await activity.getByLabel('Kind of event').inputValue(), '');
  await activity.getByRole('button', { name: 'Filter', exact: true }).click();
  const highlights = Number(await activity.locator('.count-label').innerText());
  await activity.getByRole('button', { name: 'All events', exact: true }).click();
  assert.ok(Number(await activity.locator('.count-label').innerText()) > highlights);
  await activity.getByRole('button', { name: 'Highlights', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.locator('#tab-run').focus();
  console.log('ok    click-only timeline details, keyboard controls, persona name/avatar profiles, full history, focus return and filter reset');

  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await activity.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `timeline overflow at ${width}`);
    await page.screenshot({ path: join(shots, `revamp-timeline-${width}.png`) });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await activity.locator('.timeline-item').first().evaluate((element) => getComputedStyle(element).transitionDuration), '0s');
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.getByRole('tab', { name: 'Timeline', exact: true }).focus();
  await page.keyboard.press('End');
  await page.getByRole('region', { name: 'Swarm graph' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Connections', exact: true }).getAttribute('aria-selected'), 'true');
  await page.locator('#tab-project').click();
  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(300); // hidden graph resize callbacks must not throw
  await page.locator('#tab-run').click();
  await page.getByRole('region', { name: 'Swarm graph' }).waitFor();
  assert.ok(await page.locator('.sigma-container').evaluate((element) => element.clientWidth > 0));
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `projects overflow at ${width}`);
    await page.screenshot({ path: join(shots, `revamp-projects-${width}.png`) });
  }
  await page.getByRole('button', { name: 'Open Hiring app', exact: true }).click();
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Hiring app');
  console.log('ok    320/768/1024/1440px layouts, reduced motion, no runtime or console errors, and remembered project after restart');
  passed = true;
} catch (error) {
  await (await app.firstWindow()).screenshot({ path: join(shots, 'revamp-failure.png') });
  throw error;
} finally {
  await app.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`UI fixture retained: ${dir}`);
}
