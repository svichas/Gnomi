// Gnomi from a terminal, no app (tech.md §16.2): write an audience into a file, then run it against points of interest.
// The project work is the app's own (workspace.ts); provider keys come from the environment, e.g. ANTHROPIC_API_KEY.
// With --json every stdout line is one JSON object and the last is the command's result, for agents (.claude/skills/gnomi/SKILL.md).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultAudience, diversityReport, MAX_PERSONAS, proposeAudience, syncPersonas } from './audience/index.ts';
import { readAudienceFile, writeAudienceFile, type AudienceFile } from './audience/file.ts';
import { audienceDeps, cappedGateway, checkRun, compareRuns, credential, estimateFor, finishedRun, KEYS, launchRun, projectGateway, repeatReports, repeatRuns, rerunProject, runPersonas, runRoles, runSet, type Secrets } from './workspace.ts';
import { importLocalFile } from '@gnomi/simulation/assets.ts';
import { launchBrowserPool } from '@gnomi/simulation/browser/pool.ts';
import { createFsBlobStore } from '@gnomi/simulation/log/blobs.ts';
import { isPriced } from '@gnomi/simulation/llm/prices.ts';
import { describe } from '@gnomi/simulation/log/describe.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { getPersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import { personaProfileIsCurrent } from '@gnomi/simulation/profile/signature.ts';
import { buildReport } from '@gnomi/simulation/report/build.ts';
import { gateDecision, type GateDecision } from '@gnomi/simulation/report/gate.ts';
import { diffToMarkdown, gateToMarkdown, reportToMarkdown, repeatsToMarkdown } from '@gnomi/simulation/report/markdown.ts';
import { runReportModels } from '@gnomi/simulation/report/models.ts';
import { combineReports, isTraitFree } from '@gnomi/simulation/report/repeats.ts';
import { createRecorder, roleOf, type RunHandle } from '@gnomi/simulation/run.ts';
import { DEFAULT_SETTINGS, PROVIDER_DEFAULTS, readsImages } from '@gnomi/simulation/settings.ts';
import type { BlobStore, BrowserPool, LlmGateway, ProjectStore, Recorder } from '@gnomi/simulation/seams.ts';
import type { Audience, GnomiEvent, ModelChoice, Persona, PersonaProgress, PersonaSchema, Poi, ProjectConfig, ProviderId, Report, RunConfig, RunEstimate, RunRow, RunSettings } from '@gnomi/simulation/types.ts';

const USAGE = `Usage (node engine/src/cli.ts, or npm run gnomi --):
  audience create --out <audience.json> --goal "<goal>" [--name <product>] [--product "<one sentence>"]
      [--pois <pois.json> | --url <url>] [--count <n>] [--propose] [--settings <settings.json>] [--fake-llm]
  audience update <audience.json> [--settings <settings.json>] [--fake-llm]
      writes the personas again where the file's audience or product was edited; the rest are kept
  personas <audience.json> [--id <persona id>]
  estimate (--pois <pois.json> | --url <url>) [--audience <audience.json>] [--goal "<goal>"] [--settings <settings.json>]
      [--repeats <n>] [--also-model <provider:model>] [--also-trait-free]
  estimate <project dir> --base <run id> [--repeats <n>]
      what rerun would cost, on that run's frozen settings and personas.
  run (--pois <pois.json> | --url <url> [--allow host1,host2]) [--audience <audience.json>] [--goal "<goal>"]
      [--name <product>] [--product "<one sentence>"] [--project <dir>] [--settings <settings.json>] [--fake-llm] [--headed]
      [--repeats <n>] [--also-model <provider:model>] [--also-trait-free]
      --repeats makes n runs one after another, each with its own report and its share of the cost budget. --also-model adds one
      more run with the navigator and socialiser on that model. --also-trait-free adds one more of the same personas with every
      trait stripped to their segment, which no count of the set includes: a finding it matches may say more about the model than
      the audience. It needs --audience, and takes a share of the budget. A run that stops ends the set.
  runs <project dir>
  report <project dir> [--run <run id> | --repeat <group>] [--format summary|md|json]
      --repeat compares the runs of a repeat set; each run keeps its own report.
  rerun <project dir> --base <run id> [--repeats <n>] [--url <poi id>=<url>]... [--fake-llm] [--headed]
      runs a finished run again with its frozen settings, personas and goal, under a new run id. --url gives a web point of interest
      a new address, such as a PR preview, and its host joins the allowed hosts. --repeats makes a set, as run does.
  compare <project dir> --base <run id> --run <run id>
      what changed between two runs; a run of a repeat set stands for that set's finished runs. No model calls. "Not seen again"
      means the later run did not show a problem, not that it is fixed.
  gate <project dir> --base <run id> --run <run id>
      for CI, from saved runs, with no model calls. A run stands for its repeat set, and each side needs 3 finished runs of one set.
      Exits 1 on a new theme of high severity (a severity that rounds to 3 or more of 4) in at least 2 later runs, 2 when it cannot
      decide, as when the sides differ in model, personas, goal or points of interest, and 0 otherwise. Exit 0 is no claim about real people.
  rejudge <project dir> [--run <run id>] [--budget <usd>] [--check] [--fake-llm]
      groups and names an ended run's themes again with the current judge, and writes their suggestions again; no browsing.
      It spends at most what is left of the run's cost budget, or --budget instead. --check also reviews the friction themes
      against their evidence, whatever the run's finding_check setting.
Every command takes --json: one JSON object per stdout line, the last being the result.

--pois is a JSON array of points of interest, as the app saves them. A text POI may give "path" instead of "asset", and a
design frame "path" instead of "asset": the file is imported. Ids, names and the web defaults are filled in when left out.
--settings is a JSON object of run settings (routing, rounds, budgets…) laid over the defaults.
Keys come from ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY or DEEPSEEK_API_KEY; --fake-llm calls no model.`;

const OPTIONS = {
  out: { type: 'string' },
  audience: { type: 'string' },
  pois: { type: 'string' },
  url: { type: 'string', multiple: true },
  allow: { type: 'string', default: '' },
  goal: { type: 'string' },
  name: { type: 'string' },
  product: { type: 'string' },
  count: { type: 'string' },
  propose: { type: 'boolean', default: false },
  settings: { type: 'string' },
  project: { type: 'string' },
  id: { type: 'string' },
  run: { type: 'string' },
  base: { type: 'string' },
  repeats: { type: 'string' },
  'also-model': { type: 'string' },
  'also-trait-free': { type: 'boolean', default: false },
  repeat: { type: 'string' },
  budget: { type: 'string' },
  check: { type: 'boolean', default: false },
  format: { type: 'string', default: 'summary' },
  json: { type: 'boolean', default: false },
  'fake-llm': { type: 'boolean', default: false },
  headed: { type: 'boolean', default: false },
} as const;

type Values = ReturnType<typeof args>['values'];

function args() {
  try {
    return parseArgs({ options: OPTIONS, allowPositionals: true });
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : err}\n\n${USAGE}`);
  }
}

let json = false;
/** One line of output: the text for a person, or the object for --json. */
const out = (text: string, line: Record<string, unknown>) => console.log(json ? JSON.stringify(line) : text);
const note = (text: string) => out(text, { kind: 'note', text });

// Only provider keys are read from the environment: logins and the Figma token stay app-only.
const envSecrets: Secrets = (name) => (Object.values(KEYS).some((key) => key.secret === name) ? process.env[name.toUpperCase()] || null : null);

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${what} ${path} could not be read: ${err instanceof Error ? err.message : err}`);
  }
}

function settingsFrom(v: Values): RunSettings {
  if (!v.settings) return DEFAULT_SETTINGS;
  const over = readJson(v.settings, 'Settings file') as Partial<RunSettings> | null;
  if (!over || typeof over !== 'object' || Array.isArray(over)) throw new Error(`Settings file ${v.settings} must hold a JSON object.`);
  // A routing that names some roles keeps the default model for the rest.
  const settings = { ...DEFAULT_SETTINGS, ...over, routing: { ...DEFAULT_SETTINGS.routing, ...over.routing } };
  const validate = (where: string, choice: ModelChoice) => {
    if (!Object.hasOwn(PROVIDER_DEFAULTS, choice?.provider) || typeof choice.model !== 'string') throw new Error(`Settings file ${v.settings}: "${where}" must be { "provider": "${Object.keys(PROVIDER_DEFAULTS).join('" | "')}", "model": "<model id>" }.`);
  };
  for (const [role, choice] of Object.entries(settings.routing)) validate(`routing.${role}`, choice);
  if (settings.check_model) validate('check_model', settings.check_model);
  return settings;
}

/** --also-model, refused before any run is paid for rather than on its run's first model call. */
function alsoModel(v: Values, settings: RunSettings): ModelChoice | undefined {
  const value = v['also-model'];
  if (value === undefined) return undefined;
  const colon = value.indexOf(':');
  const [provider, model] = [value.slice(0, colon), value.slice(colon + 1)];
  if (colon < 1 || !model || !Object.hasOwn(PROVIDER_DEFAULTS, provider)) throw new Error(`--also-model must be provider:model, with provider one of ${Object.keys(PROVIDER_DEFAULTS).join(', ')}.`);
  const choice = { provider: provider as ProviderId, model };
  if (!isPriced(choice)) throw new Error(`--also-model names ${model}, which has no price: the gateway would refuse it after the other runs have been paid for.`);
  // agent/loop.ts sends screenshots only to a navigator that reads images, so a problem only visible on screen would look like model bias.
  if (settings.screenshots && readsImages(choice) !== readsImages(settings.routing.navigator)) note(`Only ${readsImages(choice) ? `the ${model} run reads` : `the runs other than ${model} read`} screenshots, so the runs differ in images as well as model: a finding only one family produced may come from what it could see.`);
  return choice;
}

/** Fails early with the variable to set, rather than on the first model call. `choice` is for a call on the role's behalf that names its own model. */
function requireKey(settings: RunSettings, role: keyof RunSettings['routing'], fake: boolean, { provider } = settings.routing[role]) {
  if (fake || credential(provider, settings.local_base_url, envSecrets)) return;
  throw new Error(provider === 'openai_compatible'
    ? 'Set "local_base_url" in --settings for the local model the routing names.'
    : `Set ${KEYS[provider].secret.toUpperCase()} (the ${role} runs on ${provider}), or pass --fake-llm for a scripted run that calls no model.`);
}

function webPoi(raw: Record<string, unknown>, id: string): Poi {
  const start = URL.parse(String(raw.start_url ?? ''));
  if (!start || !/^https?:$/.test(start.protocol)) throw new Error(`Point of interest ${id}: "start_url" must be an http(s) URL.`);
  return { mode: 'full', name: start.host, allowed_hosts: [], production_domains: [], reset_hook_url: null, ...raw, id, segments: (raw.segments as string[] | null) ?? null, type: 'web', start_url: start.href } as Poi;
}

/** The POIs from --pois or --url; files named by "path" are imported into the project's assets/ folder. */
async function poisFrom(v: Values, blobs: BlobStore): Promise<Poi[]> {
  if (v.url) return [webPoi({ start_url: v.url.at(-1), allowed_hosts: v.allow.split(',').map((h) => h.trim()).filter(Boolean) }, 'poi-1')];
  if (!v.pois) throw new Error(`Pass --pois or --url.\n\n${USAGE}`);
  const list = readJson(v.pois, 'Points-of-interest file');
  if (!Array.isArray(list) || !list.length) throw new Error(`${v.pois} must hold a JSON array of points of interest.`);
  const base = dirname(resolve(v.pois));
  const imported = async (item: { asset?: unknown; path?: unknown }, where: string) => {
    if (typeof item.asset === 'string') return item.asset;
    if (typeof item.path !== 'string') throw new Error(`${where}: give "path" (a file to import) or "asset".`);
    return (await importLocalFile(blobs, resolve(base, item.path))).id;
  };
  const pois: Poi[] = [];
  for (const [i, raw] of list.entries()) {
    if (!raw || typeof raw !== 'object') throw new Error(`Point of interest ${i + 1} is not an object.`);
    const id = typeof raw.id === 'string' ? raw.id : `poi-${i + 1}`;
    const segments = raw.segments ?? null;
    if (raw.type === 'web') pois.push(webPoi(raw, id));
    else if (raw.type === 'text') {
      const name = raw.name ?? (typeof raw.path === 'string' ? basename(raw.path) : 'Text');
      pois.push({ id, type: 'text', name, segments, asset: await imported(raw, `Point of interest ${id}`) });
    } else if (raw.type === 'design') {
      if (!Array.isArray(raw.frames) || !raw.frames.length) throw new Error(`Point of interest ${id}: "frames" must list at least one frame.`);
      const frames = [];
      for (const [f, frame] of raw.frames.entries()) frames.push({ asset: await imported(frame ?? {}, `Point of interest ${id}, frame ${f + 1}`), name: frame?.name ?? null });
      pois.push({ id, type: 'design', name: raw.name ?? 'Design', segments, frames });
    } else throw new Error(`Point of interest ${id}: "type" must be "web", "text" or "design".`);
  }
  return pois;
}

/** The project a run or an estimate uses: flags first, then what the audience file was written for. */
function configFor(v: Values, file: AudienceFile | null, pois: Poi[], settings: RunSettings): ProjectConfig {
  if (file?.audience.segments.some((s) => s.role)) throw new Error('This audience logs in (a segment names a role). Recorded logins are only available in the app.');
  const goal = v.goal ?? file?.product.goal;
  if (!goal) throw new Error(`Pass --goal, or an --audience that names one.\n\n${USAGE}`);
  return {
    name: v.name ?? file?.product.name ?? pois[0]!.name,
    description: v.product ?? file?.product.description ?? '',
    pois,
    goal,
    role: null,
    audience: file?.audience ?? null,
    settings,
    ...(file ? { persona_schema: file.schema } : {}),
  };
}

/** The project an audience file's personas were written for, to check whether they are still current. */
const fileProject = (file: AudienceFile) => ({ ...file.product, pois: [], role: null, audience: file.audience, settings: DEFAULT_SETTINGS, persona_schema: file.schema });

function progressLine(): (progress: PersonaProgress) => void {
  let last = -1;
  return ({ done, total, recent }) => {
    if (done === last || !total) return;
    last = done;
    out(`personas ${done}/${total}${recent?.[0] ? `: ${recent[0]}` : ''}`, { kind: 'progress', done, total });
  };
}

const timeline = (store: ProjectStore): Recorder => createRecorder(store, (e) => {
  const text = describe(e);
  out(`#${e.seq} ${e.type} ${text}`.trimEnd(), { kind: 'event', seq: e.seq, type: e.type, persona_id: e.persona_id, poi_id: e.poi_id, text });
});

const estimateText = (e: RunEstimate) =>
  `about ${e.calls} model calls, $${e.cost_usd[0].toFixed(2)}–${e.cost_usd[1].toFixed(2)}${e.unpriced.length ? ` or more (no price for ${e.unpriced.join(', ')})` : ''}, ${Math.round(e.minutes[0])}–${Math.round(e.minutes[1])} min`;

const budgetText = (e: ReturnType<typeof estimateFor>, budget: number) =>
  `budget $${budget}${e.run_budget_usd < budget ? ` ($${e.run_budget_usd.toFixed(2)} a run, the dearest may cost $${e.run_high_usd.toFixed(2)})` : ''}`;

/** What an agent reads first: the outcome and each POI's top themes, without the evidence the full report carries. */
function summarize(report: Report) {
  return {
    run_id: report.run_id,
    status: report.status,
    stop_reason: report.stop_reason,
    goal: report.goal,
    personas: report.personas.length,
    completion: report.weighted.completion,
    with_friction: report.weighted.with_friction,
    frictions: report.frictions.length,
    set_aside: report.set_aside?.length ?? 0,
    pois: report.pois.map((poi) => ({
      id: poi.id,
      name: poi.name,
      themes: (report.themes ?? []).filter((t) => t.poi_id === poi.id).sort((a, b) => a.rank - b.rank).slice(0, 5)
        // A scan-only theme's prevalence of 0 is not a count of those who met it, so it gives none.
        .map((t) => ({ rank: t.rank, title: t.title, severity: t.severity, personas: t.scan_only ? null : t.prevalence?.personas ?? null, share: t.scan_only ? null : t.prevalence?.share ?? null, evidence: t.prevalence?.level ?? null, trust: t.trust, ...(t.scan_only && { scan_only: true }) })),
    })),
    sentiment: (report.sentiment ?? []).map(({ name, surveyed, sentiment, would_continue }) => ({ segment: name, surveyed, sentiment, would_continue })),
    cost_usd: report.cost_usd,
    duration_ms: report.duration_ms,
    banner: report.banner,
  };
}

/** How many personas were written rather than kept from before. */
function rewritten(before: Persona[], after: Persona[]): number {
  const kept = new Map(before.map((p) => [p.id, p.profile_signature]));
  return after.filter((p) => kept.get(p.id) !== p.profile_signature).length;
}

/** Drafts and setup calls of persona writing go to a throwaway project; the audience file is what is kept. */
async function inTempProject<T>(work: (store: ProjectStore, blobs: BlobStore) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-'));
  const store = openProject(dir);
  try {
    return await work(store, createFsBlobStore(dir));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Brings the personas in line with the audience, keeping every unchanged slot's persona, and writes the file. */
async function writeAudience(path: string, previous: AudienceFile | null, config: ProjectConfig & { audience: Audience; persona_schema: PersonaSchema }, store: ProjectStore, llm: LlmGateway, spent: number) {
  const { audience, persona_schema: schema } = config;
  const { personas, cost_usd } = await syncPersonas(audience, previous?.personas ?? [], audienceDeps(store, config, llm, { emit: progressLine() }));
  writeAudienceFile(path, {
    id: previous?.id ?? randomUUID(),
    name: previous?.name ?? basename(path, extname(path)),
    savedAt: Date.now(),
    audience,
    schema,
    product: { name: config.name, description: config.description, goal: config.goal },
    personas,
  });
  const written = rewritten(previous?.personas ?? [], personas);
  const cost = spent + cost_usd;
  const { warning } = diversityReport(personas);
  out(
    `${personas.length} personas in ${audience.segments.length} segments (${written} written) saved to ${path} ($${cost.toFixed(4)})${warning ? `\n${warning}` : ''}`,
    { kind: 'audience', file: resolve(path), personas: personas.length, written, segments: audience.segments.length, cost_usd: cost, diversity_warning: warning },
  );
}

async function createAudienceFile(v: Values): Promise<void> {
  if (!v.out || !v.goal) throw new Error(`audience create needs --out and --goal.\n\n${USAGE}`);
  const { out: path } = v;
  const count = v.count === undefined ? undefined : Number(v.count);
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > MAX_PERSONAS)) throw new Error(`--count must be a whole number from 1 to ${MAX_PERSONAS}.`);
  // Writing over an earlier audience file keeps every persona whose slot is unchanged; anything else there is never overwritten.
  const previous: AudienceFile | null = existsSync(path) ? readAudienceFile(path) : null;
  const settings = settingsFrom(v);
  requireKey(settings, 'persona_writer', v['fake-llm']);
  await inTempProject(async (store, blobs) => {
    const pois = v.pois || v.url ? await poisFrom(v, blobs) : [];
    if (!(v.name ?? pois[0]?.name)) throw new Error('Name the product with --name, or pass its --pois or --url.');
    const persona_schema = getPersonaSchema();
    const config: ProjectConfig = { ...configFor(v, null, pois, settings), persona_schema };
    store.saveProject(config);
    const llm = projectGateway({ fake: v['fake-llm'], secrets: envSecrets, config, record: timeline(store) });
    let spent = 0;
    let audience = defaultAudience(config);
    if (v.propose) {
      const proposed = await proposeAudience(audienceDeps(store, config, llm));
      audience = proposed.audience;
      spent = proposed.cost_usd;
      note(`Proposed ${audience.segments.length} segments: ${audience.segments.map((s) => `${s.name} (${s.share}%)`).join(', ')}`);
    }
    if (count) audience = { ...audience, persona_count: count };
    await writeAudience(path, previous, { ...config, audience, persona_schema }, store, llm, spent);
  });
}

async function updateAudienceFile(v: Values, path: string | undefined): Promise<void> {
  if (!path) throw new Error(`audience update needs the audience file.\n\n${USAGE}`);
  const file = readAudienceFile(path);
  const { persona_count } = file.audience;
  if (!Number.isInteger(persona_count) || persona_count < 1 || persona_count > MAX_PERSONAS) throw new Error(`${path}: "persona_count" must be a whole number from 1 to ${MAX_PERSONAS}.`);
  const settings = settingsFrom(v);
  requireKey(settings, 'persona_writer', v['fake-llm']);
  await inTempProject(async (store) => {
    const config = { ...fileProject(file), settings };
    store.saveProject(config);
    const llm = projectGateway({ fake: v['fake-llm'], secrets: envSecrets, config, record: timeline(store) });
    await writeAudience(path, file, config, store, llm, 0);
  });
}

function listPersonas(v: Values, path: string | undefined): void {
  if (!path) throw new Error(`personas needs the audience file.\n\n${USAGE}`);
  const file = readAudienceFile(path);
  const project = fileProject(file);
  const segments = new Map(file.audience.segments.map((s) => [s.id, s.name]));
  if (v.id) {
    const persona = file.personas.find((p) => p.id === v.id);
    if (!persona) throw new Error(`There is no persona ${v.id} in ${path}.`);
    const line = { kind: 'persona', ...persona, segment: segments.get(persona.segment_id!) ?? null, current: personaProfileIsCurrent(persona, project) };
    console.log(json ? JSON.stringify(line) : JSON.stringify(line, null, 2));
    return;
  }
  const rows = file.personas.map((p) => ({
    id: p.id, name: p.name, segment: segments.get(p.segment_id!) ?? null, job_title: p.job_title, device: p.device, country: p.country ?? null,
    tech_skill: p.tech_skill, patience: p.patience, current: personaProfileIsCurrent(p, project),
  }));
  for (const r of rows) out(`${r.id}  ${r.name}, ${r.job_title} (${r.segment}): ${r.device}${r.country ? `, ${r.country}` : ''}, tech ${r.tech_skill}/5, patience ${r.patience}/5${r.current ? '' : ', stale'}`, { kind: 'persona', ...r });
  const stale = rows.filter((r) => !r.current).length;
  out(`${rows.length} personas, ${stale} stale, written for "${file.product.goal}" on ${file.product.name}`, { kind: 'personas', file: resolve(path), personas: rows.length, stale });
}

/** What `rerun` would cost: the project may have moved on since, so only what the run froze counts. */
function estimateRerun(v: Values, dir: string | undefined): void {
  const store = existingProject(dir);
  try {
    const from = finishedRun(store, v.base!);
    const { config } = rerunProject(from);
    const repeats = Number(v.repeats ?? 1);
    const e = estimateFor(config, from.personas, repeats);
    const budget = config.settings.cost_budget_usd;
    out(`${from.personas.length} personas${repeats > 1 ? `, ${repeats} runs` : ''}: ${estimateText(e)}; ${budgetText(e, budget)}`, { kind: 'estimate', personas: from.personas.length, runs: repeats, stale: 0, ...e, budget_usd: budget });
  } finally {
    store.close();
  }
}

async function estimate(v: Values): Promise<void> {
  const file = v.audience ? readAudienceFile(v.audience) : null;
  const settings = settingsFrom(v);
  await inTempProject(async (_store, blobs) => {
    const config = configFor(v, file, await poisFrom(v, blobs), settings);
    const personas = file?.personas ?? [BUILTIN_PERSONA];
    const stale = file ? personas.filter((p) => !personaProfileIsCurrent(p, config)).length : 0;
    const repeats = Number(v.repeats ?? 1);
    const also = alsoModel(v, settings);
    const e = estimateFor(config, personas, repeats, also, v['also-trait-free']);
    const runs = repeats + (also ? 1 : 0) + (v['also-trait-free'] ? 1 : 0);
    out(
      `${personas.length} personas${runs > 1 ? `, ${runs} runs` : ''}: ${estimateText(e)}; ${budgetText(e, settings.cost_budget_usd)}${stale ? `. ${stale} personas would be written again first, which this leaves out` : ''}`,
      { kind: 'estimate', personas: personas.length, runs, stale, ...e, budget_usd: settings.cost_budget_usd },
    );
  });
}

/** Fails before anything is written or paid for, naming the variable to set. */
function requireKeys(planned: ReturnType<typeof repeatRuns>, settings: RunSettings, fake: boolean) {
  for (const run of planned) for (const role of runRoles(run.config)) requireKey(run.config.settings, role, fake);
  if (settings.finding_check) requireKey(settings, 'judge', fake, settings.check_model);
}

/** Runs what was planned, one after another: each writes its report files and prints its result, and a set ends with its comparison. */
async function runPlanned(dir: string, store: ProjectStore, record: Recorder, planned: ReturnType<typeof repeatRuns>, personas: Persona[], v: Values, from?: RunConfig): Promise<void> {
  const blobs = createFsBlobStore(dir);
  const launched: Promise<BrowserPool>[] = []; // at most one, launched on the first page a persona opens
  try {
    // Texts and designs are read from their files: a run where nobody opens a web app never launches a browser.
    const pool = () => (launched[0] ??= launchBrowserPool({ headless: !v.headed }));
    let started: RunHandle;
    let stopping = false; // a run that has logged its end cannot stop any more, but its set still can
    process.once('SIGINT', () => {
      note('Stopping… (Ctrl-C again to quit at once)');
      stopping = true;
      started.stop();
      process.once('SIGINT', () => process.exit(130));
    });
    const reports = await runSet(planned, async (run) => {
      // Nobody can resume a blocked persona from a terminal, so a block ends their episode at once.
      started = launchRun(store, run.config, { personas: runPersonas(run, personas), sessions: [], reset: false, pause_timeout_ms: 0, repeat: run.repeat, from }, {
        blobs, record, browsers: { newPage: async (opts) => (await pool()).newPage(opts) }, sessions: null, fake: v['fake-llm'], secrets: envSecrets,
      });
      const report = await started.done;
      const markdown = reportToMarkdown(report);
      const path = `runs/${started.run_id}/report`;
      await blobs.put(`${path}.md`, new TextEncoder().encode(markdown));
      const [report_json, report_md] = [join(dir, `${path}.json`), join(dir, `${path}.md`)];
      out(`\n${markdown}\nReport: ${report_json} and ${report_md}`, {
        kind: 'run', project: dir, run_id: started.run_id, status: report.status, stop_reason: report.stop_reason, cost_usd: report.cost_usd,
        duration_ms: report.duration_ms, report_json, report_md, summary: summarize(report),
      });
      return report;
    }, () => stopping);
    if (planned.length > 1) {
      const set = combineReports(reports);
      out(`\n${repeatsToMarkdown(set)}`, { kind: 'repeats', project: dir, run_ids: reports.map((report) => report.run_id), ...set });
    }
  } finally {
    await launched[0]?.then((pool) => pool.close()).catch(() => {});
  }
}

async function runSimulation(v: Values): Promise<void> {
  const file = v.audience ? readAudienceFile(v.audience) : null;
  const fake = v['fake-llm'];
  const settings = settingsFrom(v);
  requireKey(settings, 'navigator', fake);
  const dir = resolve(v.project ?? join('gnomi-runs', new Date().toISOString().replace(/[:.]/g, '-')));
  const store = openProject(dir);
  const blobs = createFsBlobStore(dir);
  try {
    const config = configFor(v, file, await poisFrom(v, blobs), settings);
    const [repeats, also] = [Number(v.repeats ?? 1), alsoModel(v, settings)];
    const planned = repeatRuns(config, repeats, also, v['also-trait-free']);
    // Before any persona is written again, which costs model calls; checkRun repeats this with the app's wording.
    requireKeys(planned, settings, fake);
    store.saveProject(config);
    note(`Project folder: ${dir}`);
    const record = timeline(store);
    if (file) {
      const llm = projectGateway({ fake, secrets: envSecrets, config, record });
      const { personas } = await syncPersonas(file.audience, file.personas, audienceDeps(store, config, llm, { emit: progressLine() }));
      const again = rewritten(file.personas, personas);
      // Not saved back: the file stays what it was written for.
      if (again) note(`${again} of ${personas.length} personas were written again for this product. Run "audience create" with the same --name, --product and --goal to keep them in the file.`);
      store.replacePersonas(personas, file.audience.persona_count);
    }
    const personas = planned.map((run) => checkRun(store, run.config, { reset: false, fake, secrets: envSecrets }))[0]!;
    const estimated = estimateFor(config, personas, repeats, also, v['also-trait-free']);
    note(`Estimate for ${personas.length} personas${planned.length > 1 ? ` in ${planned.length} runs` : ''}: ${estimateText(estimated)}; ${budgetText(estimated, settings.cost_budget_usd)}`);
    await runPlanned(dir, store, record, planned, personas, v);
  } finally {
    store.close();
  }
}

/** --url poi_id=url, as many as there are POIs to move. */
function urlsFrom(v: Values): Record<string, string> {
  return Object.fromEntries((v.url ?? []).map((pair) => {
    const equals = pair.indexOf('=');
    if (equals < 1) throw new Error(`--url must be <poi id>=<url>, not "${pair}".`);
    return [pair.slice(0, equals), pair.slice(equals + 1)];
  }));
}

/** A finished run again on its frozen config and personas, with run's guards: every key before anything starts, the estimate, the budget. */
async function rerun(v: Values, dir: string | undefined): Promise<void> {
  if (!v.base) throw new Error(`rerun needs --base <run id>.\n\n${USAGE}`);
  if (v['also-trait-free']) throw new Error('--also-trait-free is for run: rerun repeats what a run froze.');
  const fake = v['fake-llm'];
  // Beside an app that may have a run live: this leaves it running, and refuses to start a second one.
  const store = existingProject(dir, { recover: false });
  try {
    const from = finishedRun(store, v.base);
    const { config } = rerunProject(from, urlsFrom(v));
    if (from.personas.some((persona) => roleOf(persona, config) !== null)) throw new Error(`${v.base} logs in, and recorded logins are only available in the app.`);
    const repeats = Number(v.repeats ?? 1);
    const planned = repeatRuns(config, repeats);
    requireKeys(planned, config.settings, fake);
    const active = store.listRuns().find((run) => run.status === 'running');
    if (active) throw new Error(`${active.run_id} is still running in this project, so another run cannot start. If its process was killed, opening the project in the app clears it.`);
    const personas = planned.map((run) => checkRun(store, run.config, { reset: false, fake, secrets: envSecrets, personas: from.personas }))[0]!;
    const estimated = estimateFor(config, personas, repeats);
    note(`Estimate for ${personas.length} personas${planned.length > 1 ? ` in ${planned.length} runs` : ''}: ${estimateText(estimated)}; ${budgetText(estimated, config.settings.cost_budget_usd)}`);
    await runPlanned(resolve(dir!), store, timeline(store), planned, personas, v, from);
  } finally {
    store.close();
  }
}

/** A project folder the CLI or the app wrote, read-only by default: its run may still be live in the app or another CLI. */
function existingProject(dir: string | undefined, options: Parameters<typeof openProject>[1] = { readOnly: true }): ProjectStore {
  if (!dir) throw new Error(`Name the project folder.\n\n${USAGE}`);
  if (!existsSync(join(dir, 'project.sqlite'))) throw new Error(`${dir} is not a Gnomi project folder.`);
  return openProject(dir, options);
}

function listRuns(dir: string | undefined): void {
  const store = existingProject(dir);
  try {
    const runs = store.listRuns().map((r) => ({ run_id: r.run_id, status: r.status, stop_reason: r.stop_reason, cost_usd: r.cost_usd, started_at: new Date(r.started_at).toISOString(), goal: r.config.project.goal, repeat: r.config.repeat ?? null }));
    for (const r of runs) out(`${r.run_id}  ${r.status}${r.stop_reason ? ` (${r.stop_reason})` : ''}, $${r.cost_usd.toFixed(4)}, ${r.started_at}: "${r.goal}"${r.repeat ? `, repeat ${r.repeat.index} of ${r.repeat.of} in set ${r.repeat.group}${isTraitFree(r) ? ', with no persona traits' : ''}` : ''}`, { kind: 'run_row', ...r });
    out(`${runs.length} run${runs.length === 1 ? '' : 's'} in ${resolve(dir!)}, newest first`, { kind: 'runs', project: resolve(dir!), runs: runs.length });
  } finally {
    store.close();
  }
}

/** --run, or the newest run. */
function pickRun(store: ProjectStore, v: Values, dir: string | undefined): RunRow {
  const runs = store.listRuns(); // newest first
  const run = v.run ? runs.find((r) => r.run_id === v.run) : runs[0];
  if (!run) throw new Error(v.run ? `There is no run ${v.run} in ${dir}.` : `${dir} has no runs yet.`);
  return run;
}

function showReport(v: Values, dir: string | undefined): void {
  if (!['summary', 'md', 'json'].includes(v.format)) throw new Error('--format is summary, md or json.');
  const store = existingProject(dir);
  try {
    if (v.repeat) {
      const reports = repeatReports(store, v.repeat);
      if (!reports.length) throw new Error(`There is no repeat set ${v.repeat} in ${dir}.`);
      const set = combineReports(reports);
      if (v.format === 'md') return void console.log(repeatsToMarkdown(set));
      return void console.log(json ? JSON.stringify({ kind: 'repeats', ...set }) : JSON.stringify(set, null, 2));
    }
    const run = pickRun(store, v, dir);
    const report = buildReport(store.events(run.run_id));
    if (v.format === 'md') return void console.log(reportToMarkdown(report, run.config.repeat && combineReports(repeatReports(store, run.config.repeat.group))));
    const body = v.format === 'json' ? report : summarize(report);
    console.log(json ? JSON.stringify({ kind: 'report', format: v.format, report: body }) : JSON.stringify(body, null, 2));
  } finally {
    store.close();
  }
}

function compare(v: Values, dir: string | undefined): void {
  if (!v.base || !v.run) throw new Error(`compare needs --base and --run.\n\n${USAGE}`);
  const store = existingProject(dir);
  try {
    const diff = compareRuns(store, v.base, v.run);
    out(diffToMarkdown(diff), { kind: 'compare', ...diff });
  } finally {
    store.close();
  }
}

/** What a CI job reads. Whatever else stops a gate, such as a bad flag or an unknown run, is 2 as well: a job must never read that as a new theme. */
const GATE_EXIT: Record<GateDecision['decision'], number> = { passed: 0, failed: 1, could_not_decide: 2 };

function gate(v: Values, dir: string | undefined): void {
  let decision: GateDecision;
  try {
    if (!dir || !v.base || !v.run) throw new Error('gate needs the project folder, --base and --run.');
    const store = existingProject(dir);
    try {
      decision = gateDecision(compareRuns(store, v.base, v.run));
    } finally {
      store.close();
    }
  } catch (err) {
    decision = { decision: 'could_not_decide', base: [], run: [], failing: [], warnings: [], reasons: [err instanceof Error ? err.message : String(err)] };
  }
  out(gateToMarkdown(decision), { kind: 'gate', ...decision });
  process.exitCode = GATE_EXIT[decision.decision];
}

/** Runs an ended run's judge, its evidence check when on or asked for, and its author again with the current prompts and the run's own models, without browsing; the report uses the newest answer. */
async function rejudge(v: Values, dir: string | undefined): Promise<void> {
  // Writes the judge's new events, beside a run the app may have live.
  const store = existingProject(dir, { recover: false });
  try {
    const { run_id, config } = pickRun(store, v, dir);
    // From the log, not the row: a crashed run's row may still say running.
    if (store.events(run_id, { types: ['run.finished', 'run.stopped'], limit: 1 }).length === 0) throw new Error(`${run_id} has not ended: it is still running, or it was interrupted before its report.`);
    if (config.project.comparison) throw new Error(`${run_id} is a comparison study, which has no judge to run again.`);
    const settings = config.project.settings;
    if (!settings?.routing) throw new Error(`${run_id} predates per-run model settings, so it cannot be judged again.`);
    const fake = v['fake-llm'];
    if (fake && store.events(run_id, { types: ['llm.call'] }).some((e) => e.type === 'llm.call' && e.payload.provider !== 'scripted')) throw new Error(`${run_id} was analysed by real models; --fake-llm would replace their answers with scripted ones.`);
    requireKey(settings, 'judge', fake);
    requireKey(settings, 'author', fake);
    const checking = v.check || settings.finding_check;
    if (checking) requireKey(settings, 'judge', fake, settings.check_model);
    const events = () => store.events(run_id);
    const log = events();
    const [before, round] = [log.length, log.at(-1)?.round ?? 1];
    const spent = (from: GnomiEvent[]) => from.reduce((sum, e) => sum + (e.type === 'llm.call' ? e.payload.cost_usd : 0), 0);
    // What is left of the run's cost budget, unless --budget says what this rejudge may spend.
    const budget = v.budget === undefined ? settings.cost_budget_usd - spent(log) : Number(v.budget);
    if (!(budget > 0)) throw new Error(v.budget === undefined ? `${run_id} has spent its $${settings.cost_budget_usd.toFixed(2)} budget; pass --budget <usd> to let rejudge spend more.` : '--budget must be a positive amount in dollars.');
    const record = timeline(store);
    const stop = new AbortController();
    process.once('SIGINT', () => {
      note('Stopping… (Ctrl-C again to quit at once)');
      stop.abort();
      process.once('SIGINT', () => process.exit(130));
    });
    const path = `runs/${run_id}/report`;
    const blobs = createFsBlobStore(dir!);
    let report: Report;
    try {
      await runReportModels({ config, round, llm: cappedGateway(projectGateway({ fake, secrets: envSecrets, config: config.project, record }), budget, stop.signal), blobs, record, events, check: v.check });
    } finally {
      // Written even when the judge failed or was stopped: the author's new suggestions are in the log, and the files are snapshots of it.
      report = buildReport(events());
      await blobs.put(`${path}.json`, new TextEncoder().encode(JSON.stringify(report, null, 2)));
      await blobs.put(`${path}.md`, new TextEncoder().encode(reportToMarkdown(report)));
      store.setRunCost(run_id, report.cost_usd);
      // As a run ends: an app with this run open reloads its report.
      record({ run_id, round, persona_id: null, poi_id: null, type: 'report.generated', payload: { path: `${path}.json`, friction_count: report.frictions.length } });
    }
    const added = events().slice(before);
    const cost_usd = spent(added);
    if (cost_usd >= budget) note(`This rejudge reached its $${budget.toFixed(2)} budget, so it made no more model calls.`);
    const pois = (type: 'report.themes' | 'report.checks' | 'report.suggestions') => new Set(added.flatMap((e) => (e.type === type ? [e.payload.poi_id] : [])));
    const asked = added.flatMap((e) => (e.type === 'report.started' ? e.payload.pois : []));
    const [answered, checked, suggested] = [pois('report.themes'), pois('report.checks'), pois('report.suggestions')];
    const missing = asked.filter((poi) => !answered.has(poi));
    if (missing.length > 0 && missing.length < asked.length) note(`The judge gave no valid answer for ${missing.join(', ')}, which keeps its earlier themes.`);
    const unchecked = asked.filter((poi) => !checked.has(poi) && report.themes?.some((t) => t.poi_id === poi && t.category !== 'objection'));
    if (checking && unchecked.length > 0) note(`The evidence check gave no verdict for ${unchecked.join(', ')}, so its themes stay as they were judged.`);
    const unsuggested = [...answered].filter((poi) => !suggested.has(poi));
    if (unsuggested.length > 0) note(`The author gave no suggested changes for ${unsuggested.join(', ')}, so its new themes have none.`);
    const themes = report.themes?.length ?? 0;
    const [report_json, report_md] = [resolve(dir!, `${path}.json`), resolve(dir!, `${path}.md`)];
    out(`${run_id} judged again: ${themes} themes ($${cost_usd.toFixed(4)})`, { kind: 'rejudge', run_id, themes, cost_usd, report_json, report_md, summary: summarize(report) });
    if (missing.length > 0 && missing.length === asked.length) throw new Error(`The judge gave no valid answer, so ${run_id} keeps its earlier themes; their suggestions were written again.`);
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = args();
  json = values.json;
  const [command, sub, target] = positionals;
  if (command === 'audience' && sub === 'create') return createAudienceFile(values);
  if (command === 'audience' && sub === 'update') return updateAudienceFile(values, target);
  if (command === 'personas') return listPersonas(values, sub);
  if (command === 'estimate') return values.base ? estimateRerun(values, sub) : estimate(values);
  if (command === 'run') return runSimulation(values);
  if (command === 'runs') return listRuns(sub);
  if (command === 'report') return showReport(values, sub);
  if (command === 'rejudge') return rejudge(values, sub);
  if (command === 'rerun') return rerun(values, sub);
  if (command === 'compare') return compare(values, sub);
  if (command === 'gate') return gate(values, sub);
  throw new Error(USAGE);
}

// A finished or stopped run exits 0; only work that could not start or finish exits non-zero.
main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = process.argv.slice(2).find((arg) => !arg.startsWith('-')) === 'gate' ? GATE_EXIT.could_not_decide : 1;
});
