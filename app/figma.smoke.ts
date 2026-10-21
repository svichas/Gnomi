// Figma frame import in real Electron, against the engine's fixture API (GNOMI_FAKE_FIGMA): no token, no network.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { FAKE_KEY } from '../engine/src/figma/fake.ts';
import { syntheticRun } from '@gnomi/simulation/graph/synthetic.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import type { DesignPoi } from '@gnomi/simulation/types.ts';
import { collectErrors, deadline, launchApp, scratch, seedProject, shots } from './electron.fixture.ts';

const dir = scratch('figma');
const projectDir = join(dir, 'project.gnomi');
const userData = join(dir, 'user-data');
const TOKEN = 'figd_smoke-token-0123456789abcdefghij';
const link = `https://www.figma.com/design/${FAKE_KEY}/Acme-checkout?node-id=1-3`;
const project = syntheticRun({ personas: 3, pois: 1, rounds: 1, seed: 4 }).config.project;
project.audience = null;
seedProject(projectDir, project);

// frame 1:5 ("04 Cart 4") is one Figma cannot render
const app = await launchApp(userData, { GNOMI_FAKE_FIGMA: JSON.stringify({ nullRender: ['1:5'] }), GNOMI_PROJECT_DIR: projectDir });
deadline('Figma smoke timed out.', 120_000);
let passed = false;
try {
  const page: Page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  const errors = collectErrors(page);
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  const dialog = page.getByRole('dialog', { name: 'Add from Figma' });
  const openDialog = async () => {
    await page.getByRole('button', { name: 'Add from Figma', exact: true }).click();
    await dialog.getByLabel('Figma link').waitFor();
  };
  const find = async (text: string) => {
    await dialog.getByLabel('Figma link').fill(text);
    await dialog.getByRole('button', { name: 'Find frames', exact: true }).click();
  };

  // 1. No token yet, and a pasted text that is no link.
  await openDialog();
  await find('this is not a link');
  await dialog.getByRole('alert').getByText('That is not a Figma link.', { exact: false }).waitFor();
  await find(link);
  const missing = dialog.getByRole('alert').filter({ hasText: 'Add a Figma access token in Settings first.' });
  await missing.getByText('Connect Figma first', { exact: true }).waitFor();
  await page.screenshot({ path: join(shots, 'figma-no-token.png') });
  await missing.getByRole('button', { name: 'Open Settings' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.id === 'settings-figma');
  console.log('ok    a malformed link and a missing token each get a clear message; the token error opens the Figma settings');

  // 2. Settings: the token is masked, tested, and joins the egress list only while it is saved.
  const settings = page.locator('#panel-settings');
  const egress = settings.locator('section').filter({ has: page.getByRole('heading', { name: 'Where Gnomi connects' }) });
  assert.equal(await egress.getByText('api.figma.com').count(), 0);
  const addToken = async (token: string) => {
    await settings.getByLabel('Figma access token').fill(token);
    await settings.getByRole('button', { name: 'Save token', exact: true }).click();
    await settings.getByRole('button', { name: 'Remove Figma', exact: true }).waitFor();
  };
  await addToken('figd_expired');
  await settings.getByRole('button', { name: 'Test Figma', exact: true }).click();
  await settings.getByText('Did not work').waitFor();
  await settings.getByText('wrong, revoked or expired', { exact: false }).first().waitFor();
  await settings.getByText('Your Figma token stopped working', { exact: true }).waitFor();
  assert.equal(await settings.getByRole('button', { name: 'Open Settings' }).count(), 0, 'no link to the page it is on');
  await page.screenshot({ path: join(shots, 'figma-expired-token.png') });
  await settings.getByRole('button', { name: 'Remove Figma', exact: true }).click();
  await settings.getByLabel('Figma access token').waitFor();
  assert.equal(await egress.getByText('api.figma.com').count(), 0, 'removing the token takes Figma off the list');
  await addToken(TOKEN);
  await settings.getByText('fig…ghij').waitFor();
  assert.equal(await settings.getByLabel('Figma access token').count(), 0);
  await settings.getByRole('button', { name: 'Test Figma', exact: true }).click();
  await settings.getByText(/✓\s*Works/).waitFor();
  await egress.getByText('api.figma.com').waitFor();
  assert.ok(!(await page.content()).includes(TOKEN), 'the page never holds the token');
  assert.ok(!(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]) + document.cookie)).includes(TOKEN));
  await page.screenshot({ path: join(shots, 'figma-settings.png'), fullPage: true });
  console.log('ok    the token is masked, tested, kept off the page, and listed as an egress address only while set');

  // 3. Import: 50 frames listed, previews arrive, a frame link preselects its frame, one frame fails to export.
  await page.locator('#tab-project').click();
  await openDialog();
  const started = Date.now();
  await find(link);
  const boxes = dialog.getByRole('checkbox');
  await boxes.nth(49).waitFor();
  assert.equal(await boxes.count(), 50);
  assert.ok(Date.now() - started < 10_000, 'listing took under ten seconds');
  assert.ok(await dialog.getByRole('checkbox', { name: /02 Screen 2/ }).isChecked(), 'the frame in the link is chosen');
  assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 1);
  await dialog.getByText('Variants', { exact: false }).first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('dialog img').length > 40);
  assert.ok(await dialog.locator('img').first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), 'previews decode');
  for (const width of [1100, 720, 375]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth), false, `the dialog overflows at ${width}`);
    await page.screenshot({ path: join(shots, `figma-dialog-${width}.png`) });
  }
  await page.setViewportSize({ width: 1100, height: 900 });

  await dialog.getByRole('checkbox', { name: /04 Cart 4/ }).check();
  await dialog.getByRole('checkbox', { name: /01 Cart 1/ }).check();
  const order = dialog.getByRole('list', { name: 'Frames to import, in order' });
  assert.deepEqual(await order.locator('li span.truncate').allInnerTexts(), ['02 Screen 2', '04 Cart 4', '01 Cart 1']);
  await dialog.getByRole('button', { name: 'Move 01 Cart 1 up', exact: true }).click();
  assert.deepEqual(await order.locator('li span.truncate').allInnerTexts(), ['02 Screen 2', '01 Cart 1', '04 Cart 4']);
  await dialog.getByRole('button', { name: 'Import 3 frames', exact: true }).click();
  const failed = dialog.getByRole('alert').filter({ hasText: 'could not be exported' });
  await failed.getByText('04 Cart 4').waitFor();
  await failed.getByText('Figma could not render this frame.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('listitem', { name: 'Acme checkout' }).count(), 0, 'nothing is added while a frame is missing');
  await page.screenshot({ path: join(shots, 'figma-dialog-failed.png') });
  await dialog.getByRole('button', { name: 'Retry the failed frames', exact: true }).click();
  await failed.getByText('04 Cart 4').waitFor();
  // Leaving the frame out is a way forward too: what was exported is kept, so nothing is fetched again.
  await dialog.getByRole('checkbox', { name: /04 Cart 4/ }).uncheck();
  await failed.waitFor({ state: 'hidden' });
  await dialog.getByRole('button', { name: 'Import 2 frames', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const first = page.getByRole('listitem', { name: 'Acme checkout' });
  await first.waitFor();
  await page.waitForFunction(() => document.activeElement === document.querySelector('.poi-item[data-expanded="true"] input'));
  assert.ok(await first.getByLabel('Design name').evaluate((el) => el === document.activeElement), 'focus moves from the closed dialog to the imported design');
  console.log('ok    50 frames listed and previewed, frames chosen and ordered, a frame that fails to export blocks nothing it should not');

  // 4. "Add the ones that worked" adds a second design.
  await openDialog();
  await find(link);
  await boxes.nth(49).waitFor();
  await dialog.getByRole('checkbox', { name: /04 Cart 4/ }).check();
  await dialog.getByRole('checkbox', { name: /03 Screen 3/ }).check();
  await dialog.getByRole('button', { name: 'Import 3 frames', exact: true }).click(); // the link's frame, the failing one and one more
  await failed.getByText('04 Cart 4').waitFor();
  await dialog.getByRole('button', { name: 'Add the 2 that worked', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('listitem', { name: 'Acme checkout' }).count(), 2);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Project saved.').waitFor();
  console.log('ok    the exported frames of a partly failed import can be added anyway');
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await app.close();
  if (passed) {
    const db = openProject(projectDir);
    const pois = db.getProject()!.pois;
    db.close();
    const designs = pois.filter((poi): poi is DesignPoi => poi.type === 'design');
    assert.equal(pois.length, 3);
    assert.deepEqual(designs.map((d) => [d.name, d.frames.map((f) => f.name)]), [
      ['Acme checkout', ['02 Screen 2', '01 Cart 1']],
      ['Acme checkout', ['02 Screen 2', '03 Screen 3']],
    ]);
    const assets = readdirSync(join(projectDir, 'assets'));
    for (const { asset } of designs.flatMap((d) => d.frames)) {
      assert.ok(assets.includes(asset) && /^[0-9a-f]{16}\.png$/.test(asset));
      assert.deepEqual([...readFileSync(join(projectDir, 'assets', asset)).subarray(1, 4)], [0x50, 0x4e, 0x47]);
    }
    // The token is in the user's encrypted store, in no project file and in no log.
    const files = (root: string): string[] => readdirSync(root, { recursive: true, encoding: 'utf8' }).map((f) => join(root, f)).filter((f) => statSync(f).isFile());
    assert.deepEqual(files(projectDir).filter((f) => readFileSync(f).includes(TOKEN)), []);
    assert.deepEqual(files(userData).filter((f) => readFileSync(f).includes(TOKEN)), [], 'not in plain text anywhere under the app data folder');
    assert.ok(existsSync(join(userData, 'figma.key')));
    console.log('ok    both designs are saved with their frames as PNG assets, and the token is nowhere in plain text');
    rmSync(dir, { recursive: true, force: true });
  } else console.error(`Figma smoke artifacts: ${dir}`);
}
