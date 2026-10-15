import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openProject } from '../log/sqlite.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import type { EventPayloads, GnomiEvent, NewEvent, RunConfig } from '../types.ts';
import { buildReport, HYPOTHESIS_BANNER } from './build.ts';

const config: RunConfig = {
  run_id: 'r-0001',
  seed: 42,
  project: {
    name: 'Gym',
    description: 'A demo ATS.',
    poi: { id: 'poi-gym', type: 'web', name: 'Gym', start_url: 'http://localhost:3001/' },
    goal: 'Post a job for a backend engineer',
  },
  persona: BUILTIN_PERSONA,
  model: { provider: 'anthropic', navigator: 'claude-haiku-5-5' },
  step_budget: 40,
  cost_budget_usd: 1,
  screenshots: true,
  app_version: '0.0.0',
};

const url = 'http://localhost:3001/jobs/new';
const env = { run_id: 'r-0001', round: 1, persona_id: 'p-001', poi_id: 'poi-gym' } as const;
const runEnv = { run_id: 'r-0001', round: 1, persona_id: null, poi_id: null } as const;
const runStarted: NewEvent = { ...runEnv, type: 'run.started', payload: { config } };

function stepPayload(step_no: number, thought: string, screenshot: string | null): EventPayloads['persona.step'] {
  return {
    step_no,
    action: { type: 'click', ref: 'e1', text: null },
    target: null,
    result: { ok: true, url_before: url, url_after: url, dom_changed: true, error: null },
    thought,
    feeling: 0,
    snapshot_hash: 'h',
    screenshot,
    duration_ms: 10,
  };
}

function llmCall(cost_usd: number, input_tokens: number, output_tokens: number): EventPayloads['llm.call'] {
  return {
    role: 'navigator',
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    input_tokens,
    output_tokens,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd,
    latency_ms: 900,
    status: 'ok',
    error: null,
  };
}

// Each entry is [ts, event], in the order the engine would append them.
type Script = Array<[number, NewEvent]>;

function finishedRun(): Script {
  return [
    [1000, runStarted],
    [1100, { ...env, type: 'persona.episode_started', payload: { poi_id: 'poi-gym', device: 'desktop', start_url: url } }],
    // A friction logged before its step.
    [
      1200,
      {
        ...env,
        type: 'persona.friction_reported',
        payload: {
          step_no: 1,
          severity: 2,
          what: 'The Save button is ambiguous.',
          expected: 'A button that says what it does.',
          where: { url, ref: 'e4' },
        },
      },
    ],
    [
      1300,
      { ...env, type: 'persona.step', payload: stepPayload(1, 'Looking for the way to post a job.', 'runs/r-0001/shots/p-001-0001.jpg') },
    ],
    [1350, { ...env, type: 'llm.call', payload: llmCall(0.25, 1200, 300) }],
    [1400, { ...env, type: 'persona.step', payload: stepPayload(2, 'The form gives no error text.', null) }],
    // A friction logged after its step.
    [
      1500,
      {
        ...env,
        type: 'persona.friction_reported',
        payload: {
          step_no: 2,
          severity: 3,
          what: 'The required field gives no error.',
          expected: 'An error under the field.',
          where: { url, ref: 'e9' },
        },
      },
    ],
    // Cached input is reported apart from input_tokens and still counts as input.
    [1550, { ...env, type: 'llm.call', payload: { ...llmCall(0.5, 800, 100), cache_read_tokens: 3000, cache_write_tokens: 500 } }],
    [1700, { ...env, type: 'persona.goal_done', payload: { step_no: 2, summary: 'Posted the job.' } }],
    [9000, { ...runEnv, type: 'run.finished', payload: {} }],
    [9100, { ...runEnv, type: 'report.generated', payload: { path: 'runs/r-0001/report.json', friction_count: 2 } }],
  ];
}

// The events as the store returns them: seq counts from 1, ts is the scripted one.
const stored = (script: Script): GnomiEvent[] => script.map(([ts, event], i) => ({ ...event, seq: i + 1, ts }));

test('a finished run folds into its outcome, frictions and totals', () => {
  assert.deepEqual(buildReport(stored(finishedRun())), {
    run_id: 'r-0001',
    status: 'finished',
    stop_reason: null,
    goal: 'Post a job for a backend engineer',
    poi: { name: 'Gym', start_url: 'http://localhost:3001/' },
    persona: { id: 'p-001', name: 'Priya Natarajan', job_title: 'Recruiter', device: 'desktop' },
    outcome: 'done',
    outcome_text: 'Posted the job.',
    steps: 2,
    frictions: [
      {
        seq: 3,
        step_no: 1,
        severity: 2,
        what: 'The Save button is ambiguous.',
        expected: 'A button that says what it does.',
        url,
        quote: 'Looking for the way to post a job.',
        screenshot: 'runs/r-0001/shots/p-001-0001.jpg',
      },
      {
        seq: 7,
        step_no: 2,
        severity: 3,
        what: 'The required field gives no error.',
        expected: 'An error under the field.',
        url,
        quote: 'The form gives no error text.',
        screenshot: null,
      },
    ],
    cost_usd: 0.75,
    llm_calls: 2,
    input_tokens: 5500,
    output_tokens: 400,
    started_at: 1000,
    ended_at: 9000,
    duration_ms: 8000,
    banner: HYPOTHESIS_BANNER,
  });
});

test('a stopped run carries the stop reason with its detail, and a budget signal', () => {
  const report = buildReport(
    stored([
      [1000, runStarted],
      [1100, { ...env, type: 'persona.step', payload: stepPayload(1, 'Trying.', null) }],
      [2000, { ...env, type: 'signal.budget_exceeded', payload: { step_no: 1, budget: 1 } }],
      [2100, { ...runEnv, type: 'run.stopped', payload: { reason: 'cost_budget', detail: '$1.00 spent' } }],
    ]),
  );
  assert.equal(report.status, 'stopped');
  assert.equal(report.stop_reason, 'cost_budget: $1.00 spent');
  assert.equal(report.outcome, 'budget_exceeded');
  assert.equal(report.outcome_text, null);
  assert.equal(report.ended_at, 2100);
  assert.equal(report.duration_ms, 1100);
});

test('a run without an end event is still running and has no outcome', () => {
  const report = buildReport(
    stored([
      [1000, runStarted],
      [1100, { ...env, type: 'persona.step', payload: stepPayload(1, 'Trying.', null) }],
    ]),
  );
  assert.equal(report.status, 'running');
  assert.equal(report.stop_reason, null);
  assert.equal(report.outcome, 'incomplete');
  assert.equal(report.ended_at, null);
  assert.equal(report.duration_ms, null);
  assert.equal(report.steps, 1);
});

test('an abandoned persona reports the reason it gave up', () => {
  const report = buildReport(
    stored([
      [1000, runStarted],
      [1100, { ...env, type: 'persona.step', payload: stepPayload(1, 'Where is the form?', null) }],
      [1200, { ...env, type: 'persona.abandoned', payload: { step_no: 1, reason: 'Could not find the job form.' } }],
      [1300, { ...runEnv, type: 'run.finished', payload: {} }],
    ]),
  );
  assert.equal(report.outcome, 'abandoned');
  assert.equal(report.outcome_text, 'Could not find the job form.');
});

test('buildReport refuses a log without run.started', () => {
  assert.throws(
    () => buildReport(stored([[1100, { ...env, type: 'persona.step', payload: stepPayload(1, 'Trying.', null) }]])),
    /run\.started/,
  );
});

test('a report rebuilt from the reopened log equals the report of the live run', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openProject(dir);
  const { run_id: _run_id, ...snapshot } = config;
  const run = store.createRun(snapshot);
  const live = finishedRun().map(([, event]) => store.append(event));
  const original = buildReport(live);
  assert.equal(original.frictions.length, 2);
  store.close();

  const reopened = openProject(dir);
  assert.deepEqual(reopened.events(run.run_id), live);
  assert.deepEqual(buildReport(reopened.events(run.run_id)), original);
  reopened.close();
});
