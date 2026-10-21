// Setup shared by the Electron smoke and perf scripts (app/*.smoke.ts, smoke.ts, swarm.perf.ts). Run them after the app build.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type Page } from 'playwright-core';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import type { GnomiEvent, ProjectConfig, RunConfig } from '@gnomi/simulation/types.ts';

/** Screenshots land in app/test-results/. */
export const shots = join(import.meta.dirname, 'test-results');
mkdirSync(shots, { recursive: true });

/** A new disposable folder under the OS temp dir, named gnomi-<name>-XXXXXX. */
export const scratch = (name: string) => mkdtempSync(join(tmpdir(), `gnomi-${name}-`));

/** Launches the built app with scripted models; `env` is merged over this process's environment, and `undefined` removes a variable. */
export function launchApp(userData: string, env: Record<string, string | undefined> = {}) {
  const vars = Object.entries({ ...process.env, GNOMI_FAKE_LLM: '1', ...env }).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return electron.launch({
    executablePath: createRequire(import.meta.url)('electron') as string,
    // The mock keychain keeps macOS from asking for Keychain access while the key storage is exercised.
    args: ['--use-mock-keychain', `--user-data-dir=${userData}`, join(import.meta.dirname, 'out/main/index.js')],
    env: Object.fromEntries(vars),
  });
}

/** Exits with `message` if the script is still running after `ms`. Returns the timer, so a script can clear it. */
export const deadline = (message: string, ms: number) => setTimeout(() => { console.error(message); process.exit(1); }, ms).unref();

/** Records the page's uncaught errors, and its console errors with `console: true`, in `errors` (a new list by default). */
export function collectErrors(page: Page, { console: withConsole = false, errors = [] as string[] } = {}) {
  page.on('pageerror', (error) => errors.push(error.message));
  if (withConsole) page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

/** Saves `project` in the project folder `dir`. */
export function seedProject(dir: string, project: ProjectConfig) {
  const store = openProject(dir);
  store.saveProject(project);
  store.close();
}

/** Saves a synthetic run's project and logs the run as finished in the project folder `dir`; returns the run's config. */
export function seedFinishedRun(dir: string, synthetic: RunConfig, events: GnomiEvent[]) {
  const store = openProject(dir);
  store.saveProject(synthetic.project);
  const { run_id: _, ...snapshot } = synthetic;
  const config = store.createRun(snapshot);
  for (const { seq, ts, ...event } of events) store.append({ ...event, run_id: config.run_id, ...(event.type === 'run.started' && { payload: { config } }) } as typeof event);
  store.append({ run_id: config.run_id, persona_id: null, poi_id: null, round: events.at(-1)!.round, type: 'run.finished', payload: {} });
  store.finishRun(config.run_id, 'finished', null, 0);
  store.close();
  return config;
}

/** Asserts the page does not scroll sideways at its current width. */
export async function assertFits(page: Page, message?: string) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, message);
}
