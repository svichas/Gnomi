// Run after the app build: node app/text.smoke.ts. A text point of interest added from Gym v3's pricing copy as a .md file, a segment
// marked as buyers in the audience editor, then a scripted run (GNOMI_FAKE_LLM=1, no key, no cost) whose report quotes the text
// and shows the buying survey.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import type { Segment } from '@gnomi/simulation/types.ts';
import { gymAssets } from '../demo/GymSite/assets.ts';

const dir = mkdtempSync(join(tmpdir(), 'gnomi-text-'));
const projectDir = join(dir, 'text.gnomi');
const shots = join(import.meta.dirname, 'test-results');
mkdirSync(shots, { recursive: true });
const pricing = gymAssets({ defects: 'D28' }).copy.pricing;

// Two segments of users, as every project before M5 has them; the smoke makes one of them buyers.
const segment = (id: string, name: string, share: number): Segment => ({
  id, name, description: '', share, role: null, usage_frequency: 'weekly', typical_goals: [], mobile_share: 0, patience: [3, 3], tech_skill: [3, 3],
  account_state: 'empty', entry: 'direct', goal_override: null,
});
const store = openProject(projectDir);
store.saveProject({
  name: 'Plotline', description: 'Project planning for teams', pois: [], goal: 'Choose a plan for a team of 20 that needs single sign-on', role: null, settings: DEFAULT_SETTINGS,
  audience: { seed: 3, persona_count: 3, segments: [segment('seg-1', 'Team leads', 60), segment('seg-2', 'Planners', 40)], company_size: [20, 500], languages: { en: 1 }, accessibility: { none: 1, low_vision: 0, colour_blind: 0, screen_reader: 0, motor: 0 } },
});
store.replacePersonas([
  { ...BUILTIN_PERSONA, id: 'p-1', name: 'Ada Lead', segment_id: 'seg-1' },
  { ...BUILTIN_PERSONA, id: 'p-2', name: 'Ben Lead', segment_id: 'seg-1' },
  { ...BUILTIN_PERSONA, id: 'p-3', name: 'Cy Planner', segment_id: 'seg-2' },
]);
store.close();

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as string,
  args: ['--use-mock-keychain', `--user-data-dir=${join(dir, 'user-data')}`, join(import.meta.dirname, 'out/main/index.js')],
  env: { ...process.env, GNOMI_FAKE_LLM: '1', GNOMI_PROJECT_DIR: projectDir },
});
setTimeout(() => { console.error('Text smoke timed out.'); process.exit(1); }, 180_000).unref();
let passed = false;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();

  // A text POI from a .md file: the editor formats it, the form keeps it as a Markdown asset and shows it formatted.
  const pois = page.getByRole('list', { name: 'Points of interest', exact: true });
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Web app 1', exact: true }).click(); // the blank web app a new project starts with
  const item = pois.locator(':scope > li').last(); // the editor's own list items are listitems too
  await item.getByLabel('Text name').fill('Pricing page');
  await item.getByLabel('Write or paste the text').fill('Draft copy');
  await item.getByLabel('Text file').setInputFiles(pricing); // a .md file opens formatted in the editor
  await item.getByLabel('Write or paste the text').getByRole('heading', { name: 'Plotline pricing', level: 1 }).waitFor();
  await item.getByRole('button', { name: 'Use this text', exact: true }).click();
  const preview = item.getByLabel('Text preview');
  await preview.getByRole('heading', { name: 'Plotline pricing', level: 1 }).waitFor();
  await preview.getByRole('listitem').filter({ hasText: 'Single sign-on (SAML SSO)' }).first().waitFor();
  await preview.getByRole('table').waitFor();
  assert.match(await preview.innerText(), /No\. Single sign-on \(SAML SSO\) is part of Business\./);
  assert.doesNotMatch(await preview.innerText(), /Draft copy/, 'the file replaces what was typed');
  await item.getByText(/^[\d.,\s]+ characters$/).waitFor();
  await page.screenshot({ path: join(shots, 'text-poi.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Project saved.', { exact: true }).or(page.getByRole('alert')).first().waitFor();
  assert.equal(await page.getByRole('alert').count(), 0, `saving failed: ${await page.getByRole('alert').allInnerTexts()}`);

  // Users vs Buyers in the audience editor, with its one-line explanation.
  await page.locator('#tab-audience').click();
  const panel = page.locator('#panel-audience');
  const kind = (name: string) => panel.getByRole('group', { name: `Kind of segment for ${name}`, exact: true });
  assert.equal(await kind('Team leads').getByRole('button', { name: 'Users', exact: true }).getAttribute('aria-pressed'), 'true', 'a segment without a kind is users');
  await kind('Team leads').getByRole('button', { name: 'Buyers', exact: true }).click();
  assert.equal(await kind('Team leads').getByRole('button', { name: 'Buyers', exact: true }).getAttribute('aria-pressed'), 'true');
  await kind('Team leads').getByText('Review text and designs to decide whether they would buy.').waitFor();
  await kind('Planners').getByText('Try the product and describe their experience.').waitFor();
  await page.screenshot({ path: join(shots, 'audience-kind.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Save audience', exact: true }).click();
  await panel.getByText('Not saved yet.').waitFor({ state: 'detached' });

  // A scripted run: buyers answer the buying survey, and every confusion quotes a passage of the text.
  await panel.locator('.action-bar').getByRole('button', { name: 'Review & start', exact: true }).click();
  const review = page.locator('#panel-review');
  await review.getByRole('region', { name: 'What they will try' }).waitFor();
  assert.match(await review.innerText(), /will try Pricing page/);
  await review.getByRole('button', { name: 'Start run', exact: true }).click();
  await page.getByRole('tab', { name: 'Report', exact: true }).click({ timeout: 120_000 });
  const report = page.locator('section[aria-labelledby=report-title]');
  await report.locator('summary').filter({ hasText: 'Buying intent' }).click();
  await report.getByRole('heading', { name: 'Buying survey', exact: true }).waitFor({ timeout: 120_000 });
  const buyers = report.locator('section[aria-labelledby=buyers-title]');
  assert.match(await buyers.innerText(), /Team leads\s+2\s/, 'both team leads answered as buyers');
  assert.doesNotMatch(await buyers.innerText(), /Planners/, 'users answer the usage survey');
  await report.locator('summary').filter({ hasText: 'Audience breakdown' }).click();
  assert.match(await report.getByRole('region', { name: 'Results by segment' }).innerText(), /Mood[\s\S]*Team leads[\s\S]*Planners/);
  await report.locator('summary').filter({ hasText: 'User journeys' }).click();
  const personas = report.getByRole('region', { name: /How each persona did/ });
  await personas.locator('details').evaluateAll((all) => all.forEach((details) => { (details as HTMLDetailsElement).open = true; }));
  assert.equal(await personas.getByText('In the text:').count(), 3);
  assert.match(await personas.innerText(), /In the text: “# Plotline pricing”/);
  await page.screenshot({ path: join(shots, 'text-report.png'), fullPage: true });

  const assets = join(projectDir, 'assets');
  assert.ok(existsSync(assets), 'the pasted text is in the project folder');
  assert.deepEqual(errors, []);
  passed = true;
  console.log('ok    a text POI added from a .md file, a buyer segment and a scripted run report the buying survey and quoted passages');
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
if (!passed) process.exit(1);
