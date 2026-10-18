// Real Electron rendering of a stopped-run fixture. No model calls or provider credentials.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { newRunConfig } from '@gnomi/simulation/run.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import type { ProjectConfig } from '@gnomi/simulation/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'gnomi-budget-smoke-'));
const projectDir = join(dir, 'budget.gnomi');
const shots = join(import.meta.dirname, 'test-results');
mkdirSync(shots, { recursive: true });
const project: ProjectConfig = {
  name: 'Budget stop fixture', description: 'Scripted cost-report verification',
  pois: [{ id: 'gym', type: 'web', mode: 'full', segments: null, name: 'Gym', start_url: 'http://localhost:3001/', allowed_hosts: [], production_domains: [], not_production: true, reset_hook_url: null }],
  goal: 'Post a job', role: null, audience: null,
  settings: { ...structuredClone(DEFAULT_SETTINGS), cost_budget_usd: 5 },
};
const store = openProject(projectDir);
store.saveProject(project);
const config = store.createRun(newRunConfig(project, { personas: [BUILTIN_PERSONA], sessions: [], reset: false }));
const base = { run_id: config.run_id, persona_id: null, poi_id: null, round: 1 };
store.append({ ...base, type: 'run.started', payload: { config } });
store.append({ ...base, persona_id: BUILTIN_PERSONA.id, type: 'persona.created', payload: { persona: BUILTIN_PERSONA } });
for (const [cost, usageReported] of [[5.25, true], [0, false]] as const) {
  store.append({
    ...base, persona_id: BUILTIN_PERSONA.id, type: 'llm.call',
    payload: {
      role: 'navigator', provider: 'scripted', model: 'budget-smoke', input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: cost, latency_ms: 1,
      usage_reported: usageReported, status: usageReported ? 'ok' : 'error', error: usageReported ? null : 'Canceled without returned usage',
    },
  });
}
store.append({ ...base, type: 'run.stopped', payload: { reason: 'cost_budget', detail: 'the $5 recorded cost cap was reached' } });
store.finishRun(config.run_id, 'stopped', 'cost_budget: the $5 recorded cost cap was reached', 5.25);
store.close();

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as string,
  args: ['--use-mock-keychain', `--user-data-dir=${join(dir, 'user-data')}`, join(import.meta.dirname, 'out/main/index.js')],
  env: { ...process.env, GNOMI_FAKE_LLM: '1', GNOMI_PROJECT_DIR: projectDir },
});
setTimeout(() => { console.error('Budget smoke timed out.'); process.exit(1); }, 120_000).unref();
let passed = false;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByText('Starting Gnomi...').waitFor({ state: 'detached' });
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Past runs', exact: true }).click();
  await page.getByRole('region', { name: 'Project run history', exact: true }).getByRole('button', { name: /r-0001/ }).click();
  await page.getByRole('tab', { name: 'Report', exact: true }).click();
  const report = page.locator('section[aria-labelledby=report-title]');
  await report.getByRole('heading', { name: 'Report', exact: true }).waitFor();
  const status = page.getByRole('region', { name: 'Run status' });
  assert.match(await status.innerText(), /\$5\.25 recorded · \$5\.00 limit/);
  assert.match(await status.innerText(), /\$5\.25/);
  assert.match(await report.innerText(), /Recorded cost/);
  assert.match(await report.innerText(), /\$5\.25/);
  assert.match(await report.innerText(), /Actual charges may exceed the recorded cost/);
  assert.match(await report.innerText(), /1 (?:model )?(?:call|request|attempt)/i);
  assert.equal(await page.getByRole('button', { name: 'Stop run', exact: true }).count(), 0);
  await page.screenshot({ path: join(shots, 'budget-stopped-report.png'), fullPage: true });
  await page.setViewportSize({ width: 720, height: 800 });
  await report.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: join(shots, 'budget-stopped-report-narrow.png') });
  assert.deepEqual(errors, []);
  console.log('ok    stopped-run cost, uncertain charges and 720px report render in Electron');
  passed = true;
} catch (error) {
  await (await app.firstWindow()).screenshot({ path: join(shots, 'budget-failure.png') });
  throw error;
} finally {
  await app.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Budget smoke fixture retained at ${dir}`);
}
