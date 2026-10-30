// The project work that does not depend on how a client reaches the engine: host.ts (the app) and cli.ts (a terminal) share it.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_PERSONA_WRITER, type AudienceDeps } from './audience/index.ts';
import { assetPath } from '@gnomi/simulation/assets.ts';
import { effectiveComparisonPois, validateComparison } from '@gnomi/simulation/comparison/config.ts';
import { estimateRun } from '@gnomi/simulation/llm/estimate.ts';
import { createGateway } from '@gnomi/simulation/llm/gateway.ts';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, DEMO_NAVIGATOR, DEMO_SOCIALISER } from '@gnomi/simulation/llm/scripted.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { preflight } from '@gnomi/simulation/poi/index.ts';
import { webPois } from '@gnomi/simulation/poi/pois.ts';
import { validatePersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import { personaProfileIsCurrent } from '@gnomi/simulation/profile/signature.ts';
import { buildReport } from '@gnomi/simulation/report/build.ts';
import { newRunConfig, startRun, type RunDeps, type RunHandle } from '@gnomi/simulation/run.ts';
import type { LlmGateway, ProjectStore, Recorder, SecretName } from '@gnomi/simulation/seams.ts';
import { socialRounds } from '@gnomi/simulation/settings.ts';
import type { LlmRole, ModelChoice, Persona, PersonaProgress, ProjectConfig, ProviderId, Report, RunConfig, RunEstimate, SessionInfo } from '@gnomi/simulation/types.ts';

export const KEYS: Record<Exclude<ProviderId, 'openai_compatible'>, { secret: SecretName; label: string }> = {
  anthropic: { secret: 'anthropic_api_key', label: 'an Anthropic' },
  openai: { secret: 'openai_api_key', label: 'an OpenAI' },
  google: { secret: 'google_api_key', label: 'a Google' },
  deepseek: { secret: 'deepseek_api_key', label: 'a DeepSeek' },
};

export type Secrets = (name: SecretName) => string | null;

/** What a provider needs before any call: the local endpoint for openai_compatible, else its key. */
export const credential = (provider: ProviderId, localBaseUrl: string | null | undefined, secrets: Secrets) =>
  provider === 'openai_compatible' ? localBaseUrl || null : secrets(KEYS[provider].secret);

/** The model gateway for this project's routing, or scripted answers with no key and no cost; onThrottle tells a run to back off (tech.md §9.5). */
export function projectGateway(opts: { fake: boolean; secrets: Secrets; config: ProjectConfig; record: Recorder; onThrottle?: (provider: ProviderId) => void }): LlmGateway {
  if (opts.fake) return createScriptedGateway({ navigator: DEMO_NAVIGATOR, socialiser: DEMO_SOCIALISER, persona_writer: DEMO_PERSONA_WRITER, judge: DEMO_JUDGE, author: DEMO_AUTHOR }, opts.record);
  return createGateway({ secrets: { get: opts.secrets }, localBaseUrl: opts.config.settings.local_base_url, record: opts.record, onThrottle: opts.onThrottle });
}

/** Model work after a run, such as a rejudge: like a run's gateway at its cost budget, no call starts once these calls have spent cap, and those in flight are canceled. */
export function cappedGateway(llm: LlmGateway, cap: number, signal: AbortSignal): LlmGateway {
  let spent = 0;
  const reached = new AbortController();
  const stop = AbortSignal.any([signal, reached.signal]);
  return {
    async call(req) {
      stop.throwIfAborted();
      return llm.call({
        ...req,
        signal: req.signal ? AbortSignal.any([req.signal, stop]) : stop,
        onAttempt(attempt) {
          spent += attempt.payload.cost_usd;
          if (spent >= cap) reached.abort(new Error(`The $${cap.toFixed(2)} budget was reached`));
          req.onAttempt?.(attempt);
        },
      });
    },
  };
}

/** What the audience builder needs for this project: setup calls and drafts go to its store, progress to emit. */
export function audienceDeps(store: ProjectStore, config: ProjectConfig, llm: LlmGateway, opts: { signal?: AbortSignal; emit?: (progress: PersonaProgress) => void } = {}): AudienceDeps {
  // Proposed segments may only use logins that were actually recorded (metadata only, no session key needed).
  const roles = store.listSessions().map((s) => s.role);
  const task_id = randomUUID();
  const started = Date.now();
  const progress: PersonaProgress = { done: 0, total: 0, calls: 0, failed_attempts: 0, stage: 'sketching' };
  const notify = () => opts.emit?.({ ...progress, elapsed_ms: Date.now() - started });
  return {
    llm, model: config.settings.routing.persona_writer, project: config, roles,
    signal: opts.signal,
    cache: { get: (key) => store.getPersonaDraft(key), set: (key, value) => store.putPersonaDraft(key, value) },
    onProgress(done, total, persona) {
      Object.assign(progress, { done, total });
      if (persona) progress.recent = [persona.name, ...(progress.recent ?? [])].slice(0, 3);
      notify();
    },
    onSketched(sketched) { progress.sketched = sketched; notify(); },
    onStage(stage) { progress.stage = stage; notify(); },
    onAttempt(req, attempt) {
      store.recordSetupCall({ task_id, persona_id: req.persona_id, purpose: req.purpose ?? 'setup' }, attempt);
      progress.calls!++;
      if (attempt.payload.status !== 'ok') progress.failed_attempts!++;
      notify();
    },
  };
}

/** Who runs: the generated population, or the built-in persona when the project has no audience. */
export function population(store: ProjectStore, config: ProjectConfig): Persona[] {
  return config.audience ? store.listPersonas() : [BUILTIN_PERSONA];
}

export function checkComparison(config: ProjectConfig) {
  const comparisonProblems = validateComparison(config);
  if (comparisonProblems.length) throw new Error(`Comparison: ${comparisonProblems.join(' ')}`);
}

/**
 * The runs of a set, each with its share of the cost budget. `also` adds one more with the navigator and socialiser on that model.
 * One run is a lone run, with no repeat. The audience seed stays, so personas and the follow graph are the same in every run.
 */
export function repeatRuns(config: ProjectConfig, repeats = 1, also?: ModelChoice): { config: ProjectConfig; repeat?: RunConfig['repeat'] }[] {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('The number of repeats must be a whole number of at least 1.');
  const of = repeats + (also ? 1 : 0);
  if (of === 1) return [{ config }];
  const group = randomUUID().slice(0, 8);
  const { routing, cost_budget_usd } = config.settings;
  return Array.from({ length: of }, (_, i) => ({
    config: { ...config, settings: { ...config.settings, cost_budget_usd: cost_budget_usd / of, routing: also && i === repeats ? { ...routing, navigator: also, socialiser: also } : routing } },
    repeat: { group, index: i + 1, of },
  }));
}

/**
 * Runs a set one after another, as a project has one active run. A run that does not finish ends the set, and so does `stopped`: a stop
 * that lands once a run has logged its end changes nothing in that run. Returns the reports there are.
 */
export async function runSet<Run>(runs: Run[], run: (planned: Run, index: number) => Promise<Report>, stopped: () => boolean): Promise<Report[]> {
  const reports: Report[] = [];
  for (const [index, planned] of runs.entries()) {
    reports.push(await run(planned, index));
    if (reports.at(-1)!.status !== 'finished' || stopped()) break;
  }
  return reports;
}

/** The reports of a set's runs so far, in the order they ran. A crash logs no end, so only the row says such a run is over. */
export const repeatReports = (store: ProjectStore, group: string): Report[] => store.listRuns()
  .filter((run) => run.config.repeat?.group === group)
  .sort((a, b) => a.config.repeat!.index - b.config.repeat!.index)
  .map((run) => {
    const report = buildReport(store.events(run.run_id));
    return run.status === 'interrupted' ? { ...report, status: 'stopped' } : report;
  });

/**
 * The sum over a set's runs: the --also-model run has its own prices, and the runs go one after another, so their minutes add up too.
 * Each run stops at its share, so a total within the budget can hide a run over its share: `run_high_usd` is the dearest run's high estimate.
 */
export function estimateFor(config: ProjectConfig, personas: Persona[], repeats = 1, also?: ModelChoice): RunEstimate & { run_budget_usd: number; run_high_usd: number } {
  const runs = repeatRuns(config, repeats, also);
  const each = runs.map((run) => estimateRun({ personas, settings: run.config.settings, audience: config.audience, pois: config.pois, comparison: config.comparison }));
  const sum = (pick: (estimate: RunEstimate) => number) => each.reduce((total, estimate) => total + pick(estimate), 0);
  return {
    calls: sum((e) => e.calls),
    cost_usd: [sum((e) => e.cost_usd[0]), sum((e) => e.cost_usd[1])],
    minutes: [sum((e) => e.minutes[0]), sum((e) => e.minutes[1])],
    unpriced: [...new Set(each.flatMap((e) => e.unpriced))],
    run_budget_usd: runs[0]!.config.settings.cost_budget_usd,
    run_high_usd: Math.max(...each.map((e) => e.cost_usd[1])),
  };
}

/** The preflight of tech.md §9.1 and §9.3 short of checking recorded logins: never production, every POI's own, personas current, keys present. Returns who runs. */
/** Every role a run of `config` calls a model for, as the Review step lists them. */
export function runRoles(config: ProjectConfig): LlmRole[] {
  const social = !config.comparison && socialRounds(config.settings, config.audience) > 0;
  return ['navigator', ...(social ? ['socialiser' as const] : []), 'judge', ...(config.comparison ? [] : ['author' as const])];
}

export function checkRun(store: ProjectStore, config: ProjectConfig, opts: { reset: boolean; fake: boolean; secrets: Secrets }): Persona[] {
  checkComparison(config);
  const refusal = preflight(config, (id) => { try { return existsSync(join(store.dir, assetPath(id))); } catch { return false; } });
  if (refusal) throw new Error(refusal);
  if (opts.reset && !webPois(effectiveComparisonPois(config)).some((poi) => poi.reset_hook_url)) throw new Error('This project has no reset hook for the configured access scope. Add one in the project settings, or start without resetting.');
  const personas = population(store, config);
  if (!personas.length) throw new Error('This audience has no personas yet. Generate them before starting a run.');
  const generatedCount = store.getGeneratedPersonaCount();
  if (config.audience && generatedCount !== null && generatedCount !== config.audience.persona_count) throw new Error('The persona count has changed. Generate personas again before starting a run.');
  if (config.persona_schema !== undefined) validatePersonaSchema(config.persona_schema);
  if (config.persona_schema && !config.audience) throw new Error('Create an audience and generate its personas before running a configured profile.');
  if (config.audience && personas.some((person) =>
    // Old projects had no writer-input signature; retain their saved profiles until a schema is configured.
    !(config.persona_schema === undefined && person.profile_signature === undefined) && !personaProfileIsCurrent(person, config),
  )) throw new Error('Profile inputs have changed. Generate personas again to refresh their biographies before starting a run.');
  // A missing key for any role the run calls would fail mid-run or quietly drop the report's analysis.
  const { routing, finding_check, check_model } = config.settings;
  const checker = finding_check && !config.comparison ? check_model : undefined; // its calls are the judge's, on a model of its own
  for (const [role, { provider }] of [...runRoles(config).map((role) => [role, routing[role]] as const), ...(checker ? [['judge', checker] as const] : [])]) {
    if (!opts.fake && !credential(provider, config.settings.local_base_url, opts.secrets)) throw new Error(provider === 'openai_compatible' ? 'Set the local model endpoint in the project settings first' : `Add ${KEYS[provider].label} key in Settings: the ${role} runs on it`);
  }
  return personas;
}

/** Starts a run of the personas checkRun returned, on a gateway that backs off when the run is throttled. */
export function launchRun(
  store: ProjectStore,
  config: ProjectConfig,
  run: { personas: Persona[]; sessions: SessionInfo[]; reset: boolean; pause_timeout_ms?: number; repeat?: RunConfig['repeat'] },
  deps: Omit<RunDeps, 'store' | 'llm'> & { fake: boolean; secrets: Secrets },
): RunHandle {
  let handle: RunHandle | undefined;
  const llm = projectGateway({ fake: deps.fake, secrets: deps.secrets, config, record: deps.record, onThrottle: (provider) => handle?.throttle(provider) });
  const base = newRunConfig(config, run);
  handle = startRun(store.createRun({ ...base, pause_timeout_ms: run.pause_timeout_ms ?? base.pause_timeout_ms }), { store, blobs: deps.blobs, browsers: deps.browsers, llm, record: deps.record, sessions: deps.sessions });
  return handle;
}
