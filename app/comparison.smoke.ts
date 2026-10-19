// Real Electron setup -> persistence -> runtime -> comparison report. Disposable text assets and scripted models only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import type { EventPayloads, ProjectConfig, Report, RunConfig } from '@gnomi/simulation/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'gnomi-comparison-'));
const projectDir = join(dir, 'comparison.gnomi');
const shots = join(import.meta.dirname, 'test-results');
mkdirSync(shots, { recursive: true });
const store = openProject(projectDir);
store.saveProject({
  name: 'Fictional hiring tools', description: 'A local comparison smoke fixture', pois: [], role: null, audience: null,
  goal: 'Compare the applicable cost and evaluation requirements for a 25-person company.',
  settings: { ...structuredClone(DEFAULT_SETTINGS), social: false, concurrency: 1 },
});
store.close();

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as string,
  args: ['--use-mock-keychain', `--user-data-dir=${join(dir, 'user-data')}`, join(import.meta.dirname, 'out/main/index.js')],
  env: { ...process.env, GNOMI_FAKE_LLM: '1', GNOMI_PROJECT_DIR: projectDir },
});
const timeout = setTimeout(() => { console.error('Comparison smoke timed out.'); process.exit(1); }, 120_000);
timeout.unref();
let passed = false;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  const compare = page.getByRole('checkbox', { name: 'Evaluate tools against shared tasks and requirements', exact: true });
  assert.equal(await compare.isChecked(), false, 'a comparison is explicitly enabled, never inferred from the goal');

  const materials = [
    ['Harbor ATS', '# Harbor ATS\nThe Team plan is $300 per month for companies with up to 50 employees. Contact the evaluation team for integration details.'],
    ['Orbit ATS', '# Orbit ATS\nPricing for companies with 25 employees requires a quote. A guided evaluation is available after confirming requirements.'],
  ] as const;
  const pois = page.getByRole('list', { name: 'Points of interest', exact: true });
  for (const [name, text] of materials) {
    await page.getByRole('button', { name: 'Add text', exact: true }).click();
    const item = pois.getByRole('listitem').last();
    await item.getByLabel('Text name', { exact: true }).fill(name);
    await item.getByLabel('Paste the text', { exact: true }).fill(text);
    await item.getByRole('button', { name: 'Use this text', exact: true }).click();
    await item.getByLabel('Text preview', { exact: true }).waitFor();
    assert.ok((await item.getByLabel('Text preview', { exact: true }).innerText()).includes(name));
  }
  await page.getByRole('button', { name: 'Remove Web app 1', exact: true }).click();
  await compare.focus();
  await page.keyboard.press('Space');
  await page.getByRole('heading', { name: 'The comparison you will run', exact: true }).waitFor();
  const purpose = page.getByLabel('What is this comparison for?', { exact: true });
  await purpose.selectOption('improve_own_product');
  await page.getByLabel('Your product', { exact: true }).selectOption({ label: materials[0][0] });
  assert.notEqual(await page.getByLabel('Your product', { exact: true }).inputValue(), '');
  await purpose.selectOption('choose_tool');
  assert.equal(await page.getByLabel('Your product', { exact: true }).count(), 0, 'buyer mode does not retain an owner selection');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Project saved.', { exact: true }).waitFor();

  // Reload from the actual saved project, rather than an injected renderer state.
  await page.reload();
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  assert.equal(await compare.isChecked(), true, 'the saved brief survives a renderer reload');
  assert.equal(await purpose.inputValue(), 'choose_tool');
  assert.equal(await page.getByLabel('Tool name', { exact: true }).count(), 2);
  await page.screenshot({ path: join(shots, 'comparison-setup.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review & start', exact: true }).click();
  const review = page.locator('#panel-review');
  await review.getByRole('region', { name: 'Comparison brief', exact: true }).waitFor();
  assert.match(await review.innerText(), /Choose a tool/);
  assert.match(await review.innerText(), /Off: comparison tasks/);
  await review.getByRole('button', { name: 'Start run', exact: true }).click();
  await page.getByRole('tab', { name: 'Report', exact: true }).click({ timeout: 60_000 });
  const report = page.locator('section[aria-labelledby="report-title"]');
  for (const name of ['Decision and scope', 'Side-by-side comparison', 'Coverage and limitations']) {
    await report.getByRole('heading', { name, exact: true }).waitFor({ timeout: 60_000 });
  }
  const reportText = await report.innerText();
  assert.match(reportText, /Insufficient evidence/);
  assert.match(reportText, /Scripted demo: no model assessed the comparison evidence/);
  assert.doesNotMatch(reportText, /At a glance|What to fix first|Legacy comparison:/);
  for (const [name] of materials) assert.ok(await report.getByRole('columnheader', { name, exact: true }).isVisible());
  await page.screenshot({ path: join(shots, 'comparison-report.png'), fullPage: true });
  const contents = report.getByRole('navigation', { name: 'Report contents', exact: true });
  await contents.getByRole('link', { name: 'Evidence', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.notEqual(await report.locator('details').filter({ has: page.locator('#comparison-evidence-title') }).getAttribute('open'), null, 'report navigation opens folded evidence');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'comparison-evidence-title', 'keyboard navigation moves focus to its destination');
  await contents.getByRole('link', { name: 'Methods', exact: true }).click();
  assert.notEqual(await report.locator('details').filter({ has: page.locator('#methods-title') }).getAttribute('open'), null, 'methods are reachable directly from the contents');
  await contents.getByRole('link', { name: 'Decision', exact: true }).click();

  // Read-only database inspection does not mark a live project/run interrupted, unlike opening another ProjectStore.
  const db = new DatabaseSync(join(projectDir, 'project.sqlite'), { readOnly: true });
  try {
    const saved = JSON.parse(String(db.prepare('SELECT config_json FROM project WHERE id = 1').get()!.config_json)) as ProjectConfig;
    assert.equal(saved.comparison?.purpose, 'choose_tool');
    assert.equal(saved.comparison.focal_target_id, null);
    assert.equal(saved.comparison.targets.length, 2);
    assert.ok(saved.pois.every((poi) => poi.type === 'text' && existsSync(join(projectDir, 'assets', poi.asset))));
    const run = db.prepare('SELECT id, status, snapshot_json FROM run ORDER BY rowid DESC LIMIT 1').get()!;
    assert.equal(run.status, 'finished');
    const frozen = JSON.parse(String(run.snapshot_json)) as RunConfig;
    assert.deepEqual(frozen.project.comparison, saved.comparison, 'the runtime uses the saved brief');
    const reportPath = join(projectDir, 'runs', String(run.id), 'report.json');
    for (let attempt = 0; attempt < 100 && !existsSync(reportPath); attempt++) await delay(50);
    const data = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
    assert.ok(data.comparison, 'the generated report.json has the new comparison projection');
    assert.equal(data.comparison.version, 1);
    assert.equal(data.comparison.decision.status, 'insufficient_evidence');
    assert.deepEqual(data.comparison.decision.shortlist, []);
    assert.equal(data.comparison.cells.length, saved.comparison.criteria.length * 2);
    assert.ok(data.comparison.cells.every((cell) => cell.assessment === 'unknown'), 'scripted demo output cannot masquerade as vendor evidence');
    assert.equal(data.comparison.coverage.length, 2);
    assert.ok(data.comparison.coverage.every((coverage) => coverage.scheduled === 1 && coverage.attempted === 1));
    assert.equal(data.comparison.rejected_assessments.length, 0, 'valid unknown demo assessments do not trigger schema/relevance failures');
    const sources = db.prepare("SELECT COUNT(*) AS count FROM event WHERE run_id = ? AND type = 'comparison.source'").get(run.id)!;
    assert.equal(sources.count, 2, 'each imported material contributes a recorded source');
    const calls = db.prepare("SELECT payload_json FROM event WHERE run_id = ? AND type = 'llm.call'").all(run.id)
      .map((row) => JSON.parse(String(row.payload_json)) as EventPayloads['llm.call']);
    assert.ok(calls.length > 0 && calls.every((call) => call.status === 'ok'), 'every scripted call follows its runtime contract');
    assert.equal(calls.filter((call) => call.role === 'judge').length, 4, 'one assessment and one verification per target, without invalid-output retries');
  } finally { db.close(); }
  assert.deepEqual(errors, []);
  passed = true;
  console.log('ok    two pasted materials, explicit comparison setup, owner/buyer switch, reload, review, real runtime and decision-first report.json; no live models or external sites');
} catch (error) {
  const page = await app.firstWindow();
  console.error('Comparison smoke state:', (await page.locator('body').innerText()).slice(-6000));
  await page.screenshot({ path: join(shots, 'comparison-failure.png'), fullPage: true });
  throw error;
} finally {
  clearTimeout(timeout);
  await app.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Comparison fixture retained at ${dir}`);
}
