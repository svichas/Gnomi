// Gnomi from a terminal, no app (tech.md §16.2): write an audience into a file, then run it against points of interest.
// The project work is the app's own (workspace.ts); provider keys come from the environment, e.g. ANTHROPIC_API_KEY.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultAudience, diversityReport, proposeAudience, syncPersonas } from './audience/index.ts';
import { readAudienceFile, writeAudienceFile, type AudienceFile } from './audience/file.ts';
import { audienceDeps, checkRun, KEYS, projectGateway, type Secrets } from './workspace.ts';
import { importLocalFile } from '@gnomi/simulation/assets.ts';
import { launchBrowserPool } from '@gnomi/simulation/browser/pool.ts';
import { createFsBlobStore } from '@gnomi/simulation/log/blobs.ts';
import { describe } from '@gnomi/simulation/log/describe.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { getPersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import { reportToMarkdown } from '@gnomi/simulation/report/markdown.ts';
import { createRecorder, newRunConfig, startRun, type RunHandle } from '@gnomi/simulation/run.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import type { BlobStore, BrowserPool, ProjectStore, Recorder } from '@gnomi/simulation/seams.ts';
import type { Persona, PersonaProgress, Poi, ProjectConfig, RunSettings } from '@gnomi/simulation/types.ts';

const USAGE = `Usage:
  node engine/src/cli.ts audience create --out <audience.json> --goal "<goal>" [--name <product>] [--product "<one sentence>"]
      [--pois <pois.json> | --url <url>] [--count <n>] [--propose] [--settings <settings.json>] [--fake-llm]
  node engine/src/cli.ts run (--pois <pois.json> | --url <url> [--allow host1,host2]) [--audience <audience.json>]
      [--goal "<goal>"] [--name <product>] [--product "<one sentence>"] [--project <dir>] [--settings <settings.json>] [--fake-llm] [--headed]

--pois is a JSON array of points of interest, as the app saves them. A text POI may give "path" instead of "asset", and a
design frame "path" instead of "asset": the file is imported. Ids, names and the web defaults are filled in when left out.
--settings is a JSON object of run settings (routing, rounds, budgets…) laid over the defaults.
Keys come from ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY or DEEPSEEK_API_KEY; --fake-llm calls no model.`;

const OPTIONS = {
  out: { type: 'string' },
  audience: { type: 'string' },
  pois: { type: 'string' },
  url: { type: 'string' },
  allow: { type: 'string', default: '' },
  goal: { type: 'string' },
  name: { type: 'string' },
  product: { type: 'string' },
  count: { type: 'string' },
  propose: { type: 'boolean', default: false },
  settings: { type: 'string' },
  project: { type: 'string' },
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
  const over = readJson(v.settings, 'Settings file');
  if (!over || typeof over !== 'object' || Array.isArray(over)) throw new Error(`Settings file ${v.settings} must hold a JSON object.`);
  return { ...DEFAULT_SETTINGS, ...over };
}

/** Fails early with the variable to set, rather than on the first model call. */
function requireKey(settings: RunSettings, role: 'navigator' | 'persona_writer', fake: boolean) {
  const { provider } = settings.routing[role];
  if (fake) return;
  if (provider === 'openai_compatible') {
    if (!settings.local_base_url) throw new Error('Set "local_base_url" in --settings for the local model the routing names.');
  } else if (!envSecrets(KEYS[provider].secret)) throw new Error(`Set ${KEYS[provider].secret.toUpperCase()} (the ${role} runs on ${provider}), or pass --fake-llm for a scripted run that calls no model.`);
}

function webPoi(raw: Record<string, unknown>, id: string): Poi {
  const start = URL.parse(String(raw.start_url ?? ''));
  if (!start || !/^https?:$/.test(start.protocol)) throw new Error(`Point of interest ${id}: "start_url" must be an http(s) URL.`);
  return { mode: 'full', name: start.host, allowed_hosts: [], production_domains: [], reset_hook_url: null, ...raw, id, segments: (raw.segments as string[] | null) ?? null, type: 'web', start_url: start.href } as Poi;
}

/** The POIs from --pois or --url; files named by "path" are imported into the project's assets/ folder. */
async function poisFrom(v: Values, blobs: BlobStore): Promise<Poi[]> {
  if (v.url) return [webPoi({ start_url: v.url, allowed_hosts: v.allow.split(',').map((h) => h.trim()).filter(Boolean) }, 'poi-1')];
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

function progressLine(): (progress: PersonaProgress) => void {
  let last = -1;
  return ({ done, total, recent }) => {
    if (done === last || !total) return;
    last = done;
    console.log(`personas ${done}/${total}${recent?.[0] ? `: ${recent[0]}` : ''}`);
  };
}

const timeline = (store: ProjectStore): Recorder => createRecorder(store, (e) => console.log(`#${e.seq} ${e.type} ${describe(e)}`.trimEnd()));

async function createAudienceFile(v: Values): Promise<void> {
  if (!v.out || !v.goal) throw new Error(`audience create needs --out and --goal.\n\n${USAGE}`);
  const count = v.count === undefined ? undefined : Number(v.count);
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 200)) throw new Error('--count must be a whole number from 1 to 200.');
  // Writing over an earlier audience file keeps every persona whose slot is unchanged; anything else there is never overwritten.
  const previous: AudienceFile | null = existsSync(v.out) ? readAudienceFile(v.out) : null;
  const settings = settingsFrom(v);
  requireKey(settings, 'persona_writer', v['fake-llm']);
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-audience-')); // drafts and setup calls only; the file is what is kept
  const store = openProject(dir);
  try {
    const pois = v.pois || v.url ? await poisFrom(v, createFsBlobStore(dir)) : [];
    const name = v.name ?? pois[0]?.name;
    if (!name) throw new Error('Name the product with --name, or pass its --pois or --url.');
    const schema = getPersonaSchema();
    const config: ProjectConfig = { name, description: v.product ?? '', pois, goal: v.goal, role: null, audience: null, settings, persona_schema: schema };
    store.saveProject(config);
    const llm = projectGateway({ fake: v['fake-llm'], secrets: envSecrets, config, record: timeline(store) });
    let cost = 0;
    let audience = defaultAudience(config);
    if (v.propose) {
      const proposed = await proposeAudience(audienceDeps(store, config, llm));
      audience = proposed.audience;
      cost += proposed.cost_usd;
      console.log(`Proposed ${audience.segments.length} segments: ${audience.segments.map((s) => `${s.name} (${s.share}%)`).join(', ')}`);
    }
    if (count) audience = { ...audience, persona_count: count };
    const { personas, cost_usd } = await syncPersonas(audience, previous?.personas ?? [], audienceDeps(store, { ...config, audience }, llm, { emit: progressLine() }));
    cost += cost_usd;
    writeAudienceFile(v.out, {
      id: previous?.id ?? randomUUID(),
      name: basename(v.out, extname(v.out)),
      savedAt: Date.now(),
      audience,
      schema,
      product: { name, description: config.description, goal: v.goal },
      personas,
    });
    const { warning } = diversityReport(personas);
    console.log(`${personas.length} personas in ${audience.segments.length} segments written to ${v.out} ($${cost.toFixed(4)})${warning ? `\n${warning}` : ''}`);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The file's personas where they are still current for this project; the rest are written again, not saved back. */
async function personasFor(file: AudienceFile, config: ProjectConfig, store: ProjectStore, record: Recorder, fake: boolean): Promise<Persona[]> {
  const llm = projectGateway({ fake, secrets: envSecrets, config, record });
  const { personas } = await syncPersonas(file.audience, file.personas, audienceDeps(store, config, llm, { emit: progressLine() }));
  const saved = new Map(file.personas.map((p) => [p.id, p.profile_signature]));
  const rewritten = personas.filter((p) => saved.get(p.id) !== p.profile_signature).length;
  if (rewritten) console.log(`${rewritten} of ${personas.length} personas were written again for this product. Run "audience create" with the same --name, --product and --goal to keep them in the file.`);
  store.replacePersonas(personas, file.audience.persona_count);
  return personas;
}

async function runSimulation(v: Values): Promise<void> {
  const file = v.audience ? readAudienceFile(v.audience) : null;
  if (file?.audience.segments.some((s) => s.role)) throw new Error('This audience logs in (a segment names a role). Recorded logins are only available in the app.');
  const goal = v.goal ?? file?.product.goal;
  if (!goal) throw new Error(`Pass --goal, or an --audience that names one.\n\n${USAGE}`);
  const fake = v['fake-llm'];
  const settings = settingsFrom(v);
  requireKey(settings, 'navigator', fake);
  const dir = resolve(v.project ?? join('gnomi-runs', new Date().toISOString().replace(/[:.]/g, '-')));
  const store = openProject(dir);
  const blobs = createFsBlobStore(dir);
  const launched: Promise<BrowserPool>[] = []; // at most one, launched on the first page a persona opens
  try {
    const pois = await poisFrom(v, blobs);
    const config: ProjectConfig = {
      name: v.name ?? file?.product.name ?? pois[0]!.name,
      description: v.product ?? file?.product.description ?? '',
      pois,
      goal,
      role: null,
      audience: file?.audience ?? null,
      settings,
      ...(file ? { persona_schema: file.schema } : {}),
    };
    store.saveProject(config);
    console.log(`Project folder: ${dir}`);
    const record = timeline(store);
    if (file) await personasFor(file, config, store, record, fake);
    const personas = checkRun(store, config, { reset: false, fake, secrets: envSecrets });
    let run: RunHandle | undefined;
    const llm = projectGateway({ fake, secrets: envSecrets, config, record, onThrottle: (provider) => run?.throttle(provider) });
    // Texts and designs are read from their files: a run where nobody opens a web app never launches a browser.
    const pool = () => (launched[0] ??= launchBrowserPool({ headless: !v.headed }));
    // Nobody can resume a blocked persona from a terminal, so a block ends their episode at once.
    const runConfig = store.createRun({ ...newRunConfig(config, { personas, sessions: [], reset: false }), pause_timeout_ms: 0 });
    run = startRun(runConfig, { store, blobs, browsers: { newPage: async (opts) => (await pool()).newPage(opts) }, llm, record, sessions: null });
    const started = run;
    process.once('SIGINT', () => {
      console.log('Stopping… (Ctrl-C again to quit at once)');
      started.stop();
      process.once('SIGINT', () => process.exit(130));
    });
    const markdown = reportToMarkdown(await started.done);
    const report = `runs/${started.run_id}/report`;
    await blobs.put(`${report}.md`, new TextEncoder().encode(markdown));
    console.log(`\n${markdown}`);
    console.log(`Report: ${join(dir, `${report}.json`)} and ${join(dir, `${report}.md`)}`);
  } finally {
    await launched[0]?.then((pool) => pool.close()).catch(() => {});
    store.close();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = args();
  const command = positionals.join(' ');
  if (command === 'audience create') return createAudienceFile(values);
  if (command === 'run') return runSimulation(values);
  throw new Error(USAGE);
}

// A finished or stopped run exits 0; only work that could not start or finish exits non-zero.
main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
