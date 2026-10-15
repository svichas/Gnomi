// Run after the app build: node app/projects.smoke.ts. Uses a disposable library and the real Electron window.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { startGym } from '../gym/server.ts';

const dir = mkdtempSync(join(tmpdir(), 'gnomi-project-home-'));
const exported = join(dir, 'exports');
const trash = join(dir, 'trash');
mkdirSync(exported);
mkdirSync(trash);
const gym = await startGym({ port: 0, captcha: true });
const env = { ...process.env, GNOMI_FAKE_LLM: '1' };
Reflect.deleteProperty(env, 'GNOMI_PROJECT_DIR');
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as string,
  args: ['--use-mock-keychain', `--user-data-dir=${join(dir, 'user-data')}`, join(import.meta.dirname, 'out/main/index.js')],
  env,
});
setTimeout(() => { console.error('Project smoke timed out.'); process.exit(1); }, 180_000).unref();
let passed = false;
try {
  // Replace only OS dialogs/trash so the test never needs human input or leaves files in the user's Trash.
  await app.evaluate(({ dialog, shell }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.exported] });
    shell.trashItem = async (path: string) => {
      const fs = process.getBuiltinModule('fs');
      const { basename, join } = process.getBuiltinModule('path');
      fs.renameSync(path, join(paths.trash, basename(path)));
    };
  }, { exported, trash });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const home = () => page.getByRole('button', { name: 'Projects', exact: true }).click();
  const card = (name: string) => page.getByRole('list', { name: 'Projects', exact: true }).getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const manage = async (name: string) => {
    if (!await card(name).getByRole('button', { name: `Rename ${name}`, exact: true }).isVisible()) {
      await card(name).getByLabel(`Manage ${name}`, { exact: true }).click();
    }
  };
  const create = async (name: string) => {
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByLabel('New project name').fill(name);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
  };

  await page.getByRole('heading', { name: 'Your projects.', exact: true }).waitFor();
  await create('Hiring app');
  await page.getByRole('heading', { name: 'What to test' }).waitFor();
  mkdirSync(join(import.meta.dirname, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(import.meta.dirname, 'test-results', 'revamp-setup.png') });
  assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Hiring app');
  await page.getByLabel('Start page URL').fill(`${gym.url}/candidates`);
  await page.getByLabel('Goal', { exact: true }).fill('Review a candidate');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Project saved.', { exact: true }).waitFor();
  console.log('ok    create opens an isolated project and saves its configuration');

  await page.getByLabel('Project name', { exact: true }).fill('Unsaved name');
  await home();
  await card('Untitled project').getByRole('button', { name: 'Open Untitled project', exact: true }).click();
  const changes = page.getByRole('dialog', { name: 'Save your changes?' });
  await changes.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Return to open project' }).click();
  assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Unsaved name');
  await home();
  await create('Second app');
  await changes.getByRole('button', { name: 'Discard changes' }).click();
  await page.getByRole('heading', { name: 'What to test' }).waitFor();
  assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Second app');
  assert.equal(await page.getByLabel('Start page URL').inputValue(), '');
  console.log('ok    cancel preserves dirty edits; discard switches to a fresh project');

  await home();
  await manage('Hiring app');
  const hiringActions = card('Hiring app').locator('.project-menu-items');
  const hiringTrigger = card('Hiring app').getByLabel('Manage Hiring app', { exact: true });
  await page.getByRole('button', { name: 'New project', exact: true }).focus();
  await hiringActions.waitFor({ state: 'hidden', timeout: 1000 });
  await manage('Hiring app');
  await page.getByRole('heading', { name: 'Your projects.', exact: true }).click();
  await hiringActions.waitFor({ state: 'hidden' });
  await manage('Hiring app');
  await hiringTrigger.click();
  await hiringActions.waitFor({ state: 'hidden' });
  await hiringTrigger.focus();
  await page.keyboard.press('Enter');
  await hiringActions.waitFor({ state: 'visible' });
  await page.keyboard.press('Tab');
  assert.equal(await card('Hiring app').getByRole('button', { name: 'Rename Hiring app', exact: true }).evaluate((button) => button === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await card('Hiring app').getByRole('button', { name: 'Duplicate Hiring app', exact: true }).evaluate((button) => button === document.activeElement), true);
  await page.keyboard.press('Escape');
  await hiringActions.waitFor({ state: 'hidden' });
  assert.equal(await hiringTrigger.evaluate((button) => button === document.activeElement), true, 'Escape returns focus to the trigger');
  await page.keyboard.press('Space');
  await hiringActions.waitFor({ state: 'visible' });
  await page.keyboard.press('Shift+Tab');
  await hiringActions.waitFor({ state: 'hidden' });
  await manage('Hiring app');
  await card('Second app').getByLabel('Manage Second app', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await hiringActions.waitFor({ state: 'hidden' });
  await manage('Hiring app');
  assert.equal(await card('Second app').locator('.project-menu-items').isVisible(), false, 'only one project menu stays open');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await hiringActions.waitFor({ state: 'hidden' });
  console.log('ok    project actions dismiss on blur, outside click, Escape, toggle, and opening another menu; keyboard focus stays usable');

  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await manage('Hiring app');
    const alignment = await card('Hiring app').evaluate((row) => {
      const trigger = row.querySelector('[aria-label="Manage Hiring app"]')!.getBoundingClientRect();
      const icon = row.querySelector('[aria-label="Manage Hiring app"] svg')!.getBoundingClientRect();
      const open = row.querySelector('.project-open')!.getBoundingClientRect();
      const panel = row.querySelector('.project-menu-items')!.getBoundingClientRect();
      return { triggerY: trigger.y + trigger.height / 2, iconY: icon.y + icon.height / 2, rowY: open.y + open.height / 2, right: panel.right, left: panel.left, width: trigger.width, height: trigger.height };
    });
    assert.ok(Math.abs(alignment.triggerY - alignment.rowY) < 1, `centered trigger at ${width}px`);
    assert.ok(Math.abs(alignment.iconY - alignment.rowY) < 1, `centered dots at ${width}px`);
    assert.ok(alignment.width >= 40 && alignment.height >= 40, 'comfortable click target');
    assert.ok(alignment.left >= 0 && alignment.right <= width, `menu fits at ${width}px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(import.meta.dirname, 'test-results', `project-menu-${width}.png`) });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1100, height: 900 });
  await manage('Hiring app');
  await card('Hiring app').getByRole('button', { name: 'Rename Hiring app', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename project' });
  await hiringActions.waitFor({ state: 'hidden' });
  await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await hiringTrigger.evaluate((button) => button === document.activeElement), true, 'dialog returns focus to the menu trigger');
  await manage('Hiring app');
  await card('Hiring app').getByRole('button', { name: 'Rename Hiring app', exact: true }).click();
  await rename.getByLabel('Project name', { exact: true }).fill('Hiring team');
  await rename.getByRole('button', { name: 'Rename project', exact: true }).click();
  await card('Hiring team').waitFor();
  await manage('Hiring team');
  await card('Hiring team').getByRole('button', { name: 'Duplicate Hiring team', exact: true }).click();
  const duplicate = page.getByRole('dialog', { name: 'Duplicate project' });
  await duplicate.getByRole('button', { name: 'Create duplicate' }).click();
  await page.getByRole('heading', { name: 'What to test' }).waitFor();
  assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Hiring team copy');
  assert.equal(await page.getByLabel('Goal', { exact: true }).inputValue(), 'Review a candidate');
  console.log('ok    rename persists and duplicate opens with the copied configuration');

  await page.getByLabel('Goal', { exact: true }).fill('Review two candidates');
  await home();
  await card('Second app').getByRole('button', { name: 'Open Second app', exact: true }).click();
  await changes.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByRole('heading', { name: 'What to test' }).waitFor();
  await home();
  await card('Hiring team copy').getByRole('button', { name: 'Open Hiring team copy', exact: true }).click();
  await page.getByRole('heading', { name: 'What to test' }).waitFor();
  assert.equal(await page.getByLabel('Goal', { exact: true }).inputValue(), 'Review two candidates');
  console.log('ok    save and continue persists dirty edits before switching');

  await home();
  const before = await page.evaluate(() => window.gnomi.listProjects());
  const failedRename = await page.evaluate(async (id) => {
    try { await window.gnomi.projectAction({ action: 'rename', id, name: '' }); return ''; }
    catch (err) { return String(err); }
  }, before.currentId);
  assert.match(failedRename, /name of 1/);
  assert.equal((await page.evaluate(() => window.gnomi.listProjects())).currentId, before.currentId);
  await manage('Hiring team copy');
  await card('Hiring team copy').getByRole('button', { name: 'Export Hiring team copy folder' }).click();
  await page.getByRole('status').filter({ hasText: 'Project folder exported to' }).waitFor();
  assert.equal((await page.evaluate(() => window.gnomi.listProjects())).currentId, before.currentId);
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await manage('Hiring team copy');
  await card('Hiring team copy').getByRole('button', { name: 'Export Hiring team copy folder' }).click();
  await page.getByText('Working on the project…').waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.gnomi.listProjects())).currentId, before.currentId);
  await manage('Hiring team copy');
  await card('Hiring team copy').getByRole('button', { name: 'Delete Hiring team copy', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete project?' });
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
  await card('Hiring team copy').waitFor();
  await manage('Hiring team copy');
  await card('Hiring team copy').getByRole('button', { name: 'Delete Hiring team copy', exact: true }).click();
  await deletion.getByRole('button', { name: 'Move to Trash' }).click();
  await card('Hiring team copy').waitFor({ state: 'detached' });
  assert.ok(existsSync(join(trash, before.currentId)));
  console.log('ok    export/cancel keep the active project; delete requires confirmation and uses trash');

  await card('Hiring team').getByRole('button', { name: 'Open Hiring team', exact: true }).click();
  await page.getByRole('heading', { name: 'What to test' }).waitFor();
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start run', exact: true }).click();
  await page.getByRole('alert', { name: 'Personas are waiting for you' }).waitFor({ timeout: 60_000 });
  await home();
  await card('Second app').getByRole('button', { name: 'Open Second app', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /Stop the current run/ }).waitFor();
  assert.equal((await page.evaluate(() => window.gnomi.listProjects())).currentId, before.projects.find((entry) => entry.name === 'Hiring team')?.id);
  await page.getByRole('button', { name: 'Return to open project' }).click();
  await page.locator('#tab-run').click();
  await page.getByRole('button', { name: 'End run', exact: true }).click();
  await page.getByRole('tab', { name: 'Report', exact: true }).click();
  await page.getByRole('heading', { name: 'Report', exact: true }).waitFor();
  await home();
  await card('Second app').getByRole('button', { name: 'Open Second app', exact: true }).click();
  await page.getByRole('heading', { name: 'What to test' }).waitFor();
  assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Second app');
  console.log('ok    a live run refuses project switching; switching works after the run ends');

  await page.reload();
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Second app');
  await home();
  assert.match(await card('Second app').innerText(), /Last opened/);
  mkdirSync(join(import.meta.dirname, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(import.meta.dirname, 'test-results', 'projects-home.png') });
  await page.setViewportSize({ width: 720, height: 780 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: join(import.meta.dirname, 'test-results', 'projects-home-narrow.png') });
  assert.deepEqual(errors, []);
  console.log('ok    reload retains the selected project; 720px home fits and has no runtime errors');
  passed = true;
} catch (err) {
  mkdirSync(join(import.meta.dirname, 'test-results'), { recursive: true });
  await (await app.firstWindow()).screenshot({ path: join(import.meta.dirname, 'test-results', 'projects-failure.png') });
  throw err;
} finally {
  await app.close();
  await gym.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Project smoke artifacts: ${dir}`);
}
