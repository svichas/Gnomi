// Engine entry inside Electron's utilityProcess. No Electron imports (the engine stays a plain Node
// library, tech.md §16.2): the parent port is a global on `process`, and main hands over one
// MessagePort per extra client. Main and the renderer both speak protocol.ts.
import { addPersona, diversityReport, proposeAudience, regeneratePersona, syncPersonas, type AudienceDeps } from './audience/index.ts';
import { validateCountries } from '@gnomi/simulation/audience/locations.ts';
import { comparisonSessionPois, comparisonSessionTarget } from './comparison-sessions.ts';
import { resolve } from 'node:path';
import { runKey, SessionRuns } from './session-runs.ts';
import { assetMime, assetPath, importLocalFile, importText } from '@gnomi/simulation/assets.ts';
import { launchBrowserPool } from '@gnomi/simulation/browser/pool.ts';
import { testProviderKey } from '@gnomi/simulation/llm/gateway.ts';
import { figmaClient } from './figma/client.ts';
import { fakeFigma } from './figma/fake.ts';
import { importFrames, listFrames, previews } from './figma/frames.ts';
import { createFsBlobStore } from '@gnomi/simulation/log/blobs.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { browses, loginPoi, webPois } from '@gnomi/simulation/poi/pois.ts';
import { validatePersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import { audienceDeps, checkComparison, checkRun, credential, estimateFor, launchRun, population, projectGateway, repeatReports, repeatRuns, runSet } from './workspace.ts';
import { buildReport } from '@gnomi/simulation/report/build.ts';
import { combineReports } from '@gnomi/simulation/report/repeats.ts';
import { createRecorder, roleOf, segmentOf, type RunHandle } from '@gnomi/simulation/run.ts';
import { allowedHosts, checkTarget } from '@gnomi/simulation/safety.ts';
import { createSessionStore, ROLE } from './sessions.ts';
import type { Api, ClientToEngine, EngineToClient, Method, ProjectInfo, Transport } from './protocol.ts';
import type { BlobStore, BrowserPool, LoginRecording, ProjectStore, Recorder, SecretName, SessionStore } from '@gnomi/simulation/seams.ts';
import type { Audience, Persona, PersonaProgress, ProjectConfig, SessionInfo } from '@gnomi/simulation/types.ts';

interface PortLike {
  on(event: 'message', listener: (e: { data: unknown; ports: PortLike[] }) => void): void;
  on(event: 'close', listener: () => void): void;
  postMessage(message: unknown): void;
  start?(): void;
}

// GNOMI_FAKE_LLM=1 runs scripted personas and a scripted persona writer with no key and no cost, for UI smoke tests and demos.
const FAKE_LLM = process.env.GNOMI_FAKE_LLM === '1';

// GNOMI_FAKE_FIGMA=1 answers Figma requests from a fixture file (engine/src/figma/fake.ts): no token, no network. Any other
// value is that fixture's options as JSON, e.g. '{"nullRender":["1:5"]}' for a frame Figma cannot render.
const fakeFigmaApi = process.env.GNOMI_FAKE_FIGMA ? fakeFigma(process.env.GNOMI_FAKE_FIGMA === '1' ? {} : JSON.parse(process.env.GNOMI_FAKE_FIGMA)) : undefined;
const figma = () => figmaClient({ token: secrets.get('figma_token') ?? null, fetch: fakeFigmaApi });

const clients = new Set<Transport>();
const secrets = new Map<SecretName, string>();
const runs = new Map<string, RunHandle>();
const sets = new Map<string, LiveSet>(); // by project dir: a repeat set from its first run's start to its last's end, gaps included
let closing = false; // no repeat starts once shutdown has begun
type OpenProject = { store: ProjectStore; blobs: BlobStore; record: Recorder };
type LiveSet = { group: string; stopped: boolean; done?: Promise<unknown> };
// Only a selected project or one with a live run keeps its database open.
const projects = new Map<string, OpenProject>();
const sessionRuns = new SessionRuns((run) => broadcast({ kind: 'session_run', run }));
let projectRequests = 0; // includes awaited persona writes and run preflight, before a RunHandle exists
let open: OpenProject | null = null;
let browsers: Promise<BrowserPool> | null = null;
let sessions: SessionStore | null = null; // while a project is open and main has sent the session key
let recording: { role: string; target_id?: string; rec: Promise<LoginRecording> } | null = null; // one login recording at a time
let setupTask: { stop: AbortController; done: Promise<unknown> } | null = null;

function noSetup(doing: string) {
  if (setupTask) throw new Error(`Wait for persona generation to finish before ${doing}.`);
}

function writeSetup<T>(work: () => Promise<T>): Promise<T> {
  if (setupTask || hasRun(current().store.dir)) return Promise.reject(new Error('Wait for the current generation or run to finish.'));
  const stop = new AbortController();
  const done = Promise.resolve().then(work).finally(() => { setupTask = null; });
  setupTask = { stop, done };
  return done;
}

function current() {
  if (!open) throw new Error('No project is open');
  return open;
}

function project(): ProjectConfig {
  const config = current().store.getProject();
  if (!config) throw new Error('Set up the project first');
  return config;
}

function unlockedSessions(held = sessions): SessionStore {
  if (!held) throw new Error('Recorded logins are locked: the app has not sent the session key yet. Restart Gnomi.');
  return held;
}

function refreshSessions() {
  const key = secrets.get('session_key');
  sessions = open && key ? createSessionStore(open.store, open.blobs, key) : null;
}

function pool(): Promise<BrowserPool> {
  browsers ??= launchBrowserPool().catch((err) => {
    browsers = null;
    throw err;
  });
  return browsers;
}

const secret = (name: SecretName) => secrets.get(name) ?? null;

function withAudience(): { config: ProjectConfig; audience: Audience } {
  const config = project();
  if (!config.audience) throw new Error('Set up the audience first');
  return { config, audience: config.audience };
}

function writer(config: ProjectConfig, emit?: (progress: PersonaProgress) => void): AudienceDeps {
  return audienceDeps(current().store, config, projectGateway({ fake: FAKE_LLM, secrets: secret, config, record: current().record }), { signal: setupTask?.stop.signal, emit });
}

function persona(id: string): { people: Persona[]; persona: Persona } {
  const people = current().store.listPersonas();
  const found = people.find((p) => p.id === id);
  if (!found) throw new Error(`There is no persona ${id} in this project`);
  return { people, persona: found };
}

/** The POI a login is recorded on; projects without a web POI in full mode have no logins to record. */
function recordingPoi(config: ProjectConfig) {
  const poi = loginPoi(config.pois);
  if (!poi) throw new Error('Add a web app as a point of interest to record a login on.');
  return poi;
}

/** What a run needs of its project. A repeat set keeps it, as the app may have moved to another project by the next repeat. */
const here = () => ({ ...current(), sessions });

/** Loads the role's start page with its session under containment (tech.md §9.1) and marks it verified when it held. */
async function verify(config: ProjectConfig, role: string, place = here()) {
  const store = unlockedSessions(place.sessions);
  const saved = await store.load(role);
  if (!saved) throw new Error(`No login is recorded for "${role}" yet. Record it first.`);
  // The login POI's hosts first; the session's cookies go to every web POI in full mode, so any of their hosts may be reached.
  const pois = config.comparison
    ? comparisonSessionPois(config, comparisonSessionTarget(config, saved.info), role)
    : [recordingPoi(config), ...webPois(config.pois).filter((poi) => poi.mode === 'full')];
  const result = await (await pool()).checkSession({
    storageState: saved.state,
    startUrl: saved.info.start_url,
    allowedHosts: [...new Set(pois.flatMap(allowedHosts))],
    blockedDomains: [...new Set(pois.flatMap((poi) => poi.production_domains))],
  });
  const now = Date.now();
  if (result.ok) store.markVerified(role, now);
  const info = result.ok ? { ...saved.info, verified_at: now } : config.comparison ? { ...saved.info, verified_at: null } : saved.info;
  if (!result.ok && config.comparison) place.store.putSession(info);
  return { result, info };
}

function readInfo(store: ProjectStore, unlocked: boolean): ProjectInfo {
  const config = store.getProject();
  if (config?.persona_schema !== undefined) validatePersonaSchema(config.persona_schema);
  const personas = store.listPersonas();
  return {
    dir: store.dir,
    project: config,
    persona: BUILTIN_PERSONA,
    personas,
    generated_persona_count: store.getGeneratedPersonaCount(),
    diversity: personas.length ? diversityReport(personas) : null,
    runs: store.listRuns(),
    sessions: unlocked ? store.listSessions() : [],
    setup_calls: store.listSetupCalls(),
  };
}

const info = () => readInfo(current().store, sessions !== null);

/** Lets the process exit: runs stop, the recorder and the browsers close, the project closes. Main sends it before quitting. */
async function shutdown() {
  closing = true;
  setupTask?.stop.abort(new Error('App is closing. Completed drafts are saved.'));
  await setupTask?.done.catch(() => {});
  for (const run of runs.values()) run.stop();
  await Promise.allSettled([...[...runs.values()].map((run) => run.done), ...[...sets.values()].map((set) => set.done)]);
  const pending = recording;
  recording = null;
  await pending?.rec.then((rec) => rec.cancel()).catch(() => {});
  const launched = browsers;
  browsers = null;
  await launched?.then((pool) => pool.close()).catch(() => {});
  for (const project of projects.values()) project.store.close();
  projects.clear();
  open = null;
  sessions = null;
}

function broadcast(msg: EngineToClient) {
  for (const client of clients) client.send(msg);
}

function canSwitchProject() {
  if (recording) throw new Error('Save or cancel the login recording before switching projects');
  if (projectRequests) throw new Error('Wait for the current project task to finish before switching projects');
}

function hasRun(dir: string) {
  return sets.has(dir) || [...runs.keys()].some((key) => JSON.parse(key)[0] === dir);
}

function releaseProject(project: OpenProject | null) {
  if (!project || hasRun(project.store.dir)) return;
  project.store.close();
  projects.delete(project.store.dir);
}

const handlers: { [M in Method]: (params: Api[M]['params']) => Api[M]['result'] | Promise<Api[M]['result']> } = {
  set_secret({ name, value }) {
    if (value) secrets.set(name, value);
    else secrets.delete(name);
    if (name === 'session_key') refreshSessions();
    return null;
  },
  open_project({ dir, project_id }) {
    canSwitchProject();
    dir = resolve(dir);
    const existing = projects.get(dir);
    if (existing) {
      const loaded = readInfo(existing.store, secrets.has('session_key'));
      if (open !== existing) releaseProject(open);
      open = existing;
      refreshSessions();
      return loaded;
    }
    // Validate/open first: a bad destination must not leave the current project with a closed database.
    const store = openProject(dir);
    let loaded: ProjectInfo;
    try { loaded = readInfo(store, secrets.has('session_key')); } catch (error) {
      store.close();
      throw error;
    }
    releaseProject(open);
    open = { store, blobs: createFsBlobStore(dir), record: createRecorder(store, (event) => {
      sessionRuns.record(dir, event, project_id);
      broadcast({ kind: 'event', event, project_dir: dir });
    }) };
    projects.set(dir, open);
    refreshSessions();
    return loaded;
  },
  close_project({ dir }) {
    canSwitchProject();
    const target = dir ? resolve(dir) : open?.store.dir;
    if (target && hasRun(target)) throw new Error('Stop the project’s run before changing its folder.');
    releaseProject(open);
    open = null;
    sessions = null;
    return null;
  },
  get_session_runs: () => sessionRuns.list(),
  get_project: () => info(),
  save_project({ project }) {
    noSetup('saving project changes');
    validateCountries(project.audience?.countries);
    if (project.persona_schema !== undefined) validatePersonaSchema(project.persona_schema);
    checkComparison(project);
    current().store.saveProject(project);
    return null;
  },
  async test_key({ provider }) {
    const key = credential(provider, open?.store.getProject()?.settings.local_base_url, secret);
    if (!key) return { ok: false, error: provider === 'openai_compatible' ? 'Set the local model endpoint in the project settings first' : 'No key saved' };
    const result = await testProviderKey(provider, key);
    return result.ok ? { ok: true, error: null } : { ok: false, error: result.error };
  },
  async figma_test() {
    try {
      await figma().check();
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  figma_frames: ({ link }) => listFrames(figma(), link),
  figma_previews: (params) => previews(figma(), params),
  figma_import: (params) => importFrames(figma(), current().blobs, params),
  propose_audience: () => writeSetup(() => proposeAudience(writer(project()))),
  generate_personas: () => writeSetup(async () => {
    const { config, audience } = withAudience();
    const progress = (value: PersonaProgress) => broadcast({ kind: 'progress', task: 'generate_personas', ...value });
    const { personas, cost_usd } = await syncPersonas(audience, current().store.listPersonas(), writer(config, progress));
    current().store.replacePersonas(personas, audience.persona_count);
    current().store.clearPersonaDrafts();
    return { personas, diversity: diversityReport(personas), cost_usd };
  }),
  regenerate_persona: ({ id }) => writeSetup(async () => {
    const { config, audience } = withAudience();
    const { people, persona: old } = persona(id);
    const result = await regeneratePersona(old, audience, people, writer(config));
    current().store.putPersona(result.persona);
    return result;
  }),
  add_persona: ({ segment_id }) => writeSetup(async () => {
    const { config, audience } = withAudience();
    const result = await addPersona(segment_id, audience, current().store.listPersonas(), writer(config));
    current().store.putPersona(result.persona);
    return result;
  }),
  remove_persona({ id }) {
    noSetup('editing personas');
    persona(id);
    current().store.deletePersona(id);
    return null;
  },
  edit_persona({ persona: edited }) {
    noSetup('editing personas');
    // Only the written fields change: the sampled traits are what keep the population honest (tech.md §2.4).
    const { persona: old } = persona(edited.id);
    const { name, job_title, background, context_of_use, goal_interpretation, voice } = edited;
    current().store.putPersona({ ...old, name, job_title, background, context_of_use, goal_interpretation, voice });
    return null;
  },
  estimate_run({ repeats }) {
    const config = project();
    return estimateFor(config, population(current().store, config), repeats);
  },
  async start_run({ reset, repeats }) {
    noSetup('starting a run');
    const place = here();
    const { store, blobs, record, sessions: held } = place;
    const planned = repeatRuns(project(), repeats); // frozen, as personas are, against edits made while a set runs
    const { config } = planned[0];
    if (hasRun(store.dir)) throw new Error('A run is already in progress in this project');
    const personas = checkRun(store, config, { reset, fake: FAKE_LLM, secrets: secret });
    const prepare = async () => {
      // Never with a login that no longer works (tech.md §9.1).
      const verified: SessionInfo[] = [];
      if (config.comparison) {
        const roles = new Set(config.comparison.targets.flatMap((target) => target.session_role ? [target.session_role] : []));
        // Missing or expired test access limits only the affected comparison episodes.
        for (const session of (held?.list() ?? []).filter((session) => roles.has(session.role))) {
          try { verified.push((await verify(config, session.role, place)).info); }
          catch { verified.push({ ...session, verified_at: null }); }
        }
      } else for (const role of new Set(personas.map((p) => roleOf(p, config)).filter((r) => r !== null))) {
        const checked = await verify(config, role, place);
        if (!checked.result.ok) throw new Error(`The recorded "${role}" login no longer works (${checked.result.reason ?? `it ended on ${checked.result.url}`}). Re-record it, then start again.`);
        verified.push(checked.info);
      }
      // Texts and designs are read from their files: a run where nobody opens a web app never launches a browser.
      const browserPool: Pick<BrowserPool, 'newPage'> = personas.some((p) => browses(config.pois, segmentOf(p, config)))
        ? await pool()
        : { newPage: async (opts) => (await pool()).newPage(opts) };
      return { verified, browserPool };
    };
    const launch = (run: typeof planned[number], { verified, browserPool }: Awaited<ReturnType<typeof prepare>>) => {
      const started = launchRun(store, run.config, { personas, sessions: verified, reset, repeat: run.repeat }, { blobs, record, browsers: browserPool, sessions: held, fake: FAKE_LLM, secrets: secret });
      const key = runKey(store.dir, started.run_id);
      runs.set(key, started);
      started.done.catch(() => sessionRuns.fail(store.dir, started.run_id)).finally(() => {
        runs.delete(key);
        if (open?.store !== store) releaseProject(projects.get(store.dir) ?? null);
      });
      return started;
    };
    const ready = await prepare();
    if (hasRun(store.dir)) throw new Error('A run is already in progress in this project'); // recheck after preflight
    noSetup('starting a run');
    const started = launch(planned[0], ready);
    if (planned.length > 1) {
      const set: LiveSet = { group: planned[0].repeat!.group, stopped: false };
      const over = () => closing || set.stopped;
      sets.set(store.dir, set);
      set.done = runSet(planned, async (run, index) => {
        if (index === 0) return started.done;
        const next = await prepare();
        if (over()) throw new Error('The repeat set is over.'); // a stop can land while the next run prepares
        return launch(run, next).done;
      }, over).catch((err) => {
        if (!over()) broadcast({ kind: 'repeat_failed', error: err instanceof Error ? err.message : String(err) });
      }).finally(() => {
        sets.delete(store.dir);
        if (open?.store !== store) releaseProject(projects.get(store.dir) ?? null);
      });
    }
    return { run_id: started.run_id };
  },
  stop_run({ run_id, project_dir }) {
    const dir = project_dir ? resolve(project_dir) : current().store.dir;
    runs.get(runKey(dir, run_id))?.stop();
    const set = sets.get(dir); // a run that has logged its end cannot stop any more, but its set still can
    if (set) set.stopped = true;
    return null;
  },
  async record_session({ role, target_id }) {
    const config = project();
    // The session store's rule for role names, checked before the human spends time logging in.
    if (!ROLE.test(role)) throw new Error('Name the role with 1–40 lowercase letters, digits, "-" or "_", for example "recruiter"');
    unlockedSessions(); // before opening a browser whose login could not be saved
    // Never record a production login: the session would be as sensitive as the password.
    if (config.comparison && !target_id) throw new Error('Record each comparison login from that tool’s setup.');
    const poi = target_id ? comparisonSessionPois(config, target_id, role)[0]! : recordingPoi(config);
    const refusal = checkTarget(poi);
    if (refusal) throw new Error(refusal);
    if (recording) throw new Error('A login recording is already open: save or cancel it first');
    const rec = pool().then((p) => p.record(poi.start_url, { headless: false }));
    recording = { role, rec, ...(target_id ? { target_id } : {}) };
    try {
      await rec;
    } catch (err) {
      recording = null;
      throw err;
    }
    return null;
  },
  async save_session() {
    const store = unlockedSessions();
    if (!recording) throw new Error('No login recording is open');
    const { role, rec, target_id } = recording;
    recording = null;
    const login = await (await rec).finish();
    const now = Date.now();
    const saved: SessionInfo = { role, start_url: login.start_url, hosts: login.hosts, recorded_at: now, verified_at: now, expires_at: login.expires_at, ...(target_id ? { target_id } : {}) };
    await store.save(saved, login.storageState);
    return saved;
  },
  async cancel_recording() {
    const pending = recording;
    recording = null;
    if (pending) await (await pending.rec).cancel();
    return null;
  },
  async check_session({ role }) {
    return (await verify(project(), role)).result;
  },
  resume_personas({ run_id, persona_ids }) {
    for (const id of persona_ids) runs.get(runKey(current().store.dir, run_id))?.resume(id);
    return null;
  },
  get_events: ({ run_id, after_seq, persona_id }) =>
    current().store.events(run_id, {
      ...(after_seq === null ? {} : { afterSeq: after_seq }),
      ...(persona_id === null ? {} : { personaId: persona_id }),
    }),
  get_report: ({ run_id }) => buildReport(current().store.events(run_id)),
  get_repeats({ group }) {
    const { store } = current();
    const set = sets.get(store.dir);
    return combineReports(repeatReports(store, group), set?.group === group && !set.stopped);
  },
  import_asset: (params) => ('path' in params ? importLocalFile(current().blobs, params.path) : importText(current().blobs, params.text, params.name)),
  async get_blob({ path }) {
    // The renderer only ever needs run evidence and POI assets; recorded logins under sessions/ stay out of its reach even encrypted.
    const asset = path.startsWith('assets/') ? path.slice('assets/'.length) : null;
    if ((asset === null && !path.startsWith('runs/')) || path.split(/[\\/]/).includes('..')) throw new Error('Only files from a run or a point of interest can be opened');
    const data = await current().blobs.get(asset === null ? path : assetPath(asset));
    return { mime: asset === null ? 'image/jpeg' : assetMime(asset), base64: Buffer.from(data).toString('base64') };
  },
};

// Main picks the project and holds the secrets; the renderer's port may not.
const MAIN_ONLY: Method[] = ['open_project', 'close_project', 'set_secret'];

function serve(transport: Transport, main: boolean) {
  transport.onMessage(async (msg) => {
    if (msg?.kind !== 'request') return;
    const projectTask = !['open_project', 'close_project', 'set_secret', 'get_session_runs', 'figma_test', 'figma_frames', 'figma_previews'].includes(msg.method);
    if (projectTask) projectRequests++;
    try {
      if (!main && MAIN_ONLY.includes(msg.method)) throw new Error(`${msg.method} is for the app's main process only`);
      const handler = handlers[msg.method] as (params: unknown) => unknown;
      transport.send({ kind: 'response', id: msg.id, ok: true, result: await handler(msg.params) });
    } catch (err) {
      transport.send({ kind: 'response', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (projectTask) projectRequests--;
    }
  });
}

function servePort(port: PortLike) {
  const transport: Transport = {
    send: (msg) => port.postMessage(msg),
    onMessage: (handler) => port.on('message', (e) => handler(e.data as ClientToEngine)),
  };
  serve(transport, false);
  // Events go to the renderer's ports only: main reads nothing but its responses.
  clients.add(transport);
  port.on('close', () => clients.delete(transport));
  port.start?.();
}

const parentPort = (process as unknown as { parentPort?: PortLike }).parentPort;
if (!parentPort) throw new Error('host.ts runs inside an Electron utilityProcess; from a terminal use cli.ts');

// Main is a client over the parent port; { kind: 'connect' } hands over ports for other clients (the renderer), and
// { kind: 'shutdown' } closes the browsers and the project so the process can exit without orphaned Chromes.
serve({
  send: (msg) => parentPort.postMessage(msg),
  onMessage: (handler) =>
    parentPort.on('message', (e) => {
      const data = e.data as { kind?: string };
      if (data?.kind === 'connect') e.ports.forEach(servePort);
      // Electron keeps a utility process alive while its parent port is open, so exit once everything is closed
      // rather than make every quit wait for main's kill fallback. Plain Node (the host tests) exits by itself.
      else if (data?.kind === 'shutdown') void shutdown().then(() => process.versions.electron && process.exit(0));
      else handler(data as ClientToEngine);
    }),
}, true);
