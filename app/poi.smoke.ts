// POI setup in real Electron: draft preservation, ordering, keyboard use, and responsive layout.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { syntheticRun } from '@gnomi/simulation/graph/synthetic.ts';
import { assertFits, collectErrors, deadline, launchApp, scratch, seedProject, shots } from './electron.fixture.ts';

const dir = scratch('poi');
const projectDir = join(dir, 'project.gnomi');
const project = syntheticRun({ personas: 3, pois: 1, rounds: 1, seed: 4 }).config.project;
project.name = 'Hiring app';
seedProject(projectDir, project);
const app = await launchApp(join(dir, 'user-data'), { GNOMI_PROJECT_DIR: projectDir });
deadline('POI smoke timed out.', 90_000);
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  const errors = collectErrors(page, { console: true });
  await page.getByRole('heading', { name: 'Points of interest', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(shots, 'poi-initial.png'), fullPage: true });
  const list = page.getByRole('list', { name: 'Points of interest', exact: true });
  const section = page.getByRole('region', { name: 'Points of interest', exact: true });
  await section.screenshot({ path: join(shots, 'poi-web.png') });
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  const text = list.getByRole('listitem').filter({ has: page.getByLabel('Text name', { exact: true }) });
  assert.ok(await text.getByLabel('Text name', { exact: true }).evaluate((el) => el === document.activeElement), 'adding focuses the new name');
  await text.getByLabel('Text name', { exact: true }).fill('Welcome email');
  await text.getByLabel('Write or paste the text').fill('Welcome to your next hire. Create a job to get started.');
  const toggle = text.getByRole('button', { name: 'Edit Welcome email', exact: true });
  await toggle.click();
  assert.equal(await text.getByLabel('Write or paste the text').isVisible(), false);
  await toggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await text.getByLabel('Write or paste the text').innerText(), 'Welcome to your next hire. Create a job to get started.', 'collapsing preserves unimported text');
  await text.getByRole('button', { name: 'Use this text', exact: true }).click();
  await text.getByLabel('Text preview').waitFor();
  await text.getByRole('button', { name: 'Move Welcome email up', exact: true }).click();
  assert.equal(await list.locator(':scope > li').first().getAttribute('aria-label'), 'Welcome email');
  await text.getByRole('button', { name: 'Move Welcome email down', exact: true }).click();
  await text.getByRole('button', { name: 'Collapse details', exact: true }).click();
  assert.ok(await toggle.evaluate((el) => el === document.activeElement), 'collapsing returns focus to the editor toggle');
  await page.getByRole('button', { name: 'Add design', exact: true }).click();
  const design = list.getByRole('listitem').filter({ has: page.getByLabel('Design name', { exact: true }) });
  await design.getByLabel('Design name').fill('Onboarding screens');
  await section.screenshot({ path: join(shots, 'poi-design.png') });
  await design.getByRole('button', { name: 'Remove Onboarding screens', exact: true }).click();
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Project saved.', { exact: true }).waitFor();
  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await assertFits(page, `POI overflow at ${width}`);
    await page.screenshot({ path: join(shots, `poi-setup-${width}.png`), fullPage: true });
    await section.screenshot({ path: join(shots, `poi-section-${width}.png`) });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toggle.click();
  await page.setViewportSize({ width: 1440, height: 2000 });
  await section.screenshot({ path: join(shots, 'poi-overview.png') });
  assert.equal(await toggle.locator('.poi-chevron').evaluate((el) => getComputedStyle(el).transitionDuration), '0s');
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.getByRole('button', { name: 'Add from Figma', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add from Figma' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  while (await list.locator(':scope > li').count()) await list.getByRole('button', { name: /^Remove / }).first().click();
  await page.getByText('Start with one thing to try.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add web app', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Start page URL', { exact: true }).fill('https://staging.example.com');
  assert.deepEqual(errors, []);
  console.log('ok    POI choices, focus, draft preservation, reorder/remove, save, Figma entry, empty state and responsive layouts');
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
