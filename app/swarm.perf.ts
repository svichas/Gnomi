// Frame rate of the swarm graph (roadmap M4: above 30 fps with 200 personas, 10 POIs and 5,000 edges while a run is live).
// A synthetic run's first two rounds are written to a project log; the app opens it, then the rest streams in as live events
// while the canvas is panned and zoomed. No model calls. `npm run build -w @gnomi/app && node app/swarm.perf.ts`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { buildGraph } from '../engine/src/graph/index.ts';
import { syntheticRun } from '../engine/src/graph/synthetic.ts';
import { openProject } from '../engine/src/log/sqlite.ts';
import type { GnomiEvent } from '../engine/src/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'gnomi-swarm-perf-'));
const projectDir = join(dir, 'swarm.gnomi');
const shots = join(import.meta.dirname, 'test-results');
mkdirSync(shots, { recursive: true });

const { config: synthetic, events } = syntheticRun();
const store = openProject(projectDir);
store.saveProject(synthetic.project);
const { run_id, ...snapshot } = synthetic;
const config = store.createRun(snapshot);
const logged = events.map((event) => ({ ...event, run_id: config.run_id, ...(event.type === 'run.started' && { payload: { config } }) }) as GnomiEvent);
const preloaded = logged.filter((event) => event.round <= 2);
for (const { seq, ts, ...event } of preloaded) store.append(event);
store.close(); // left 'running': the app marks it interrupted on open, but with no end event it still reads as live
const live = logged.slice(preloaded.length);

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as string,
  args: ['--use-mock-keychain', `--user-data-dir=${join(dir, 'user-data')}`, join(import.meta.dirname, 'out/main/index.js')],
  env: { ...process.env, GNOMI_FAKE_LLM: '1', GNOMI_PROJECT_DIR: projectDir },
});
setTimeout(() => { console.error('Swarm perf timed out.'); process.exit(1); }, 180_000).unref();
let passed = false;
const page = await app.firstWindow();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
try {
  page.setDefaultTimeout(30_000);
  // An occluded or unfocused window may throttle its frames; the measurement is of rendering, not of the desktop.
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1280, 900); });
  await page.getByText('Starting Gnomi...').waitFor({ state: 'detached' });
  await page.locator('#tab-run').click();
  await page.getByLabel('Run history', { exact: true }).selectOption('r-0001');
  await page.getByRole('tab', { name: 'Connections' }).click();
  const graph = page.getByRole('region', { name: 'Swarm graph' });
  await graph.getByText(/^200 personas, 10 points of interest/).waitFor();
  await graph.locator('.sigma-container').scrollIntoViewIfNeeded();

  // Stand in for the engine's port and stream the remaining rounds as the engine would: frames of 100 events every 100 ms.
  await page.evaluate((events) => {
    const { port1, port2 } = new MessageChannel();
    window.postMessage({ gnomi: 'port', startupError: null, sessionsPersist: true }, '*', [port2]);
    let at = 0;
    const timer = setInterval(() => {
      for (const event of events.slice(at, at + 100)) port1.postMessage({ kind: 'event', event });
      at += 100;
      if (at >= events.length) {
        clearInterval(timer);
        Object.assign(window, { swarmStreamed: true });
      }
    }, 100);
    const frames: number[] = [];
    const renders: number[] = [];
    const tick = (t: number) => { frames.push(t); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    // The renderer's own frames too, so an idle canvas cannot pass for a fast one.
    const container = document.querySelector('.sigma-container') as HTMLElement & { sigma: { on(event: string, listener: () => void): void } };
    container.sigma.on('afterRender', () => renders.push(performance.now()));
    Object.assign(window, { swarmFrames: frames, swarmRenders: renders });
  }, live);

  const canvas = await graph.locator('.sigma-container').boundingBox();
  assert.ok(canvas, 'no canvas');
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  const started = await page.evaluate(() => performance.now());
  for (let i = 0; i < 6 || !(await page.evaluate(() => 'swarmStreamed' in window)); i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let s = 0; s <= 30; s++) await page.mouse.move(cx + Math.cos(s / 5) * 150, cy + Math.sin(s / 5) * 80);
    await page.mouse.up();
    for (let w = 0; w < 10; w++) await page.mouse.wheel(0, i % 2 ? 60 : -60);
  }
  const result = await page.evaluate((from) => {
    const { swarmFrames, swarmRenders } = window as unknown as { swarmFrames: number[]; swarmRenders: number[] };
    const frames = swarmFrames.filter((t) => t >= from);
    const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
    const seconds = (frames.at(-1)! - frames[0]) / 1000;
    const renders = swarmRenders.filter((t) => t >= from && t <= frames.at(-1)!).length;
    return { fps: (frames.length - 1) / seconds, renders: renders / seconds, seconds, p95_ms: gaps[Math.floor(gaps.length * 0.95)], worst_ms: gaps.at(-1)! };
  }, started);
  // Once the stream is in, the live-patched graph must match a rebuild from the whole log.
  const summary = `200 personas, 10 points of interest, ${buildGraph(events).edges.size} connections`;
  await graph.getByText(summary).waitFor();
  console.log(`swarm frame rate: ${result.fps.toFixed(1)} fps (${result.renders.toFixed(1)} graph renders/s) over ${result.seconds.toFixed(1)} s of panning and zooming with ${live.length} live events; p95 frame ${result.p95_ms.toFixed(1)} ms, worst ${result.worst_ms.toFixed(1)} ms; ${summary}`);
  await page.waitForTimeout(4500); // let the layout settle for the screenshots
  await graph.getByRole('button', { name: 'Fit the whole graph' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, 'swarm-200.png') });
  await page.getByRole('region', { name: 'Feed' }).screenshot({ path: join(shots, 'swarm-feed.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 900));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, 'swarm-200-720.png'), fullPage: true });
  assert.deepEqual(errors, []);
  assert.ok(result.fps > 30 && result.renders > 30, `${result.fps.toFixed(1)} fps, ${result.renders.toFixed(1)} renders/s: below the 30 fps target`);
  passed = true;
} finally {
  if (!passed) {
    console.log(errors.join('\n'));
    await page.screenshot({ path: join(shots, 'swarm-failure.png') }).catch(() => {});
  }
  await app.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.log(`The project folder is kept in ${dir}`);
}
process.exitCode = passed ? 0 : 1;
