// Provider routing and model controls in real Electron. Disposable keys and scripted AI answers only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type Page } from 'playwright-core';
import { syntheticRun } from '@gnomi/simulation/graph/synthetic.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { PROVIDER_DEFAULTS } from '@gnomi/simulation/settings.ts';

const dir = mkdtempSync(join(tmpdir(), 'gnomi-providers-'));
const projectDir = join(dir, 'project.gnomi');
const shots = join(import.meta.dirname, 'test-results');
mkdirSync(shots, { recursive: true });
const project = syntheticRun({ personas: 3, pois: 1, rounds: 1, seed: 4 }).config.project;
project.audience = null;
const store = openProject(projectDir);
store.saveProject(project);
store.close();
const launch = () => electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as string,
  args: ['--use-mock-keychain', `--user-data-dir=${join(dir, 'user-data')}`, join(import.meta.dirname, 'out/main/index.js')],
  env: { ...process.env, GNOMI_FAKE_LLM: '1', GNOMI_PROJECT_DIR: projectDir },
});
const savedRouting = () => {
  const db = openProject(projectDir);
  try { return db.getProject()!.settings!.routing; } finally { db.close(); }
};
async function addProvider(page: Page, provider: string) {
  await page.getByLabel('Provider', { exact: true }).selectOption(provider);
  await page.getByLabel('API key', { exact: true }).fill(`sk-smoke-${provider}-0123456789abcd`);
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByLabel('API key', { exact: true }).waitFor();
}
async function allRoutes(page: Page, provider: string) {
  await page.waitForFunction((provider) => {
    const selects = [...document.querySelectorAll<HTMLSelectElement>('#panel-settings select[aria-label$=" provider"]')];
    return selects.length === 5 && selects.every((select) => select.value === provider);
  }, provider);
}
let app = await launch();
setTimeout(() => { console.error('Provider smoke timed out.'); process.exit(1); }, 120_000).unref();
let passed = false;
try {
  let page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const watchErrors = (page: Page) => page.on('pageerror', (error) => errors.push(error.message));
  watchErrors(page);
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Model choices' }).click();
  await addProvider(page, 'deepseek');
  await allRoutes(page, 'deepseek');
  assert.equal(await page.getByLabel('Persona writer model', { exact: true }).inputValue(), PROVIDER_DEFAULTS.deepseek.persona_writer.model);
  assert.equal(await page.getByText('The selected AI provider is not connected.', { exact: false }).count(), 0);
  console.log('ok    adding only DeepSeek assigns all five tasks, including the persona writer');

  const navigatorModel = page.getByRole('combobox', { name: 'Navigator model', exact: true });
  await navigatorModel.selectOption('deepseek-v4-pro');
  await navigatorModel.selectOption('__custom__');
  await page.getByLabel('Navigator custom model', { exact: true }).fill('deepseek-custom');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved with the project.').waitFor();
  assert.equal(savedRouting().navigator.model, 'deepseek-custom');
  await navigatorModel.selectOption('deepseek-v4-pro');
  await page.locator('#tab-audience').click();
  await page.getByRole('button', { name: 'Suggest an audience', exact: true }).click();
  await page.getByRole('button', { name: 'Propose segments again', exact: true }).waitFor();
  assert.equal(savedRouting().persona_writer.provider, 'deepseek');
  assert.equal(savedRouting().navigator.model, 'deepseek-v4-pro');
  console.log('ok    preset/custom model choices save, and audience suggestion saves the DeepSeek route');

  await app.close();
  // Reproduce a project saved before this fix, with a DeepSeek key already present and stale Anthropic routes.
  const legacy = openProject(projectDir);
  const old = legacy.getProject()!;
  legacy.saveProject({ ...old, audience: null, settings: { ...old.settings!, routing: PROVIDER_DEFAULTS.anthropic } });
  legacy.close();
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  watchErrors(page);
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  await page.locator('#tab-audience').click();
  await page.getByRole('button', { name: 'Suggest an audience', exact: true }).click();
  await page.getByRole('button', { name: 'Propose segments again', exact: true }).waitFor();
  assert.deepEqual(savedRouting(), PROVIDER_DEFAULTS.deepseek);
  console.log('ok    reopening an old project repairs its routes before suggesting an audience');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const accordion = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Model choices' }) });
  assert.equal(await accordion.getAttribute('open'), null, 'model choices start collapsed');
  await accordion.locator('summary').click();
  await addProvider(page, 'openai');
  await page.getByRole('button', { name: 'Remove OpenAI', exact: true }).waitFor();
  await allRoutes(page, 'deepseek');
  await page.getByLabel('Persona writer provider', { exact: true }).selectOption('openai');
  await page.getByLabel('Persona writer model', { exact: true }).selectOption('gpt-6-luna');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved with the project.').waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Model choices' }).click();
  assert.equal(await page.getByLabel('Persona writer provider', { exact: true }).inputValue(), 'openai');
  assert.equal(await page.getByLabel('Persona writer model', { exact: true }).inputValue(), 'gpt-6-luna');
  assert.equal(await page.getByLabel('Navigator provider', { exact: true }).inputValue(), 'deepseek');
  for (const width of [1100, 720, 320]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `settings overflow at ${width}`);
    await page.screenshot({ path: join(shots, `provider-models-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Remove OpenAI', exact: true }).click();
  await allRoutes(page, 'deepseek');
  await page.getByRole('button', { name: 'Remove DeepSeek', exact: true }).click();
  await page.getByText('The selected AI provider is not connected.', { exact: false }).first().waitFor();
  console.log('ok    manual choices persist, removing a provider repairs affected tasks, and missing-provider guidance is generic');
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await app.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Provider smoke artifacts: ${dir}`);
}
