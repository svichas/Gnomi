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
import { loginPoi, webPois, withPois } from '@gnomi/simulation/poi/pois.ts';
import { validatePersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import { personaProfileIsCurrent } from '@gnomi/simulation/profile/signature.ts';
import { buildReport } from '@gnomi/simulation/report/build.ts';
import { diffReports, type ReportDiff } from '@gnomi/simulation/report/diff.ts';
import { reportToMarkdown, studyPlanToMarkdown } from '@gnomi/simulation/report/markdown.ts';
import { competitorsOf, isCalendarDate, localDate, NOTE_MAX, runStudyPlan, topFindings } from '@gnomi/simulation/report/study.ts';
import { newRunConfig, startRun, type RunDeps, type RunHandle } from '@gnomi/simulation/run.ts';
import type { BlobStore, LlmGateway, ProjectStore, Recorder, SecretName } from '@gnomi/simulation/seams.ts';
import { socialRounds } from '@gnomi/simulation/settings.ts';
import { STUDY_STATUSES } from '@gnomi/simulation/types.ts';
import type { LlmRole, ModelChoice, Persona, PersonaProgress, ProjectConfig, ProviderId, Report, RunConfig, RunEstimate, RunRow, RunSettings, SessionInfo, StudyStatus } from '@gnomi/simulation/types.ts';

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
          // A free attempt reaches no cap, not even the $0 a local model's estimate gives, so its retry still runs.
          if (attempt.payload.cost_usd > 0 && spent >= cap) reached.abort(new Error(`The $${cap.toFixed(2)} budget was reached`));
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

/** A run's report. A crash logs no end, so only the row says such a run is over. */
function rowReport(store: ProjectStore, run: RunRow): Report {
  const report = buildReport(store.events(run.run_id));
  return run.status === 'interrupted' ? { ...report, status: 'stopped' } : report;
}

/** The reports of a set's runs so far, in the order they ran. */
export const repeatReports = (store: ProjectStore, group: string): Report[] => store.listRuns()
  .filter((run) => run.config.repeat?.group === group)
  .sort((a, b) => a.config.repeat!.index - b.config.repeat!.index)
  .map((run) => rowReport(store, run));

/** One side of a comparison: the run, or the finished runs of its set, as a stopped run missing a theme says nothing about it. */
function comparedSide(store: ProjectStore, run_id: string): Report[] {
  const run = store.listRuns().find((row) => row.run_id === run_id);
  if (!run) throw new Error(`There is no run ${run_id} in this project.`);
  if (run.status === 'running') throw new Error(`${run_id} is still running, so there is nothing to compare yet.`);
  if (run.config.project.comparison) throw new Error(`${run_id} is a comparison study, which compares tools rather than builds.`);
  const group = run.config.repeat?.group;
  const finished = group ? repeatReports(store, group).filter((report) => report.status === 'finished') : [];
  return finished.length ? finished : [rowReport(store, run)];
}

/** What changed from `base` to `run`, computed when read. */
export function compareRuns(store: ProjectStore, base: string, run: string): ReportDiff {
  const [before, after] = [comparedSide(store, base), comparedSide(store, run)];
  if (before.some((a) => after.some((b) => a.run_id === b.run_id))) throw new Error(`${base} and ${run} are one run or one repeat set: compare two separate runs.`);
  return diffReports(before, after);
}

/** What a change to an ended run writes to. */
export type RunPlace = { store: ProjectStore; blobs: BlobStore; record: Recorder };

/** A run that work after its end may touch. From the log, not the row: a crashed run's row may still say running. Comparison studies have no themes to act on. */
export function endedRun(store: ProjectStore, run_id: string): RunRow {
  const run = store.listRuns().find((row) => row.run_id === run_id);
  if (!run) throw new Error(`There is no run ${run_id} in this project.`);
  if (store.events(run_id, { types: ['run.finished', 'run.stopped'], limit: 1 }).length === 0) throw new Error(`${run_id} has not ended: it is still running, or it was interrupted before its report.`);
  if (run.config.project.comparison) throw new Error(`${run_id} is a comparison study, which has no themes to act on.`);
  return run;
}

/** The run an ended run's model work starts from, with its own frozen models. Scripted answers never replace a real model's. */
export function modelRun(store: ProjectStore, run_id: string, fake: boolean, doing: string): RunRow {
  const run = endedRun(store, run_id);
  if (!run.config.project.settings?.routing) throw new Error(`${run_id} predates per-run model settings, so it cannot be ${doing}.`);
  if (fake && store.events(run_id, { types: ['llm.call'] }).some((e) => e.type === 'llm.call' && e.payload.provider !== 'scripted')) throw new Error(`${run_id} was analysed by real models; --fake-llm would replace their answers with scripted ones.`);
  return run;
}

/** After any change to an ended run: its report files are snapshots of the log, its row counts what the log does, and an app with the run open reloads, as when a run ends. */
export async function rewriteReport({ store, blobs, record }: RunPlace, run_id: string): Promise<Report> {
  endedRun(store, run_id);
  const log = store.events(run_id);
  const report = buildReport(log);
  const path = `runs/${run_id}/report`;
  await blobs.put(`${path}.json`, new TextEncoder().encode(JSON.stringify(report, null, 2)));
  await blobs.put(`${path}.md`, new TextEncoder().encode(reportToMarkdown(report)));
  store.setRunCost(run_id, report.cost_usd);
  record({ run_id, round: log.at(-1)?.round ?? 1, persona_id: null, poi_id: null, type: 'report.generated', payload: { path: `${path}.json`, friction_count: report.frictions.length } });
  return report;
}

/** A study plan for an ended run: one author call, then the report again. A failed call adds no plan, so an earlier one stays. */
export async function planStudy(place: RunPlace, { run_id, config }: RunRow, llm: LlmGateway): Promise<Report> {
  const { store, blobs, record } = place;
  const log = store.events(run_id);
  const before = buildReport(log);
  if (!topFindings(before.themes ?? [], competitorsOf(before)).length) throw new Error(`${run_id} has no friction finding of your own product to plan a study for.`);
  let report: Report;
  try {
    await runStudyPlan({ config, report: before, round: log.at(-1)?.round ?? 1, llm, record });
  } finally {
    // Written even when the call failed: a failed attempt can still cost money, and the files are snapshots of the log.
    report = await rewriteReport(place, run_id);
  }
  await blobs.put(`runs/${run_id}/study-plan.md`, new TextEncoder().encode(studyPlanToMarkdown(report, report.study_plan!)));
  return report;
}

export interface StudyOutcome {
  run_id: string;
  theme_id: string;
  status: StudyStatus;
  study_date: string; // YYYY-MM-DD
  note?: string | null;
}

/** Records what a team's own study found, for a finding as it stands now. No model is involved. */
export async function recordOutcome(place: RunPlace, { run_id, theme_id, status, study_date, note }: StudyOutcome, now = new Date()): Promise<Report> {
  const { store, record } = place;
  endedRun(store, run_id);
  if (!STUDY_STATUSES.includes(status)) throw new Error(`The status must be ${STUDY_STATUSES.join(', ')}, not "${status}".`);
  if (!isCalendarDate(study_date)) throw new Error(`The study date must be a real date as YYYY-MM-DD, not "${study_date}".`);
  if (study_date > localDate(now)) throw new Error(`The study date ${study_date} is in the future.`);
  const text = note?.trim() || null;
  if (text && text.length > NOTE_MAX) throw new Error(`The note has ${text.length} characters, and the limit is ${NOTE_MAX}.`);
  const log = store.events(run_id);
  const { themes = [], set_aside = [] } = buildReport(log);
  const theme = [...themes, ...set_aside].find((t) => t.id === theme_id);
  if (!theme) throw new Error(`${run_id} has no finding "${theme_id}".`);
  record({ run_id, round: log.at(-1)?.round ?? 1, persona_id: null, poi_id: theme.poi_id, type: 'finding.validated', payload: { keys: theme.keys ?? [], category: theme.category, title: theme.title, status, note: text, study_date } });
  return rewriteReport(place, run_id);
}

/** A finished run's frozen config, to run it again; a run cut short is not a baseline to repeat. */
export function finishedRun(store: ProjectStore, run_id: string): RunConfig {
  const run = store.listRuns().find((row) => row.run_id === run_id);
  if (!run) throw new Error(`There is no run ${run_id} in this project.`);
  if (run.status !== 'finished') throw new Error(`${run_id} is ${run.status}, and only a finished run can be run again.`);
  return run.config;
}

/** `url` on the old address's origin, moved to the new one; anywhere else it stays. */
function moved(url: string, from: string, to: string): string {
  const [at, old, next] = [URL.parse(url), URL.parse(from), URL.parse(to)];
  return at && old && next && at.origin === old.origin ? `${next.origin}${at.pathname}${at.search}${at.hash}` : url;
}

/**
 * What a run frozen in `from` runs again on. `urls` gives web POIs a new address by id, as a PR preview or a restarted Gym has another:
 * the new host joins the POI's allowed hosts, its reset hook moves with it, and `loginUrl` moves a recorded login's start page, which
 * would otherwise take logged-in personas back to the old build. A bad address is refused by the same preflight as any other.
 * A run of a set holds its share of the budget, so the budget goes back to the whole, for repeatRuns to share out.
 */
export function rerunProject(from: RunConfig, urls: Record<string, string> = {}): { config: ProjectConfig; loginUrl: (url: string) => string } {
  const project: ProjectConfig = withPois(from.project);
  if (!project.settings?.routing) throw new Error(`${from.run_id} predates per-run model settings, so it cannot be run again.`);
  const web = webPois(project.pois);
  const stray = Object.keys(urls).find((id) => !web.some((poi) => poi.id === id));
  if (stray) throw new Error(`${from.run_id} has no web point of interest "${stray}"; it has ${web.map((poi) => `"${poi.id}"`).join(', ') || 'none'}.`);
  if (project.comparison && Object.keys(urls).length) throw new Error(`${from.run_id} is a comparison study: change a tool's address in its setup.`);
  const pois = project.pois.map((poi) => {
    if (poi.type !== 'web' || urls[poi.id] === undefined) return poi;
    const url = urls[poi.id];
    const host = URL.parse(url)?.hostname;
    return { ...poi, start_url: url, allowed_hosts: host ? [...new Set([...poi.allowed_hosts, host])] : poi.allowed_hosts, reset_hook_url: poi.reset_hook_url && moved(poi.reset_hook_url, poi.start_url, url) };
  });
  const login = loginPoi(project.pois);
  const to = login && urls[login.id];
  return {
    config: { ...project, pois, settings: { ...project.settings, cost_budget_usd: project.settings.cost_budget_usd * (from.repeat?.of ?? 1) } },
    loginUrl: (url) => (to ? moved(url, login.start_url, to) : url),
  };
}

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

export function checkRun(store: ProjectStore, config: ProjectConfig, opts: { reset: boolean; fake: boolean; secrets: Secrets; personas?: Persona[] }): Persona[] {
  checkComparison(config);
  const refusal = preflight(config, (id) => { try { return existsSync(join(store.dir, assetPath(id))); } catch { return false; } });
  if (refusal) throw new Error(refusal);
  if (opts.reset && !webPois(effectiveComparisonPois(config)).some((poi) => poi.reset_hook_url)) throw new Error('This project has no reset hook for the configured access scope. Add one in the project settings, or start without resetting.');
  const personas = opts.personas ?? population(store, config);
  if (!personas.length) throw new Error('This audience has no personas yet. Generate them before starting a run.');
  if (!opts.personas) { // a rerun's frozen personas are what it repeats: the project's audience may have moved on
    const generatedCount = store.getGeneratedPersonaCount();
    if (config.audience && generatedCount !== null && generatedCount !== config.audience.persona_count) throw new Error('The persona count has changed. Generate personas again before starting a run.');
    if (config.persona_schema !== undefined) validatePersonaSchema(config.persona_schema);
    if (config.persona_schema && !config.audience) throw new Error('Create an audience and generate its personas before running a configured profile.');
    if (config.audience && personas.some((person) =>
      // Old projects had no writer-input signature; retain their saved profiles until a schema is configured.
      !(config.persona_schema === undefined && person.profile_signature === undefined) && !personaProfileIsCurrent(person, config),
    )) throw new Error('Profile inputs have changed. Generate personas again to refresh their biographies before starting a run.');
  }
  // A missing key for any role the run calls would fail mid-run or quietly drop the report's analysis.
  const { routing, finding_check, check_model } = config.settings;
  const checker = finding_check && !config.comparison ? check_model : undefined; // its calls are the judge's, on a model of its own
  if (!opts.fake) for (const [role, choice] of [...runRoles(config).map((role) => [role, routing[role]] as const), ...(checker ? [['judge', checker] as const] : [])]) requireCredential(config.settings, role, choice, opts.secrets);
  return personas;
}

/** The app's wording for a role's missing key; the CLI names the variable to set instead. */
export function requireCredential(settings: RunSettings, role: LlmRole, { provider }: ModelChoice, secrets: Secrets) {
  if (!credential(provider, settings.local_base_url, secrets)) throw new Error(provider === 'openai_compatible' ? 'Set the local model endpoint in the project settings first' : `Add ${KEYS[provider].label} key in Settings: the ${role} runs on it`);
}

/** Starts a run of the personas checkRun returned, on a gateway that backs off when the run is throttled. */
export function launchRun(
  store: ProjectStore,
  config: ProjectConfig,
  run: { personas: Persona[]; sessions: SessionInfo[]; reset: boolean; pause_timeout_ms?: number; repeat?: RunConfig['repeat']; from?: RunConfig },
  deps: Omit<RunDeps, 'store' | 'llm'> & { fake: boolean; secrets: Secrets },
): RunHandle {
  let handle: RunHandle | undefined;
  const llm = projectGateway({ fake: deps.fake, secrets: deps.secrets, config, record: deps.record, onThrottle: (provider) => handle?.throttle(provider) });
  const base = newRunConfig(config, run);
  // A rerun keeps what the run froze: a run without an audience draws a new seed otherwise, and the signal defaults may have moved.
  const frozen = run.from ? { seed: run.from.seed, ...(run.from.signals ? { signals: run.from.signals } : {}) } : {};
  handle = startRun(store.createRun({ ...base, ...frozen, pause_timeout_ms: run.pause_timeout_ms ?? base.pause_timeout_ms }), { store, blobs: deps.blobs, browsers: deps.browsers, llm, record: deps.record, sessions: deps.sessions });
  return handle;
}
