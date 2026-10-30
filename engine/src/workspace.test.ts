import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { defaultAudience } from './audience/index.ts';
import { cappedGateway, checkRun, credential, estimateFor, repeatRuns, runSet } from './workspace.ts';
import { createScriptedGateway } from '@gnomi/simulation/llm/scripted.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import type { LlmGateway, Recorder } from '@gnomi/simulation/seams.ts';
import { DEFAULT_SETTINGS, PROVIDER_DEFAULTS } from '@gnomi/simulation/settings.ts';
import type { LlmRole, ModelChoice, ProjectConfig, Report, RunSettings, WebPoi } from '@gnomi/simulation/types.ts';

test('a provider needs its key, and the local one its endpoint', () => {
  const secrets = (name: string) => (name === 'openai_api_key' ? 'sk-test' : null);
  assert.equal(credential('openai', null, secrets), 'sk-test');
  assert.equal(credential('anthropic', 'http://localhost:11434/v1', secrets), null);
  assert.equal(credential('openai_compatible', 'http://localhost:11434/v1', secrets), 'http://localhost:11434/v1');
  assert.equal(credential('openai_compatible', '', secrets), null);
});

test('the start check needs a key for every role the run will use, and none with scripted models', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-workspace-'));
  const store = openProject(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const poi: WebPoi = { id: 'poi-1', type: 'web', name: 'Gym', start_url: 'http://localhost:3001/', allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null };
  const base: ProjectConfig = { name: 'Gym', description: '', pois: [poi], goal: 'Post a job', role: null, audience: defaultAudience({ name: 'Gym', role: null, goal: 'Post a job' }), settings: DEFAULT_SETTINGS };
  store.replacePersonas([BUILTIN_PERSONA]);
  const anthropic = (name: string) => (name === 'anthropic_api_key' ? 'sk-test' : null);
  const on = (role: LlmRole, settings: Partial<RunSettings> = {}) => ({ ...base, settings: { ...DEFAULT_SETTINGS, ...settings, routing: { ...DEFAULT_SETTINGS.routing, [role]: PROVIDER_DEFAULTS.openai[role] } } });
  const check = (config: ProjectConfig, fake = false) => checkRun(store, config, { reset: false, fake, secrets: anthropic });
  assert.equal(check(base).length, 1);
  for (const role of ['socialiser', 'judge', 'author'] as const) assert.throws(() => check(on(role)), new RegExp(`OpenAI key in Settings: the ${role} runs on it`));
  assert.doesNotThrow(() => check(on('judge'), true));
  // Unused roles need no key: no social rounds, and the persona writer has already written everyone.
  assert.doesNotThrow(() => check(on('socialiser', { social: false })));
  assert.doesNotThrow(() => check(on('persona_writer')));
});

test('a capped gateway makes no call once its own calls have spent the cap, nor after its signal aborts', async () => {
  const scripted = createScriptedGateway({ judge: () => ({}) }, (() => {}) as unknown as Recorder, { costPerCall: 0.4 });
  const ask = (llm: LlmGateway) => llm.call({ role: 'judge', model: DEFAULT_SETTINGS.routing.judge, run_id: null, persona_id: null, round: 1, system: '', user: [], schema: z.object({}) });
  const capped = cappedGateway(scripted, 1, new AbortController().signal);
  for (let i = 0; i < 3; i++) await ask(capped); // $1.20: the call that crosses the cap is paid for, so it answers
  await assert.rejects(ask(capped), /\$1\.00 budget/);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(ask(cappedGateway(scripted, 1, stop.signal)));
});

const poi: WebPoi = { id: 'poi-1', type: 'web', name: 'Gym', start_url: 'http://localhost:3001/', allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null };
const gym: ProjectConfig = { name: 'Gym', description: '', pois: [poi], goal: 'Post a job', role: null, audience: null, settings: { ...DEFAULT_SETTINGS, cost_budget_usd: 6 } };
const deepseek: ModelChoice = { provider: 'deepseek', model: 'deepseek-v4-pro' };

test('a lone run is as it was; a set shares its budget and group, and only its extra run moves to the other model', () => {
  assert.deepEqual(repeatRuns(gym), [{ config: gym }]);
  assert.deepEqual(repeatRuns(gym, 1), [{ config: gym }]);
  const runs = repeatRuns(gym, 2, deepseek);
  assert.deepEqual(runs.map((run) => run.repeat?.index), [1, 2, 3]);
  assert.ok(runs.every((run) => run.repeat?.of === 3 && run.repeat.group === runs[0].repeat?.group));
  assert.deepEqual(runs.map((run) => run.config.settings.cost_budget_usd), [2, 2, 2]);
  assert.deepEqual(runs.map((run) => run.config.settings.routing.navigator.provider), ['anthropic', 'anthropic', 'deepseek']);
  assert.deepEqual(runs[2].config.settings.routing.socialiser, deepseek);
  assert.deepEqual(runs[2].config.settings.routing.judge, DEFAULT_SETTINGS.routing.judge, 'the judge stays, so every run is analysed alike');
  assert.equal(gym.settings.cost_budget_usd, 6, 'the project keeps its budget');
  assert.notEqual(repeatRuns(gym, 2)[0].repeat?.group, runs[0].repeat?.group);
  assert.equal(repeatRuns(gym, 1, deepseek).length, 2);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => repeatRuns(gym, bad), /whole number/);
});

test('the estimate of a set adds up its runs, each at its own prices', () => {
  const personas = [BUILTIN_PERSONA];
  const one = estimateFor(gym, personas);
  const three = estimateFor(gym, personas, 3);
  assert.equal(three.calls, one.calls * 3);
  for (const i of [0, 1]) {
    assert.ok(Math.abs(three.cost_usd[i] - one.cost_usd[i] * 3) < 1e-9);
    assert.ok(Math.abs(three.minutes[i] - one.minutes[i] * 3) < 1e-9, 'one after another, never side by side');
  }
  const also = estimateFor(gym, personas, 1, deepseek);
  assert.equal(also.calls, one.calls * 2);
  const other = estimateFor({ ...gym, settings: { ...gym.settings, routing: { ...gym.settings.routing, navigator: deepseek, socialiser: deepseek } } }, personas);
  assert.ok(Math.abs(also.cost_usd[1] - (one.cost_usd[1] + other.cost_usd[1])) < 1e-9, 'the second run is at DeepSeek prices');
  assert.notEqual(other.cost_usd[1], one.cost_usd[1]);
  assert.deepEqual(estimateFor(gym, personas, 1, { provider: 'openai', model: 'no-such-model' }).unpriced, ['no-such-model']);
});

test('each run stops at its share, so the estimate shows a run over its share that the total hides', () => {
  const personas = [BUILTIN_PERSONA];
  const sonnet: ModelChoice = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
  const { cost_usd: [, total] } = estimateFor(gym, personas, 2, sonnet);
  const tight = { ...gym, settings: { ...gym.settings, cost_budget_usd: total * 1.05 } };
  const set = estimateFor(tight, personas, 2, sonnet);
  assert.ok(set.cost_usd[1] < tight.settings.cost_budget_usd, 'the total fits the budget');
  assert.ok(Math.abs(set.run_budget_usd - tight.settings.cost_budget_usd / 3) < 1e-9);
  assert.ok(set.run_high_usd > set.run_budget_usd, 'the Sonnet run does not fit its share');
  assert.equal(set.run_high_usd, estimateFor(tight, personas, 1, sonnet).run_high_usd, 'the dearest run, whatever the number of cheap ones');
  const one = estimateFor(gym, personas);
  assert.deepEqual([one.run_budget_usd, one.run_high_usd], [gym.settings.cost_budget_usd, one.cost_usd[1]], 'a lone run has the whole budget');
});

test('the runs of a set go one at a time, and a run that stops ends it', async () => {
  const report = (status: Report['status']) => ({ status }) as Report;
  const started: number[] = [];
  let active = 0;
  const run = (statuses: Report['status'][]) => async (_: string, index: number) => {
    assert.equal(active++, 0, 'one active run');
    started.push(index);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return report(statuses[index]);
  };
  const going = () => false;
  assert.equal((await runSet(['a', 'b', 'c'], run(['finished', 'finished', 'finished']), going)).length, 3);
  started.length = 0;
  assert.deepEqual((await runSet(['a', 'b', 'c'], run(['finished', 'stopped', 'finished']), going)).map((r) => r.status), ['finished', 'stopped']);
  assert.deepEqual(started, [0, 1], 'the third never started');
  await assert.rejects(runSet(['a', 'b'], async (_, index) => { if (index) throw new Error('login gone'); return report('finished'); }, going), /login gone/);
  // A stop that lands once a run has logged its end changes nothing in that run, which comes back finished.
  started.length = 0;
  assert.deepEqual((await runSet(['a', 'b', 'c'], run(['finished', 'finished', 'finished']), () => started.length === 1)).map((r) => r.status), ['finished']);
  assert.deepEqual(started, [0], 'the set ended there');
});
