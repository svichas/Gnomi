// Real buyer setup -> shared public collection -> decision report. Local fictional sites and scripted models only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import type { EventPayloads, ProjectConfig, Report, RunConfig } from '@gnomi/simulation/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'gnomi-research-'));
const projectDir = join(dir, 'research.gnomi');
const shots = join(import.meta.dirname, 'test-results');
mkdirSync(shots, { recursive: true });
const tools = ['Harbor ATS', 'Orbit ATS', 'Cedar ATS', 'North ATS'];
let posts = 0;
const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') posts++;
  if (req.url === '/robots.txt') { res.end('User-agent: *\nAllow: /'); return; }
  const index = Number(req.url?.split('/').at(-1) ?? 0);
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><html lang="en"><head><title>${tools[index] ?? 'ATS'}</title></head><body><h1>${tools[index] ?? 'ATS'}</h1><p>A fictional public marketing site for hiring software.</p><h2>Plans</h2><p>The team plan supports 25 employees. Contact sales to confirm pricing, Slack integration and migration.</p><h2>Evaluation</h2><p>Request a demonstration after confirming your requirements.</p><form method="post"><label>Email<input name="email"></label><button>Book a demo</button></form></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const store = openProject(projectDir);
const people = Array.from({ length: 20 }, (_, index) => ({ ...BUILTIN_PERSONA, id: `p-${index + 1}`, name: `Saved persona ${index + 1}`, segment_id: 'buyers', profile_signature: 'old-company-brief', goal_interpretation: 'Create a job and review incoming candidates' }));
store.saveProject({
  name: 'ATS shortlist', description: 'Hiring software for our company', goal: 'Choose the best ATS for our company', role: null,
  audience: { seed: 7, persona_count: 20, company_size: [50, 500], languages: { en: 1 }, accessibility: { none: 1, low_vision: 0, colour_blind: 0, screen_reader: 0, motor: 0 },
    segments: [{ id: 'buyers', name: 'Hiring team', description: 'Our hiring stakeholders', share: 100, role: null, usage_frequency: 'weekly', typical_goals: ['Hire people'], mobile_share: 0.2, patience: [2, 4], tech_skill: [2, 4], account_state: 'populated', entry: 'direct', goal_override: null }] },
  pois: tools.map((name, index) => ({ id: `source-${index}`, type: 'web', name, start_url: `http://127.0.0.1:${port}/${index}`, allowed_hosts: [], production_domains: [], not_production: true, reset_hook_url: null, mode: 'full', segments: null })),
  settings: { ...structuredClone(DEFAULT_SETTINGS), social: true, concurrency: 4, cost_budget_usd: 250 },
});
store.replacePersonas(people, 20);
store.close();

const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron') as string,
  args: ['--use-mock-keychain', `--user-data-dir=${join(dir, 'user-data')}`, join(import.meta.dirname, 'out/main/index.js')],
  env: { ...process.env, GNOMI_FAKE_LLM: '1', GNOMI_PROJECT_DIR: projectDir },
});
const timeout = setTimeout(() => { console.error('Research smoke timed out.'); process.exit(1); }, 120_000);
timeout.unref();
let passed = false;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('Study goal', { exact: true }).selectOption('choose_tool');
  await page.getByRole('textbox', { name: 'Company size and seats', exact: true }).fill('25 employees, 2 recruiters');
  await page.getByLabel('Budget and billing constraints', { exact: true }).fill('Up to EUR 500 per month');
  await page.getByLabel('Required capabilities, one per line', { exact: true }).fill('Structured interview scorecards\nExport candidate data');
  await page.getByLabel('Required integrations, one per line', { exact: true }).fill('Slack');
  await page.getByLabel('Switching and migration constraints', { exact: true }).fill('Import 2,000 existing candidates from CSV');
  assert.equal(await page.getByLabel('How should evidence be collected?', { exact: true }).inputValue(), 'shared_research');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Project saved.', { exact: true }).waitFor();
  await page.reload();
  assert.equal(await page.getByLabel('Study goal', { exact: true }).inputValue(), 'choose_tool');
  assert.equal(await page.getByRole('textbox', { name: 'Company size and seats', exact: true }).inputValue(), '25 employees, 2 recruiters');
  await page.screenshot({ path: join(shots, 'research-setup.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review research & start', exact: true }).click();
  const review = page.locator('#panel-review');
  await review.getByRole('region', { name: 'Research environment', exact: true }).waitFor();
  assert.doesNotMatch(await review.innerText(), /Generate them before|persona count has changed|Build personas first/);
  await review.getByRole('button', { name: 'Start run', exact: true }).click();
  await page.getByRole('tab', { name: 'Report', exact: true }).click({ timeout: 60_000 });
  const report = page.locator('section[aria-labelledby="report-title"]');
  await report.getByRole('heading', { name: 'Decision and scope', exact: true }).waitFor();
  assert.match(await report.innerText(), /Insufficient evidence/);
  assert.match(await report.innerText(), /Source reviews/);
  assert.doesNotMatch(await report.innerText(), /20 simulated|What to fix first|At a glance/);
  assert.equal(await report.locator('details').filter({ has: page.locator('#comparison-evidence-title') }).getAttribute('open'), null, 'the audit trail is collapsed initially');
  for (const name of tools) assert.ok(await report.getByRole('columnheader', { name, exact: true }).isVisible());
  await page.screenshot({ path: join(shots, 'research-report.png'), fullPage: true });
  await page.setViewportSize({ width: 720, height: 900 });
  const matrix = report.getByRole('region', { name: /^Comparison matrix:/ });
  assert.ok(await matrix.evaluate((element) => element.scrollWidth > element.clientWidth), 'the narrow matrix scrolls without hiding tools');
  await page.screenshot({ path: join(shots, 'research-report-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await report.getByText('Coverage and limitations', { exact: true }).click();
  const causes = report.getByRole('region', { name: 'Recorded outcome causes', exact: true });
  await causes.waitFor();
  assert.match(await causes.innerText(), /Scripted demo run: no model was called/);
  assert.equal(await causes.getByRole('button', { name: 'Inspect task trace', exact: true }).count(), 4);
  await page.getByRole('tab', { name: 'Simulation', exact: true }).click();
  await page.getByRole('region', { name: 'Public evidence research', exact: true }).waitFor();
  assert.equal(await page.getByText('1 of 1 source reviews recorded', { exact: true }).count(), 4);
  assert.equal(await page.getByText('People in this run', { exact: true }).count(), 0);
  await page.screenshot({ path: join(shots, 'research-progress.png'), fullPage: true });

  const db = new DatabaseSync(join(projectDir, 'project.sqlite'), { readOnly: true });
  try {
    const saved = JSON.parse(String(db.prepare('SELECT config_json FROM project WHERE id = 1').get()!.config_json)) as ProjectConfig;
    assert.equal(saved.comparison!.execution.collection, 'shared_research');
    assert.ok(saved.pois.every((poi) => poi.type === 'web' && poi.mode === 'observe_only'));
    assert.equal(saved.comparison!.criteria.filter((criterion) => criterion.id.startsWith('requirement-')).length, 2);
    const row = db.prepare('SELECT id, status, snapshot_json FROM run ORDER BY rowid DESC LIMIT 1').get()!;
    assert.equal(row.status, 'finished');
    const frozen = JSON.parse(String(row.snapshot_json)) as RunConfig;
    assert.deepEqual(frozen.personas, people, 'research does not rewrite the saved audience');
    assert.deepEqual(frozen.project.comparison, saved.comparison);
    const reportPath = join(projectDir, 'runs', String(row.id), 'report.json');
    for (let attempt = 0; attempt < 100 && !existsSync(reportPath); attempt++) await delay(50);
    const result = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
    assert.equal(result.comparison!.coverage.length, 4);
    assert.ok(result.comparison!.coverage.every((coverage) => coverage.unit === 'source_review' && coverage.scheduled === 1 && coverage.attempted === 1));
    assert.equal(result.comparison!.pairs.length, 0, 'research never fabricates matched persona comparisons');
    assert.ok(result.comparison!.actions.length <= 3);
    assert.ok(result.comparison!.cells.every((cell) => cell.assessment === 'unknown'), 'scripted output cannot claim vendor suitability');
    const events = db.prepare('SELECT type, payload_json FROM event WHERE run_id = ?').all(row.id);
    assert.equal(events.filter((event) => event.type === 'comparison.episode_started').length, 4, '20 personas × 4 sources still produces only four shared reviews');
    assert.equal(events.filter((event) => event.type === 'social.post' || event.type === 'persona.survey').length, 0);
    const calls = events.filter((event) => event.type === 'llm.call').map((event) => JSON.parse(String(event.payload_json)) as EventPayloads['llm.call']);
    assert.equal(calls.filter((call) => call.role === 'judge').length, 8, 'one assessment + verification per source review');
    assert.ok(calls.every((call) => call.status === 'ok'));
    console.log(`ok    20 saved personas, 4 public sites, 4 shared reviews, 8 evidence judge calls, ${calls.length} total scripted calls; no paid models`);
  } finally { db.close(); }
  assert.equal(posts, 0, 'public research never submits vendor forms');
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  const page = await app.firstWindow();
  console.error('Research smoke state:', (await page.locator('body').innerText()).slice(-9000));
  await page.screenshot({ path: join(shots, 'research-failure.png'), fullPage: true });
  throw error;
} finally {
  clearTimeout(timeout);
  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Research fixture retained at ${dir}`);
}
