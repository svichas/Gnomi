// tech.md §14 item 4, the scripted-model end-to-end: the real Gym, browser, event log and blob store; only the
// model is scripted, walking the Gym by accessible names. Needs an installed Chrome (or Edge).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startGym } from '../../gym/server.ts';
import { launchBrowserPool } from './browser/pool.ts';
import { createScriptedGateway, findRef, type Script } from './llm/scripted.ts';
import { createFsBlobStore } from './log/blobs.ts';
import { openProject } from './log/sqlite.ts';
import { buildReport } from './report/build.ts';
import { createRecorder, newRunConfig, startRun } from './run.ts';
import type { LlmRequest } from './seams.ts';
import type { EventOf, GnomiEvent, ProjectConfig } from './types.ts';

// The M0 no-credentials harness: strings a login would use must never reach a model transcript (roadmap M0).
const CANARIES = ['gnomi-canary-password-7Q2x', 'canary.recruiter@gym.test', 'sk-ant-canary-00000000'];

const ref = (req: LlmRequest<unknown>, role: string, name: string) => {
  const found = findRef(req, role, name);
  if (!found) throw new Error(`No ${role} "${name}" in the snapshot`);
  return found;
};
const say = (thought: string, action: { type: string; ref?: string; text?: string }, friction: object | null = null) => ({
  thought,
  feeling: friction ? -1 : 0,
  action: { ref: null, text: null, ...action },
  friction,
});

const WALK: Script = [
  (req) => say('Jobs is right there in the menu.', { type: 'click', ref: ref(req, 'link', 'Jobs') }),
  say('Page not found, from the main menu? Back I go.', { type: 'back' }, { severity: 3, what: 'The Jobs link in the main menu opens "Page not found"', expected: 'The list of jobs' }),
  (req) => say('This one should get me there.', { type: 'click', ref: ref(req, 'link', 'View all jobs') }),
  (req) => say('Create job.', { type: 'click', ref: ref(req, 'link', 'Create job') }),
  (req) => say('Title first.', { type: 'type', ref: ref(req, 'textbox', 'Job title *'), text: 'Backend Engineer' }),
  (req) => say('Remote, like the others.', { type: 'type', ref: ref(req, 'textbox', 'Location'), text: 'Remote (EU)' }),
  (req) => say('Full-time.', { type: 'select', ref: ref(req, 'combobox', 'Employment type'), text: 'Full-time' }),
  (req) => say('One line will do.', { type: 'type', ref: ref(req, 'textbox', 'Description'), text: 'Build the APIs behind our hiring pipeline.' }),
  (req) =>
    say('Save draft? I want it live, but it is the only button.', { type: 'click', ref: ref(req, 'button', 'Save draft') }, {
      severity: 2,
      what: 'The only button on the job form says "Save draft"',
      expected: 'A button that publishes the job',
    }),
  (req) =>
    say('Nothing happened and no error. Department, maybe?', { type: 'select', ref: ref(req, 'combobox', 'Department'), text: 'Engineering' }, {
      severity: 4,
      what: 'Saving the job did nothing and showed no error',
      expected: 'The job saved, or a message saying what is missing',
    }),
  (req) => say('Again.', { type: 'click', ref: ref(req, 'button', 'Save draft') }),
  say('It says published, though I clicked Save draft.', { type: 'done', text: 'Published the Backend Engineer job' }),
];

const of = <K extends GnomiEvent['type']>(events: GnomiEvent[], type: K) => events.filter((e): e is EventOf<K> => e.type === type);

test('a scripted persona walks the Gym: frictions with screenshots, a report from the log alone, no canaries', async (t) => {
  // Each resource is released even when a later one fails to start, or the open server keeps the process alive.
  const gym = await startGym({ port: 0, defects: 'all' });
  t.after(() => gym.close());
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const browsers = await launchBrowserPool();
  t.after(() => browsers.close());

  const project: ProjectConfig = {
    name: 'Gym ATS',
    description: 'A demo applicant tracking system.',
    poi: { id: 'poi-1', type: 'web', name: 'Gym ATS', start_url: `${gym.url}/` },
    goal: 'Post a job for a backend engineer',
  };
  const store = openProject(dir);
  store.saveProject(project);
  const record = createRecorder(store, () => {});
  const config = store.createRun(newRunConfig(project));
  const report = await startRun(config, { store, blobs: createFsBlobStore(dir), browsers, llm: createScriptedGateway(WALK, record), record }).done;

  const events = store.events(config.run_id);
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
  );
  assert.equal(report.stop_reason, null);
  assert.deepEqual([report.status, report.outcome, report.steps], ['finished', 'done', WALK.length]);
  const steps = of(events, 'persona.step');
  assert.equal(steps[0].payload.result.url_after, `${gym.url}/job`, 'D03: the nav Jobs link is dead');
  assert.match(steps.at(-2)?.payload.result.url_after ?? '', /\/jobs\/\d+\?published=1$/);

  assert.equal(report.frictions.length, 3);
  assert.equal(report.frictions[0].url, `${gym.url}/job`);
  for (const friction of report.frictions) assert.ok(friction.screenshot && existsSync(join(dir, friction.screenshot)), `${friction.screenshot}`);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'runs', config.run_id, 'report.json'), 'utf8')), report);
  assert.equal(store.transcripts(config.run_id).length, of(events, 'llm.call').length);
  store.close();

  const reopened = openProject(dir);
  t.after(() => reopened.close());
  assert.deepEqual(buildReport(reopened.events(config.run_id)), report);
  const transcripts = JSON.stringify(reopened.transcripts(config.run_id));
  for (const canary of CANARIES) assert.ok(!transcripts.includes(canary), `canary ${canary} reached a transcript`);
});
