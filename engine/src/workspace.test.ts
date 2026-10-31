import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { defaultAudience } from './audience/index.ts';
import { askPersona, cappedGateway, checkRun, compareRuns, credential, editFinding, endedRun, estimateFor, finishedRun, modelRun, planStudy, recordOutcome, repeatReports, repeatRuns, rerunProject, returningPrior, rewriteReport, runPersonas, runSet } from './workspace.ts';
import { QUESTION_MAX } from '@gnomi/simulation/agent/interview.ts';
import { estimateStudy } from '@gnomi/simulation/llm/estimate.ts';
import { createScriptedGateway, DEMO_AUTHOR } from '@gnomi/simulation/llm/scripted.ts';
import { createFsBlobStore } from '@gnomi/simulation/log/blobs.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { getPersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import { buildReport } from '@gnomi/simulation/report/build.ts';
import { EDIT_DESCRIPTION_MAX, EDIT_TITLE_MAX } from '@gnomi/simulation/report/edits.ts';
import { combineReports, WHAT_IF_POST_MAX } from '@gnomi/simulation/report/repeats.ts';
import { createRecorder, newRunConfig } from '@gnomi/simulation/run.ts';
import type { LlmGateway, Recorder } from '@gnomi/simulation/seams.ts';
import { DEFAULT_SETTINGS, PROVIDER_DEFAULTS } from '@gnomi/simulation/settings.ts';
import type { LlmRole, ModelChoice, Persona, Poi, ProjectConfig, Report, RunConfig, RunSettings, WebPoi } from '@gnomi/simulation/types.ts';

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

test('a free model has nothing to cap: at the $0 its estimate gives, an invalid answer still gets its retry', async () => {
  const settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, author: PROVIDER_DEFAULTS.openai_compatible.author } };
  const { cost_usd: [, most] } = estimateStudy({ settings });
  assert.equal(most, 0);
  const scripted = createScriptedGateway([{ nonsense: true }, { saved: true }], (() => {}) as unknown as Recorder);
  const capped = cappedGateway(scripted, most, new AbortController().signal);
  const { object } = await capped.call({ role: 'author', model: settings.routing.author, run_id: null, persona_id: null, round: 1, system: '', user: [], schema: z.object({ saved: z.boolean() }) });
  assert.deepEqual(object, { saved: true });
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

test('a trait-free run is one more run of a set, on the same routing, and only it has the stripped personas', () => {
  const audience = defaultAudience({ name: 'Gym', role: null, goal: 'Post a job' });
  const config: ProjectConfig = { ...gym, audience };
  const people: Persona[] = [{ ...BUILTIN_PERSONA, id: 'p-1', segment_id: audience.segments[0].id, tech_skill: 1, patience: 1, device: 'mobile' }];
  const runs = repeatRuns(config, 2, undefined, true);
  const { group } = runs[0].repeat!;
  assert.deepEqual(runs.map((run) => run.repeat), [1, 2, 3].map((index) => ({ group, index, of: 3, trait_free: 3 })));
  assert.deepEqual(runs.map((run) => run.config.settings.cost_budget_usd), [2, 2, 2], 'the budget split counts it');
  assert.deepEqual(runs[2].config.settings.routing, config.settings.routing, 'the same models, so only the traits differ');
  assert.equal(runPersonas(runs[0], people), people);
  const [stripped] = runPersonas(runs[2], people);
  assert.deepEqual([stripped.id, stripped.seed, stripped.name, stripped.device, stripped.attributes], ['p-1', BUILTIN_PERSONA.seed, BUILTIN_PERSONA.name, 'desktop', {}]);
  assert.equal(stripped.background, audience.segments[0].description);
  assert.deepEqual(repeatRuns(config, 1, deepseek, true).map((run) => run.config.settings.routing.navigator.provider), ['anthropic', 'deepseek', 'anthropic'], 'last, on the project\'s own models');
  assert.equal(repeatRuns(config).length, 1, 'off unless asked for');
  assert.throws(() => repeatRuns(gym, 2, undefined, true), /needs an audience/);

  const plain = estimateFor(config, people);
  const pared = estimateFor(config, [stripped]);
  const whole = estimateFor(config, people, 2, undefined, true);
  assert.notEqual(pared.cost_usd[1], plain.cost_usd[1], 'stripped patience changes the step budget, so the fixture can tell them apart');
  assert.equal(whole.calls, plain.calls * 2 + pared.calls);
  assert.ok(Math.abs(whole.cost_usd[1] - (plain.cost_usd[1] * 2 + pared.cost_usd[1])) < 1e-9);
  assert.equal(whole.run_budget_usd, 2);
});

test('a trait-free run of a grounded audience has no digest, as each seed would quote its own remarks', () => {
  const audience = defaultAudience({ name: 'Gym', role: null, goal: 'Post a job' });
  const grounding = { facts: [], remarks: ['One.', 'Two.', 'Three.', 'Four.'], sources: [] };
  const config: ProjectConfig = { ...gym, audience: { ...audience, segments: [{ ...audience.segments[0], grounding }] } };
  const runs = repeatRuns(config, 1, undefined, true);
  assert.deepEqual(runs.map((run) => run.config.audience!.segments[0].grounding), [grounding, undefined], 'only the control loses it');
  assert.equal(config.audience!.segments[0].grounding, grounding, 'the project keeps its digest');
});

test('a rerun of a set with a trait-free run gets its whole budget back, and the trait-free run itself cannot be run again', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-workspace-'));
  const store = openProject(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const snapshot = (index: number): Omit<RunConfig, 'run_id'> => ({ seed: 1, project: { ...gym, settings: { ...gym.settings, cost_budget_usd: 2 } }, personas: [], sessions: [], reset: false, pause_timeout_ms: 0, app_version: '0', repeat: { group: 'g', index, of: 3, trait_free: 3 } });
  for (const index of [1, 3]) {
    const { run_id } = store.createRun(snapshot(index));
    store.finishRun(run_id, 'finished', null, 0);
  }
  assert.equal(rerunProject(finishedRun(store, 'r-0001')).config.settings.cost_budget_usd, 6);
  assert.throws(() => finishedRun(store, 'r-0002'), /r-0002 is a set's trait-free run/);
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

const frozen = (over: Partial<RunConfig> = {}): RunConfig => ({ run_id: 'r-0001', seed: 7, project: gym, personas: [BUILTIN_PERSONA], sessions: [], reset: false, pause_timeout_ms: 1000, app_version: '0', ...over });

test('a rerun keeps its POIs unless a new address is given, whose host joins the allowed hosts and takes the reset hook with it', () => {
  assert.deepEqual(rerunProject(frozen()).config, gym);
  const hooked = { ...gym, pois: [{ ...poi, allowed_hosts: ['cdn.acme.io'], reset_hook_url: 'http://localhost:3001/__reset?all=1' }, { ...poi, id: 'poi-2', reset_hook_url: 'https://other.acme.io/reset' }] };
  const { config, loginUrl } = rerunProject(frozen({ project: hooked }), { 'poi-1': 'https://pr-12.acme.io/app', 'poi-2': 'https://other.acme.io/next' });
  const [first, second] = config.pois as WebPoi[];
  assert.deepEqual([first.start_url, first.allowed_hosts, first.reset_hook_url], ['https://pr-12.acme.io/app', ['cdn.acme.io', 'pr-12.acme.io'], 'https://pr-12.acme.io/__reset?all=1']);
  assert.equal(second.reset_hook_url, 'https://other.acme.io/reset', 'a hook on another host stays');
  assert.equal(loginUrl('http://localhost:3001/home?x=1'), 'https://pr-12.acme.io/home?x=1', 'a login on the old address follows it, or personas go back to the old build');
  assert.equal(loginUrl('https://sso.acme.io/home'), 'https://sso.acme.io/home');
  assert.equal(rerunProject(frozen()).loginUrl('http://localhost:3001/home'), 'http://localhost:3001/home');
});

test('a rerun refuses a POI it does not have, and a run from before per-run settings; a bad address meets the usual preflight', () => {
  assert.throws(() => rerunProject(frozen(), { 'poi-9': 'https://a.acme.io' }), /no web point of interest "poi-9"; it has "poi-1"/);
  const text: Poi = { id: 'copy', type: 'text', name: 'Copy', asset: 'a.md', segments: null };
  assert.throws(() => rerunProject(frozen({ project: { ...gym, pois: [poi, text] } }), { copy: 'https://a.acme.io' }), /no web point of interest "copy"/);
  assert.throws(() => rerunProject(frozen({ project: { ...gym, settings: undefined as unknown as RunSettings } })), /predates per-run model settings/);
  const store = openProject(mkdtempSync(join(tmpdir(), 'gnomi-rerun-')));
  const bad = rerunProject(frozen(), { 'poi-1': 'not a url' }).config;
  assert.throws(() => checkRun(store, bad, { reset: false, fake: true, secrets: () => null, personas: [BUILTIN_PERSONA] }), /not a web address/);
  const production = rerunProject(frozen({ project: { ...gym, pois: [{ ...poi, production_domains: ['acme.com'] }] } }), { 'poi-1': 'https://app.acme.com/' }).config;
  assert.throws(() => checkRun(store, production, { reset: false, fake: true, secrets: () => null, personas: [BUILTIN_PERSONA] }), /lists as production/);
  store.close();
});

test('a run of a set goes back to the whole budget, so a rerun shares it out as the set did, whatever it is repeated as', () => {
  const share = { ...gym, settings: { ...gym.settings, cost_budget_usd: 2 } };
  const { config } = rerunProject(frozen({ project: share, repeat: { group: 'g', index: 2, of: 3 } }));
  assert.equal(config.settings.cost_budget_usd, 6);
  assert.deepEqual(repeatRuns(config, 3).map((run) => run.config.settings.cost_budget_usd), [2, 2, 2]);
});

test("a rerun's frozen personas are not held to the project's current audience, and the keys are still checked", (t) => {
  const store = openProject(mkdtempSync(join(tmpdir(), 'gnomi-rerun-')));
  t.after(() => store.close());
  const schema = { ...gym, persona_schema: getPersonaSchema() }; // newRunConfig freezes one even with no audience
  assert.throws(() => checkRun(store, schema, { reset: false, fake: true, secrets: () => null }), /Create an audience/);
  assert.deepEqual(checkRun(store, schema, { reset: false, fake: true, secrets: () => null, personas: [BUILTIN_PERSONA] }), [BUILTIN_PERSONA]);
  assert.throws(() => checkRun(store, schema, { reset: false, fake: false, secrets: () => null, personas: [BUILTIN_PERSONA] }), /Add an Anthropic key/);
});

/** A project with one run, its row still saying running as a crash leaves it, and with friction on two pages; `end` logs its end. */
function loggedRun(t: TestContext, project: ProjectConfig = gym) {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-after-'));
  const store = openProject(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = store.createRun({ seed: 1, project, personas: [BUILTIN_PERSONA], sessions: [], reset: false, pause_timeout_ms: 0, app_version: '0' });
  const { run_id } = config;
  const place = { store, blobs: createFsBlobStore(dir), record: createRecorder(store, () => {}) };
  const who = { run_id, round: 1, persona_id: BUILTIN_PERSONA.id, poi_id: 'poi-1' };
  place.record({ ...who, persona_id: null, poi_id: null, type: 'run.started', payload: { config } });
  place.record({ ...who, type: 'persona.created', payload: { persona: BUILTIN_PERSONA } });
  ['/jobs', '/users'].forEach((path, i) => place.record({ ...who, type: 'persona.friction_reported', payload: { step_no: i + 1, severity: 3, what: `Save on ${path} does nothing`, expected: 'Saved', where: { url: `http://localhost:3001${path}`, ref: null }, heard_post_ids: [] } }));
  const end = () => place.record({ ...who, persona_id: null, poi_id: null, type: 'run.finished', payload: {} });
  return { dir, store, place, run_id, end, row: () => endedRun(store, run_id), themes: () => buildReport(store.events(run_id)).themes! };
}

test('work after a run refuses one that has not ended, from the log and not its row, and writes nothing', async (t) => {
  const { dir, store, place, run_id, end } = loggedRun(t);
  store.finishRun(run_id, 'finished', null, 0); // a row can say anything: the log says no end was written
  for (const refused of [() => endedRun(store, run_id), () => modelRun(store, run_id, true, 'judged again')]) assert.throws(refused, /has not ended: it is still running, or it was interrupted/);
  await assert.rejects(rewriteReport(place, run_id), /has not ended/);
  await assert.rejects(recordOutcome(place, { run_id, theme_id: 'g1', status: 'supported', study_date: '2026-10-12' }), /has not ended/);
  assert.equal(existsSync(join(dir, `runs/${run_id}/report.json`)), false);
  assert.equal(store.events(run_id, { types: ['report.generated', 'finding.validated'] }).length, 0);
  assert.throws(() => endedRun(store, 'r-9999'), /There is no run r-9999/);
  end();
  assert.equal(endedRun(store, run_id).run_id, run_id, 'the row may still say running: a stopped run has its end in the log');
});

test('a returning run freezes the named run\'s memories, and a comparison study has nobody to return', (t) => {
  const study = loggedRun(t, { ...gym, comparison: { targets: [] } as unknown as ProjectConfig['comparison'] });
  study.end();
  assert.throws(() => returningPrior(study.store, study.store.listRuns()[0].config), /comparison study, whose personas assess tools rather than use a product/);
  const plain = loggedRun(t);
  plain.place.record({ run_id: plain.run_id, round: 1, persona_id: BUILTIN_PERSONA.id, poi_id: 'poi-1', type: 'persona.goal_done', payload: { step_no: 2, summary: 'Saved.' } });
  plain.end();
  const prior = returningPrior(plain.store, plain.row().config);
  assert.equal(prior.run_id, plain.run_id);
  assert.deepEqual(prior.memories[BUILTIN_PERSONA.id].pois['poi-1'].frictions.map(({ what }) => what), ['Save on /jobs does nothing', 'Save on /users does nothing']);
});

test('a comparison study has no themes to act on, and a run with no routing cannot start model work', (t) => {
  const study = loggedRun(t, { ...gym, comparison: { targets: [] } as unknown as ProjectConfig['comparison'] });
  study.end();
  assert.throws(() => endedRun(study.store, study.run_id), /comparison study, which has no themes to act on/);
  const old = loggedRun(t, { ...gym, settings: undefined as unknown as RunSettings });
  old.end();
  assert.equal(endedRun(old.store, old.run_id).run_id, old.run_id);
  assert.throws(() => modelRun(old.store, old.run_id, true, 'planned from'), /predates per-run model settings, so it cannot be planned from/);
});

test('--fake-llm never replaces a real model\'s answers', (t) => {
  const { store, place, run_id, end } = loggedRun(t);
  end();
  assert.equal(modelRun(store, run_id, true, 'judged again').run_id, run_id);
  place.record({ run_id, round: 1, persona_id: null, poi_id: null, type: 'llm.call', payload: { role: 'judge', provider: 'anthropic', model: 'm', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.1, latency_ms: 0, status: 'ok', error: null } });
  assert.throws(() => modelRun(store, run_id, true, 'judged again'), /analysed by real models/);
  assert.equal(modelRun(store, run_id, false, 'judged again').run_id, run_id);
});

test('a rewrite makes the files, the row and an open app agree with the log', async (t) => {
  const { dir, store, place, run_id, end } = loggedRun(t);
  end();
  const report = await rewriteReport(place, run_id);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `runs/${run_id}/report.json`), 'utf8')).run_id, report.run_id);
  assert.match(readFileSync(join(dir, `runs/${run_id}/report.md`), 'utf8'), /^# Gnomi report: Post a job/);
  assert.equal(store.events(run_id).at(-1)?.type, 'report.generated');
});

test('an outcome is refused at the boundary for each thing that can be wrong, and nothing is recorded', async (t) => {
  const { store, place, run_id, end, themes } = loggedRun(t);
  end();
  const [{ id: theme_id }] = themes();
  const today = new Date(2026, 9, 30, 12);
  const good = { run_id, theme_id, status: 'supported', study_date: '2026-10-12' } as const;
  const refused = (over: object, why: RegExp) => assert.rejects(recordOutcome(place, { ...good, ...over } as never, today), why);
  await refused({ status: 'validated' }, /status must be supported, contradicted, unresolved, not "validated"/);
  await refused({ study_date: '12/10/2026' }, /real date as YYYY-MM-DD/);
  await refused({ study_date: '2026-02-30' }, /real date as YYYY-MM-DD/);
  await refused({ study_date: '2026-10-31' }, /is in the future/);
  await refused({ note: 'x'.repeat(2_001) }, /2001 characters, and the limit is 2000/);
  await refused({ theme_id: 'g99' }, /has no finding "g99"/);
  await refused({ run_id: 'r-9999' }, /There is no run r-9999/);
  assert.equal(store.events(run_id, { types: ['finding.validated', 'report.generated'] }).length, 0);
  await recordOutcome(place, { ...good, study_date: '2026-10-30', note: 'y'.repeat(2_000) }, today);
  await recordOutcome(place, { ...good, note: '   ' }, today);
  const log = store.events(run_id, { types: ['finding.validated'] });
  assert.deepEqual(log.map((e) => e.type === 'finding.validated' && e.payload.note?.length), [2_000, undefined], 'today and the longest note pass, and a blank note is none');
  assert.equal(store.events(run_id, { types: ['llm.call'] }).length, 0, 'no model call');
});

test('an edit is refused at the boundary for each thing that can be wrong, and nothing is recorded', async (t) => {
  const { store, place, run_id, end, themes } = loggedRun(t);
  await assert.rejects(editFinding(place, { run_id, theme_id: 'g1', hidden: true }), /has not ended/);
  end();
  const [{ id: theme_id }] = themes();
  const good = { run_id, theme_id };
  await assert.rejects(editFinding(place, good), /Say what to change/);
  await assert.rejects(editFinding(place, { ...good, title: 'x'.repeat(EDIT_TITLE_MAX + 1) }), /121 characters, and the limit is 120/);
  await assert.rejects(editFinding(place, { ...good, description: 'x'.repeat(EDIT_DESCRIPTION_MAX + 1) }), /601 characters, and the limit is 600/);
  await assert.rejects(editFinding(place, { ...good, theme_id: 'g99', hidden: true }), /has no finding "g99"/);
  await assert.rejects(editFinding(place, { ...good, run_id: 'r-9999', hidden: true }), /There is no run r-9999/);
  assert.equal(store.events(run_id, { types: ['finding.hidden', 'finding.edited', 'report.generated'] }).length, 0);
  await editFinding(place, { ...good, title: 'x'.repeat(EDIT_TITLE_MAX), description: 'y'.repeat(EDIT_DESCRIPTION_MAX) });
  assert.equal(themes()[0].edit?.new_title?.length, EDIT_TITLE_MAX, 'the longest pass');
  assert.equal(store.events(run_id, { types: ['llm.call'] }).length, 0, 'no model call');
});

test('an edit keeps the other field, blank goes back to the original, and the run\'s files keep what it found', async (t) => {
  const { dir, store, place, run_id, end, themes } = loggedRun(t);
  end();
  await rewriteReport(place, run_id);
  const [theme] = themes();
  const good = { run_id, theme_id: theme.id };
  const markdown = () => readFileSync(join(dir, `runs/${run_id}/report.md`), 'utf8');
  const before = markdown();
  await editFinding(place, { ...good, title: '  Our title  ' });
  await editFinding(place, { ...good, description: 'Our description' });
  assert.deepEqual(themes()[0].edit, { hidden: false, new_title: 'Our title', new_description: 'Our description' });
  await editFinding(place, { ...good, hidden: true });
  assert.deepEqual(themes()[0].edit, { hidden: true, new_title: 'Our title', new_description: 'Our description' });
  assert.equal(store.events(run_id).at(-1)?.type, 'report.generated', 'an open app reloads');
  assert.equal(markdown(), before, 'report.md stays the run\'s record');
  assert.equal(JSON.parse(readFileSync(join(dir, `runs/${run_id}/report.json`), 'utf8')).themes[0].title, theme.title);

  await editFinding(place, { ...good, title: '   ' });
  assert.deepEqual(themes()[0].edit, { hidden: true, new_title: null, new_description: 'Our description' });
  await editFinding(place, { ...good, hidden: false, description: '' });
  assert.equal(themes()[0].edit, undefined, 'back to what the run found');
});

test('a question is refused at the boundary for each thing that can be wrong, before anything is spent', async (t) => {
  const { store, place, run_id, end, row } = loggedRun(t);
  end();
  const llm = createScriptedGateway({ navigator: () => ({ answer: 'Never asked.' }) }, place.record);
  const ask = (question: string, persona = BUILTIN_PERSONA.id) => askPersona(place, row(), persona, question, llm);
  await assert.rejects(ask('   '), /Write a question first/);
  await assert.rejects(ask('x'.repeat(QUESTION_MAX + 1)), /501 characters, and the limit is 500/);
  await assert.rejects(ask('Why?', 'nobody'), new RegExp(`${run_id} has no persona nobody`));
  const quiet = { ...row(), config: { ...row().config, personas: [{ ...BUILTIN_PERSONA, id: 'quiet', name: 'Quinn Quiet' }] } };
  await assert.rejects(askPersona(place, quiet, 'quiet', 'Why?', llm), /Quinn Quiet did nothing the log of r-0001 records, so there is nothing to draw on/);
  assert.equal(store.events(run_id, { types: ['llm.call', 'persona.interviewed', 'report.generated'] }).length, 0);
  assert.equal(await ask('y'.repeat(QUESTION_MAX)), 'Never asked.', 'the longest question passes');
});

test('an answer goes in the log and no report file, and a failed call adds none and leaves the report as it was', async (t) => {
  const { dir, store, place, run_id, end, row } = loggedRun(t);
  end();
  const plain = buildReport(store.events(run_id));
  const failing = createScriptedGateway({ navigator: () => { throw new Error('The provider is down'); } }, place.record);
  await assert.rejects(askPersona(place, row(), BUILTIN_PERSONA.id, 'Why?', failing), /The provider is down/);
  assert.deepEqual(buildReport(store.events(run_id)), plain, 'every number as it was');
  assert.equal(store.events(run_id, { types: ['persona.interviewed'] }).length, 0);

  const invalid = createScriptedGateway({ navigator: () => ({ nonsense: true }) }, place.record, { costPerCall: 0.01 });
  await assert.rejects(askPersona(place, row(), BUILTIN_PERSONA.id, 'Why?', invalid), /Invalid output twice/);
  const failed = buildReport(store.events(run_id));
  assert.deepEqual(failed.themes, plain.themes);
  assert.equal(failed.cost_usd, 0.02, 'what failed attempts cost is on the record');
  assert.equal(store.listRuns()[0].cost_usd, 0.02, 'and in the run row');

  const answering = createScriptedGateway({ navigator: () => ({ answer: 'A generated answer about saving.' }) }, place.record, { costPerCall: 0.01 });
  assert.equal(await askPersona(place, row(), BUILTIN_PERSONA.id, '  Why did you stop?  ', answering), 'A generated answer about saving.');
  const [event] = store.events(run_id, { types: ['persona.interviewed'] });
  assert.deepEqual([event.persona_id, event.payload], [BUILTIN_PERSONA.id, { question: 'Why did you stop?', answer: 'A generated answer about saving.' }]);
  assert.equal(store.events(run_id).at(-1)?.type, 'report.generated', 'an open app hears of it');
  assert.equal(store.listRuns()[0].cost_usd, 0.03);
  const [json, markdown] = ['json', 'md'].map((format) => readFileSync(join(dir, `runs/${run_id}/report.${format}`), 'utf8'));
  for (const file of [json, markdown]) assert.ok(!file.includes('A generated answer') && !file.includes('Why did you stop'), 'the report files hold no interview');
});

test('a comparison study and a run that has not ended take no question', async (t) => {
  const study = loggedRun(t, { ...gym, comparison: { targets: [] } as unknown as ProjectConfig['comparison'] });
  study.end();
  assert.throws(() => modelRun(study.store, study.run_id, true, 'asked about'), /comparison study/);
  const live = loggedRun(t);
  assert.throws(() => modelRun(live.store, live.run_id, true, 'asked about'), /has not ended/);
});

test('a study plan writes its own file and report, and a failed call leaves the report as it was, an earlier plan included', async (t) => {
  const { dir, store, place, run_id, end, row } = loggedRun(t);
  end();
  const plain = buildReport(store.events(run_id));
  const planFile = join(dir, `runs/${run_id}/study-plan.md`);
  const failing = createScriptedGateway({ author: () => { throw new Error('The provider is down'); } }, place.record);
  await assert.rejects(planStudy(place, row(), failing), /The provider is down/);
  assert.deepEqual(buildReport(store.events(run_id)), plain, 'no plan, and every number as it was');
  assert.equal(existsSync(planFile), false);

  const invalid = createScriptedGateway({ author: () => ({ nonsense: true }) }, place.record, { costPerCall: 0.01 });
  await assert.rejects(planStudy(place, row(), invalid), /Invalid output twice/);
  const failed = buildReport(store.events(run_id));
  assert.equal(failed.study_plan, undefined);
  assert.deepEqual(failed.themes, plain.themes);
  assert.equal(failed.cost_usd, 0.02, 'what failed attempts cost is on the record');
  assert.equal(store.listRuns()[0].cost_usd, 0.02, 'and in the run row');
  assert.equal(JSON.parse(readFileSync(join(dir, `runs/${run_id}/report.json`), 'utf8')).cost_usd, 0.02);

  const report = await planStudy(place, row(), createScriptedGateway({ author: DEMO_AUTHOR }, place.record));
  assert.equal(report.study_plan?.hypotheses.length, 2);
  const file = readFileSync(planFile, 'utf8');
  assert.match(file, /^# Study plan: Post a job\n\n> These hypotheses come from simulated users and are unproven\. Do not show them to participants/);
  assert.doesNotMatch(file, /Save on \/jobs does nothing/, 'a researcher gets the plan, not the evidence');

  await assert.rejects(planStudy(place, row(), failing), /The provider is down/);
  assert.deepEqual(buildReport(store.events(run_id)).study_plan, report.study_plan, 'the earlier plan stays');
});

test('a run with no friction of its own has nothing to plan, and no call is made', async (t) => {
  const { store, place, run_id, end, row } = loggedRun(t);
  end();
  const quiet = { ...row(), run_id };
  const none = { ...place, store: { ...store, events: () => store.events(run_id).filter((e) => e.type !== 'persona.friction_reported') } as typeof store };
  const unused = createScriptedGateway({}, place.record);
  await assert.rejects(planStudy(none, quiet, unused), /has no friction finding of your own product/);
  assert.equal(store.events(run_id, { types: ['llm.call'] }).length, 0);
});

const POST = { text: 'Saving a job fails for everyone.' };
const socialConfig = (over: Partial<RunSettings> = {}): ProjectConfig => ({ ...gym, audience: { ...defaultAudience({ name: 'Gym', role: null, goal: 'Post a job' }), persona_count: 4 }, settings: { ...gym.settings, social: true, rounds: 3, ...over } });
const fourPeople = ({ audience }: ProjectConfig): Persona[] => [0, 1, 2, 3].map((i) => ({ ...BUILTIN_PERSONA, id: `p-${i}`, segment_id: audience!.segments[0].id }));

test('a what-if plans matched pairs: one audience and seed each, only the post differs, and it is off by default', () => {
  const config = socialConfig();
  const people = fourPeople(config);
  const runs = repeatRuns(config, 3, undefined, false, POST);
  const { group } = runs[0].repeat!;
  assert.equal(runs.length, 6);
  assert.deepEqual(runs.map((run) => run.repeat!.what_if!.pair), [1, 1, 2, 2, 3, 3]);
  assert.deepEqual(runs.map((run) => [run.repeat!.group, run.repeat!.index, run.repeat!.of]), [1, 2, 3, 4, 5, 6].map((index) => [group, index, 6]));
  assert.deepEqual(runs.map((run) => run.config.settings.cost_budget_usd), [1, 1, 1, 1, 1, 1], 'each run an equal share');
  assert.ok(runs.every((run) => run.config.settings.routing === config.settings.routing));
  const planned = runs.map((run) => newRunConfig(run.config, { personas: runPersonas(run, people), sessions: [], reset: false, repeat: run.repeat }));
  assert.deepEqual([...new Set(planned.map((run) => run.seed))], [config.audience!.seed], 'one seed, so one follow graph');
  assert.ok(planned.every((run) => run.personas.length === 4 && JSON.stringify(run.personas) === JSON.stringify(planned[0].personas)), 'one audience');
  for (const pair of [1, 2, 3]) {
    const [a, b] = planned.filter((run) => run.repeat!.what_if!.pair === pair);
    assert.notEqual(a.repeat!.what_if!.post, b.repeat!.what_if!.post, 'one run of each pair has the post');
    assert.deepEqual({ ...a.project }, { ...b.project }, 'and nothing else in the design differs');
    const [added, plain] = a.repeat!.what_if!.post ? [a, b] : [b, a];
    assert.deepEqual([added.injected_posts?.map((p) => [p.text, p.round, p.poi_id]), plain.injected_posts], [[[POST.text, 1, 'poi-1']], undefined]);
  }
  const leading = repeatRuns(config, 8, undefined, false, POST).filter((run) => run.repeat!.index % 2 === 1).map((run) => run.repeat!.what_if!.post);
  assert.equal(new Set(leading).size, 2, 'the seed orders each pair, so neither side always runs second');
  assert.deepEqual(repeatRuns(config, 3).map((run) => run.repeat!.what_if), [undefined, undefined, undefined], 'off unless asked for');
  assert.equal(repeatRuns(config, 1, undefined, false, POST).length, 2, 'one pair is two runs, not a lone run');
  assert.equal(repeatRuns(config, 1, undefined, false, { text: '  padded  ', round: 3 })[0].repeat!.what_if!.text, 'padded');
  const competitor: WebPoi = { ...poi, id: 'poi-0', mode: 'observe_only' };
  assert.equal(repeatRuns({ ...config, pois: [competitor, poi] }, 1, undefined, false, POST)[0].repeat!.what_if!.poi_id, 'poi-1', 'about the team\'s own product');
});

test('the estimate of a what-if is every run together, before anything starts', () => {
  const config = socialConfig();
  const people = fourPeople(config);
  const one = estimateFor(config, people);
  const whole = estimateFor(config, people, 3, undefined, false, POST);
  assert.equal(whole.calls, one.calls * 6);
  assert.ok(Math.abs(whole.cost_usd[1] - one.cost_usd[1] * 6) < 1e-9);
  assert.ok(Math.abs(whole.minutes[1] - one.minutes[1] * 6) < 1e-9);
  assert.equal(whole.run_budget_usd, 1);
});

test('a what-if is refused where the post could reach nobody, or would not be the only change', () => {
  const config = socialConfig();
  const plan = (project: ProjectConfig, whatIf: { text: string; round?: number } = POST, also?: ModelChoice, withTraitFree = false) => () => repeatRuns(project, 2, also, withTraitFree, whatIf);
  assert.throws(plan(socialConfig({ social: false })), /social rounds off/);
  assert.throws(plan(gym), /social rounds off/, 'a project with no audience has none');
  assert.throws(plan({ ...config, audience: { ...config.audience!, persona_count: 1 } }), /at least two personas/);
  assert.throws(plan({ ...config, comparison: {} as ProjectConfig['comparison'] }), /comparison study/);
  assert.throws(plan(config, POST, deepseek), /--also-model or --also-trait-free/);
  assert.throws(plan(config, POST, undefined, true), /--also-model or --also-trait-free/);
  assert.throws(plan(config, { text: '   ' }), /needs the text of its post/);
  assert.throws(plan(config, { text: 'x'.repeat(WHAT_IF_POST_MAX + 1) }), /The post has 501 characters, and the limit is 500\./);
  assert.equal(plan(config, { text: 'x'.repeat(WHAT_IF_POST_MAX) })().length, 4);
  for (const round of [0, 4, 1.5, Number.NaN]) assert.throws(plan(config, { ...POST, round }), /whole number from 1 to 3/);
  assert.equal(plan(config, { ...POST, round: 3 })()[0].repeat!.what_if!.round, 3);
  assert.throws(() => estimateFor(socialConfig({ social: false }), fourPeople(config), 2, undefined, false, POST), /social rounds off/, 'the estimate refuses as the run does');
});

test('what-if runs stay out of a comparison, a study and a rerun, whichever run is named, and the runs without the post stand for the set', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-workspace-'));
  const store = openProject(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = socialConfig();
  const record = createRecorder(store, () => {});
  const seeded = (run: ReturnType<typeof repeatRuns>[number]) => {
    const { run_id, ...frozen } = store.createRun(newRunConfig(run.config, { personas: fourPeople(config), sessions: [], reset: false, repeat: run.repeat }));
    record({ run_id, round: 1, persona_id: null, poi_id: null, type: 'run.started', payload: { config: { run_id, ...frozen } } });
    record({ run_id, round: 1, persona_id: null, poi_id: null, type: 'run.finished', payload: {} });
    store.finishRun(run_id, 'finished', null, 0);
    return run_id;
  };
  const planned = [...repeatRuns(config, 2, undefined, false, POST), ...repeatRuns(config, 2)];
  const ids = planned.map(seeded);
  const added = ids.filter((_, i) => planned[i].repeat!.what_if?.post);
  const [plain, other] = [ids.find((id) => !added.includes(id))!, ids.at(-1)!];
  assert.deepEqual(compareRuns(store, plain, other).before, ids.filter((id, i) => !added.includes(id) && planned[i].repeat!.what_if), 'the two runs without the post');
  assert.throws(() => compareRuns(store, added[0], other), new RegExp(`${added[0]} is a what-if run, with a post your team added: compare one of the others`));
  assert.throws(() => compareRuns(store, other, added[0]), /is a what-if run/);
  assert.throws(() => finishedRun(store, added[0]), new RegExp(`${added[0]} is a what-if run, with a post your team added: run one of the others again`));
  assert.equal(rerunProject(finishedRun(store, plain)).config.settings.cost_budget_usd, 6, 'a run without the post runs again, on the whole budget');
  const blobs = createFsBlobStore(dir);
  const llm = createScriptedGateway({ author: DEMO_AUTHOR }, record);
  await assert.rejects(planStudy({ store, blobs, record }, store.listRuns().find((run) => run.run_id === added[0])!, llm), /is a what-if run, with a post your team added: plan a study from one of the others/);
  const set = combineReports(repeatReports(store, planned[0].repeat!.group));
  assert.deepEqual([set.of, set.compared, set.what_if?.pairs, set.what_if?.of], [2, 2, 2, 2]);
});
