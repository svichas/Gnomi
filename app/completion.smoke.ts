// A real Electron renderer with deterministic live completion events. No models or external sites.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { openProject } from '../engine/src/log/sqlite.ts';
import { BUILTIN_PERSONA } from '../engine/src/persona.ts';
import { buildReport } from '../engine/src/report/build.ts';
import { newRunConfig } from '../engine/src/run.ts';
import { DEFAULT_SETTINGS } from '../engine/src/settings.ts';
import type { ProjectInfo } from '../engine/src/protocol.ts';
import type { ProjectConfig } from '../engine/src/types.ts';

declare global {
  interface Window {
    completionSmoke: { abandon(): void; progress(count: number): void; finish(): void; save(): void; holdReports(): void; releaseReports(): void; reportRequests: number; reportResponses: number };
  }
}

const dir = mkdtempSync(join(tmpdir(), 'gnomi-completion-'));
const projectDir = join(dir, 'completion.gnomi');
const shots = join(import.meta.dirname, 'test-results');
mkdirSync(shots, { recursive: true });
const project: ProjectConfig = {
  name: 'All personas abandoned', description: 'Disposable run completion regression', goal: 'Complete an unavailable task', role: null, audience: null,
  pois: [{ id: 'fixture', type: 'web', mode: 'full', segments: null, name: 'Fixture', start_url: 'http://localhost:3001/', allowed_hosts: [], production_domains: [], not_production: true, reset_hook_url: null }],
  settings: { ...structuredClone(DEFAULT_SETTINGS), social: false },
};
const personas = ['Alex', 'Casey', 'Robin'].map((name, index) => ({ ...BUILTIN_PERSONA, id: `p-${index + 1}`, name }));
const store = openProject(projectDir);
store.saveProject(project);
store.replacePersonas(personas);
const config = store.createRun(newRunConfig(project, { personas, sessions: [], reset: false }));
const base = { run_id: config.run_id, round: 1, poi_id: null, persona_id: null };
store.append({ ...base, type: 'run.started', payload: { config } });
for (const persona of personas) {
  store.append({ ...base, persona_id: persona.id, type: 'persona.created', payload: { persona } });
  store.append({ ...base, persona_id: persona.id, type: 'persona.episode_started', payload: { poi_id: 'fixture', device: persona.device, start_url: 'http://localhost:3001/' } });
}
const initialEvents = store.events(config.run_id);
for (const persona of personas) {
  store.append({ ...base, persona_id: persona.id, type: 'persona.abandoned', payload: { step_no: 6, reason: 'The task cannot be completed.' } });
}
const abandonedEvents = store.events(config.run_id).slice(initialEvents.length);
// The report phase as the app sees it: two of three surveys, the judge and author starting, then the judge's themes.
for (const persona of personas.slice(0, 2)) {
  store.append({ ...base, persona_id: persona.id, type: 'persona.survey', payload: { poi_id: 'fixture', sentiment: -1, confidence: 0.6, likes: [], frictions: ['The task cannot be completed.'], would_continue: false, reason: 'Stuck.' } });
}
store.append({ ...base, type: 'report.started', payload: { pois: ['fixture'] } });
store.append({ ...base, poi_id: 'fixture', type: 'report.themes', payload: { poi_id: 'fixture', themes: [] } });
const reportEvents = store.events(config.run_id).slice(initialEvents.length + abandonedEvents.length);
store.append({ ...base, type: 'run.finished', payload: {} });
store.append({ ...base, type: 'report.generated', payload: { path: `runs/${config.run_id}/report.json`, friction_count: 0 } });
store.finishRun(config.run_id, 'finished', null, 0);
const allEvents = store.events(config.run_id);
const endEvents = allEvents.slice(initialEvents.length + abandonedEvents.length + reportEvents.length);
const info: ProjectInfo = { dir: projectDir, project, persona: personas[0], personas, diversity: null, runs: store.listRuns(), sessions: [], setup_calls: [] };
const report = buildReport(allEvents);
store.close();

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as string,
  args: ['--use-mock-keychain', `--user-data-dir=${join(dir, 'user-data')}`, join(import.meta.dirname, 'out/main/index.js')],
  env: { ...process.env, GNOMI_FAKE_LLM: '1', GNOMI_PROJECT_DIR: projectDir },
});
setTimeout(() => { console.error('Completion smoke timed out.'); process.exit(1); }, 60_000).unref();
let passed = false;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  await page.addInitScript(({ info, initialEvents, abandonedEvents, reportEvents, endEvents, report }) => {
    let port: MessagePort | undefined;
    const scenario = sessionStorage.getItem('completion-scenario');
    let ended = scenario === 'historical';
    let hold = scenario === 'race';
    const pending: (() => void)[] = [];
    const visible = ended ? [...initialEvents, ...abandonedEvents, ...reportEvents, ...endEvents] : [...initialEvents];
    const emit = (event: (typeof visible)[number]) => {
      visible.push(event);
      port?.dispatchEvent(new MessageEvent('message', { data: { kind: 'event', event } }));
    };
    window.completionSmoke = {
      reportRequests: 0,
      reportResponses: 0,
      abandon() { abandonedEvents.forEach(emit); },
      progress(count: number) { reportEvents.slice(visible.length - initialEvents.length - abandonedEvents.length, count).forEach(emit); },
      finish() { ended = true; endEvents.filter((event) => event.type === 'run.finished').forEach(emit); },
      save() { endEvents.filter((event) => event.type === 'report.generated').forEach(emit); },
      holdReports() { hold = true; },
      // Newer responses arrive first, exercising stale-result handling as well as view preservation.
      releaseReports() { hold = false; pending.splice(0).reverse().forEach((respond) => respond()); },
    };
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, options) {
      if (message?.kind !== 'request' || !['get_project', 'get_events', 'get_report'].includes(message.method)) {
        const transfer = Array.isArray(options) ? { transfer: options } : options;
        post.call(this, message, transfer);
        return;
      }
      port = this;
      let result: unknown;
      if (message.method === 'get_project') result = { ...info, runs: info.runs.map((row) => ({ ...row, status: ended ? 'finished' : 'running', ended_at: ended ? row.ended_at : null })) };
      else if (message.method === 'get_events') result = [...visible];
      else {
        window.completionSmoke.reportRequests++;
        result = { ...report, goal: visible.some((event) => event.type === 'report.generated') ? 'Saved completion report' : 'Initial completion report' };
      }
      const respond = () => {
        if (message.method === 'get_report') window.completionSmoke.reportResponses++;
        this.dispatchEvent(new MessageEvent('message', { data: { kind: 'response', id: message.id, ok: true, result } }));
      };
      if (message.method === 'get_report' && hold) pending.push(respond);
      else queueMicrotask(respond);
    };
  }, { info, initialEvents, abandonedEvents, reportEvents, endEvents, report });
  await page.reload();
  const status = page.getByRole('region', { name: 'Run status' });
  await status.getByRole('button', { name: 'Stop run', exact: true }).waitFor();
  const reportTab = page.getByRole('tab', { name: 'Report', exact: true });
  assert.equal(await reportTab.count(), 0, 'The report is absent while a simulation is running.');
  await page.getByRole('region', { name: 'Swarm graph' }).waitFor();
  assert.ok(await page.getByRole('progressbar', { name: 'Simulation progress', exact: true }).isVisible());
  const activity = page.getByRole('region', { name: 'Activity', exact: true });
  await activity.getByRole('button', { name: 'Pause updates', exact: true }).click();
  const pausedCount = await activity.locator('.count-label').innerText();
  await page.evaluate(() => window.completionSmoke.abandon());
  await activity.getByRole('button', { name: /^Show \d+ new updates?$/ }).waitFor();
  assert.equal(await activity.locator('.count-label').innerText(), pausedCount, 'Incoming events do not move a paused feed.');
  await activity.getByRole('button', { name: /^Show \d+ new updates?$/ }).click();
  assert.ok(Number(await activity.locator('.count-label').innerText()) > Number(pausedCount));
  const meter = page.getByRole('progressbar', { name: 'Simulation progress', exact: true });
  await page.waitForFunction(() => Number(document.querySelector('[aria-label="Simulation progress"]')?.getAttribute('aria-valuenow')) > 0);
  assert.equal(await reportTab.count(), 0);
  const completedExploration = Number(await meter.getAttribute('aria-valuenow'));
  assert.ok(completedExploration > 0 && completedExploration < 100);
  await page.evaluate(() => window.completionSmoke.progress(2));
  await page.evaluate(() => window.completionSmoke.progress(3));
  await status.getByText('Turning experiences into findings', { exact: true }).waitFor();
  const beforeThemes = Number(await meter.getAttribute('aria-valuenow'));
  assert.ok(beforeThemes >= completedExploration);
  await page.evaluate(() => window.completionSmoke.progress(4));
  await page.waitForFunction((before) => Number(document.querySelector('[aria-label="Simulation progress"]')?.getAttribute('aria-valuenow')) > before, beforeThemes);
  assert.ok(Number(await meter.getAttribute('aria-valuenow')) < 100);
  assert.equal(await reportTab.count(), 0, 'The report stays absent while its findings are being prepared.');
  await page.screenshot({ path: join(shots, 'simulation-running.png'), fullPage: true });
  for (const width of [1440, 1024, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `the simulation fits ${width}px`);
    await page.screenshot({ path: join(shots, `simulation-running-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  console.log('ok    graph visible by default, report absent during run, progress advances with events, responsive at 320–1440px');

  // Still live while the report is prepared: each way off the Activity step raises a centered pill instead.
  const pill = page.getByRole('status').locator('.pill').filter({ hasText: 'Stop the run to leave this page.' });
  for (const leave of [page.locator('#tab-project'), page.locator('#tab-settings'), page.getByRole('button', { name: 'New run', exact: true })]) {
    await leave.click();
    await pill.waitFor();
    assert.ok(await page.locator('#panel-run').isVisible(), 'the Activity step stays on screen');
  }
  assert.equal(await pill.count(), 1, 'a repeated notice restarts rather than stacks');
  const pillBox = async (width: number) => {
    await pill.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    const box = (await pill.boundingBox())!;
    width = await page.evaluate(() => document.documentElement.clientWidth);
    assert.ok(Math.abs(box.x + box.width / 2 - width / 2) <= 1, `the pill is centered at ${width}px`);
    assert.ok(box.x >= 16 && box.x + box.width <= width - 16, `the pill fits ${width}px`);
  };
  await pillBox(1280);
  await page.screenshot({ path: join(shots, 'run-leave-pill.png') });
  await pill.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await pill.waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.locator('#tab-review').click();
  await pill.waitFor();
  await pillBox(375);
  await page.screenshot({ path: join(shots, 'run-leave-pill-375.png') });
  await page.setViewportSize({ width: 320, height: 800 });
  await pillBox(320);
  await pill.waitFor({ state: 'detached', timeout: 7_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.ok(await page.locator('#panel-run').isVisible());
  console.log('ok    a live run keeps the Activity step: steps, Settings and New run raise a centered pill that leaves by hand or on its own');

  await page.evaluate(() => window.completionSmoke.finish());
  await status.getByRole('button', { name: 'Stop run', exact: true }).waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.completionSmoke.reportRequests > 0);
  await page.waitForFunction(() => document.querySelector('#run-tab-report')?.getAttribute('aria-selected') === 'true', undefined, { timeout: 3_000 });
  await page.locator('#run-panel-report').getByRole('heading', { name: 'Report', exact: true }).waitFor();
  assert.match(await page.locator('#run-panel-report').innerText(), /Gave up|abandoned/i);
  assert.equal(await meter.getAttribute('aria-valuenow'), '100');
  await page.screenshot({ path: join(shots, 'all-abandoned-report.png') });
  await page.locator('#tab-project').click();
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  await page.locator('#tab-settings').click();
  await page.locator('#panel-settings').waitFor();
  await page.locator('#tab-run').click();
  assert.equal(await pill.count(), 0, 'an ended run lets the user leave');
  console.log('ok    once the run ends the steps and Settings navigate again');
  await page.getByRole('tab', { name: 'Simulation', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'Simulation', exact: true }).getAttribute('aria-selected'), 'true', 'The timeline remains available after the report opens.');
  console.log('ok    live completion selects and displays the report without a manual Report click');

  await page.evaluate(() => { window.completionSmoke.holdReports(); window.completionSmoke.save(); });
  await page.waitForFunction(() => window.completionSmoke.reportRequests >= 2);
  await page.evaluate(() => window.completionSmoke.releaseReports());
  await page.waitForFunction(() => window.completionSmoke.reportResponses >= 2);
  assert.equal(await page.getByRole('tab', { name: 'Simulation', exact: true }).getAttribute('aria-selected'), 'true', 'The saved report response must preserve a deliberate Timeline selection.');
  await reportTab.click();
  await page.locator('#run-panel-report').getByText('Goal: Saved completion report', { exact: true }).waitFor();
  console.log('ok    report.generated refreshes the report without switching views again');

  await page.evaluate(() => sessionStorage.setItem('completion-scenario', 'race'));
  await page.reload();
  await status.getByRole('button', { name: 'Stop run', exact: true }).waitFor();
  await page.evaluate(() => { window.completionSmoke.abandon(); window.completionSmoke.finish(); });
  await page.waitForFunction(() => window.completionSmoke.reportRequests === 1);
  await page.getByRole('tab', { name: 'Simulation', exact: true }).click();
  await page.evaluate(() => window.completionSmoke.save());
  await page.waitForFunction(() => window.completionSmoke.reportRequests === 2);
  await page.evaluate(() => window.completionSmoke.releaseReports());
  await page.waitForFunction(() => window.completionSmoke.reportResponses === 2);
  assert.equal(await page.getByRole('tab', { name: 'Simulation', exact: true }).getAttribute('aria-selected'), 'true');
  await reportTab.click();
  await page.locator('#run-panel-report').getByText('Goal: Saved completion report', { exact: true }).waitFor();
  assert.equal(await page.locator('#run-panel-report').getByText('Goal: Initial completion report', { exact: true }).count(), 0);
  console.log('ok    late initial responses cannot replace the saved report or undo a manual view choice');

  await page.evaluate(() => sessionStorage.setItem('completion-scenario', 'historical'));
  await page.reload();
  await page.locator('#tab-run').click();
  await page.locator('#run-panel-report').getByRole('heading', { name: 'Report', exact: true }).waitFor();
  assert.equal(await reportTab.getAttribute('aria-selected'), 'true');
  console.log('ok    historical completed runs open directly on their report');
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  const page = await app.firstWindow();
  console.error('Completion state:', JSON.stringify(await page.evaluate(() => ({
    reportRequests: window.completionSmoke?.reportRequests,
    reportSelected: document.querySelector('#run-tab-report')?.getAttribute('aria-selected'),
    timelineSelected: document.querySelector('#run-tab-activity')?.getAttribute('aria-selected'),
    status: document.querySelector('.run-status')?.textContent,
  }))));
  await page.screenshot({ path: join(shots, 'completion-failure.png') });
  throw error;
} finally {
  await app.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Completion fixture retained at ${dir}`);
}
