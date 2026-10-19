// npm run smoke:profiles -w @gnomi/app. Real Electron UI with scripted personas; no keys or paid calls.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { startGym } from '../gym/server.ts';

type DownloadState = typeof globalThis & { profileSmokeDownload?: Promise<string> };

const dir = mkdtempSync(join(tmpdir(), 'gnomi-profile-editor-'));
const templatePath = join(dir, 'profile-template.json');
const shots = join(import.meta.dirname, 'test-results');
mkdirSync(shots, { recursive: true });
const gym = await startGym({ port: 0, defects: 'all' });
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as string,
  args: ['--use-mock-keychain', `--user-data-dir=${join(dir, 'user-data')}`, join(import.meta.dirname, 'out/main/index.js')],
  env: { ...process.env, GNOMI_FAKE_LLM: '1', GNOMI_PROJECT_DIR: join(dir, 'profiles.gnomi') },
});
setTimeout(() => { console.error('Profile smoke timed out.'); process.exit(1); }, 240_000).unref();
let passed = false;
try {
  await app.evaluate(({ session }, path) => {
    (globalThis as DownloadState).profileSmokeDownload = new Promise((resolve) => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(path);
        item.once('done', (_done, status) => resolve(status));
      });
    });
  }, templatePath);
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const tab = (name: string) => page.locator(`#tab-${({ Project: 'project', Settings: 'settings', Audience: 'audience', Run: 'run' } as Record<string, string>)[name]}`).click();
  await page.getByText('Starting Gnomi...').waitFor({ state: 'detached' });
  await tab('Project');
  await page.getByLabel('Project name', { exact: true }).fill('Profile Gym');
  await page.getByLabel('What the product does', { exact: true }).fill('A hiring app for growing teams');
  await page.getByLabel('Start page URL').fill(gym.url);
  await page.getByLabel('Goal', { exact: true }).fill('Post a job');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Project saved.', { exact: true }).waitFor();
  await tab('Audience');
  const audience = page.locator('#panel-audience');
  await audience.getByRole('button', { name: 'Build my own' }).click();
  await audience.getByLabel('Number of personas', { exact: true }).fill('6');
  await audience.getByText('Reproducibility options', { exact: true }).click();
  await audience.getByLabel('Seed', { exact: true }).fill('42');
  await audience.getByLabel('Segment name', { exact: true }).fill('Recruiters');
  await audience.getByLabel('Employers for Recruiters').fill('Northwind');
  await audience.getByRole('button', { name: 'Add segment', exact: true }).click();
  await audience.getByLabel('Segment name', { exact: true }).nth(1).fill('Buyers');
  await audience.getByLabel('Who they are', { exact: true }).nth(1).fill('People buying hiring software');
  await audience.getByLabel('Employers for Buyers').fill('Contoso');

  await audience.locator('summary').filter({ hasText: 'Customize persona attributes' }).click();
  const editor = audience.getByRole('heading', { name: 'Profile attributes', exact: true }).locator('..');
  const attribute = (name: string) => editor.getByRole('listitem', { name: `${name} attribute`, exact: true });
  const group = async (name: string) => {
    const summary = editor.locator('summary').filter({ hasText: new RegExp(`^${name} \\(`) }).first();
    if (!(await summary.locator('..').getAttribute('open') !== null)) await summary.click();
  };
  await group('Identity');
  assert.equal(await attribute('Name').getByLabel('Include Name', { exact: true }).isDisabled(), true);
  assert.equal(await attribute('Name').getByLabel('Use Name in prompts', { exact: true }).isDisabled(), true);
  await editor.getByRole('button', { name: 'Add custom attribute', exact: true }).click();
  const add = editor.getByRole('form', { name: 'New profile attribute' });
  await add.getByLabel('Attribute name', { exact: true }).fill('Procurement region');
  await add.getByLabel('Attribute description', { exact: true }).fill('The region where their team buys software');
  await add.getByLabel('Attribute choices', { exact: true }).fill('EMEA\nAmericas');
  await add.getByRole('button', { name: 'Add attribute', exact: true }).click();
  const region = attribute('Procurement region');
  await region.getByLabel('Use Procurement region as a report dimension', { exact: true }).check();
  await region.getByText('Configure Procurement region', { exact: true }).click();
  await region.getByLabel('Procurement region — Everyone: EMEA weight', { exact: true }).fill('3');
  await region.getByLabel('Procurement region — Everyone: Americas weight', { exact: true }).fill('1');
  for (const [segment, emea, americas] of [['Recruiters', '100', '0'], ['Buyers', '0', '100']]) {
    await region.getByLabel('Sampling for Procurement region', { exact: true }).selectOption({ label: segment });
    await region.getByLabel(`Use a separate rule for ${segment}`, { exact: true }).check();
    await region.getByLabel(`Procurement region — ${segment}: EMEA weight`, { exact: true }).fill(emea);
    await region.getByLabel(`Procurement region — ${segment}: Americas weight`, { exact: true }).fill(americas);
  }
  await attribute('Employer').getByLabel('Include Employer', { exact: true }).uncheck();
  console.log('ok    core guards, custom choice attributes and segment weights are editable');

  await editor.getByRole('button', { name: 'Save template', exact: true }).click();
  assert.equal(await app.evaluate(() => (globalThis as DownloadState).profileSmokeDownload), 'completed');
  assert.ok(existsSync(templatePath));
  const savedTemplate = JSON.parse(readFileSync(templatePath, 'utf8'));
  assert.equal(savedTemplate.attributes.find((item: { id: string }) => item.id === 'procurement_region').sampling.by_segment['seg-1'].choices[0].weight, 100);
  await region.getByRole('button', { name: 'Remove Procurement region', exact: true }).click();
  assert.equal(await attribute('Procurement region').count(), 0);
  await editor.getByLabel('Load profile template', { exact: true }).setInputFiles(templatePath);
  await editor.getByRole('status').filter({ hasText: 'Template loaded.' }).waitFor();
  await group('Work');
  assert.equal(await region.getByLabel('Use Procurement region as a report dimension', { exact: true }).isChecked(), true);
  assert.equal(await attribute('Employer').getByLabel('Include Employer', { exact: true }).isChecked(), false);
  const invalidTemplate = structuredClone(savedTemplate);
  invalidTemplate.attributes.find((item: { id: string }) => item.id === 'name').enabled = false;
  const invalidPath = join(dir, 'invalid-template.json');
  writeFileSync(invalidPath, JSON.stringify(invalidTemplate));
  await editor.getByLabel('Load profile template', { exact: true }).setInputFiles(invalidPath);
  await editor.getByRole('alert').filter({ hasText: /Core profile attribute name/ }).waitFor();
  assert.equal(await attribute('Procurement region').count(), 1);
  console.log('ok    template download/import restores typed rules; invalid core templates leave the draft intact');
  await editor.getByLabel('Load profile template', { exact: true }).setInputFiles(templatePath);

  await audience.getByRole('button', { name: 'Generate personas', exact: true }).first().click();
  const people = audience.getByRole('heading', { name: 'Personas (6)', exact: true }).locator('..');
  await people.waitFor();
  await audience.getByRole('status').filter({ hasText: '6 personas are ready' }).waitFor();
  await people.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Buyers \(/ }) }).locator('summary').first().click();
  const cards = people.getByRole('listitem', { name: / persona$/ });
  assert.equal(await cards.count(), 6);
  assert.equal(await cards.locator('dt').filter({ hasText: /^Employer$/ }).count(), 0);
  assert.equal(await cards.locator('dd').filter({ hasText: /^EMEA$/ }).count(), 3);
  assert.equal(await cards.locator('dd').filter({ hasText: /^Americas$/ }).count(), 3);
  await group('Identity');
  await attribute('Name').getByLabel('Show Name on cards', { exact: true }).uncheck();
  assert.equal(await people.getByRole('listitem', { name: /^Persona p-.* persona$/ }).count(), 6);
  assert.equal(await audience.getByText(/need regeneration after profile changes/).count(), 0);
  await attribute('Name').getByLabel('Show Name on cards', { exact: true }).check();
  await cards.first().locator('summary').click();
  await cards.first().getByRole('button', { name: /^Edit / }).click();
  await cards.first().getByLabel(/^Background \(/).fill('An old biography that must disappear when the profile changes.');
  await attribute('Pronouns').getByLabel('Include Pronouns', { exact: true }).uncheck();
  await audience.getByText('6 personas need regeneration after profile changes.', { exact: false }).waitFor();
  assert.equal(await cards.first().getByRole('textbox').count(), 0);
  assert.equal(await cards.first().getByRole('button', { name: /^Save edits to / }).count(), 0);
  assert.equal(await cards.locator('dt').filter({ hasText: /^(Biography|Voice|Job title)$/ }).count(), 0);
  await audience.locator('.action-bar').getByRole('button', { name: 'Generate personas', exact: true }).click(); // stale personas: the step bar offers it too
  await audience.getByRole('status').filter({ hasText: '6 personas are ready' }).waitFor();
  await audience.getByText('6 personas need regeneration after profile changes.', { exact: false }).waitFor({ state: 'detached' });
  assert.equal(await cards.first().getByRole('textbox').count(), 0);
  console.log('ok    disabled fields disappear, card-only switches stay fresh, and stale prose waits for regeneration');

  await cards.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'profiles-cards.png') });
  await page.setViewportSize({ width: 720, height: 780 });
  await group('Work');
  await region.getByText('Configure Procurement region', { exact: true }).click();
  await region.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: join(shots, 'profiles-editor-narrow.png') });
  await page.setViewportSize({ width: 1100, height: 780 });

  await tab('Project');
  await page.getByRole('button', { name: 'Review & start', exact: true }).click();
  await page.locator('#panel-review').getByRole('button', { name: 'Start run', exact: true }).click();
  await page.getByRole('tab', { name: 'Report', exact: true }).click({ timeout: 120_000 });
  await page.getByRole('heading', { name: 'Report', exact: true }).waitFor({ timeout: 120_000 });
  await page.locator('summary').filter({ hasText: 'Filter report by audience' }).click();
  await page.getByLabel('Profile dimension', { exact: true }).selectOption({ label: 'Procurement region' });
  await page.getByLabel('Profile value', { exact: true }).selectOption({ label: 'EMEA' });
  await page.getByText('Showing 3 of 6 personas', { exact: false }).waitFor();
  assert.equal(await page.getByRole('region', { name: /How each persona did/ }).locator('details').count(), 3);
  assert.equal(await page.getByLabel('Profile dimension', { exact: true }).locator('option[value="employer"]').count(), 0);
  await page.screenshot({ path: join(shots, 'profiles-report-filter.png') });
  assert.deepEqual(errors, []);
  console.log('ok    the run snapshot exposes the custom report filter and its three matching personas');
  passed = true;
} catch (err) {
  await (await app.firstWindow()).screenshot({ path: join(shots, 'profiles-failure.png') });
  throw err;
} finally {
  await app.close();
  await gym.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Profile smoke artifacts: ${dir}`);
}
