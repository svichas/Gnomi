// Engine entry inside Electron's utilityProcess. No Electron imports (the engine stays a plain Node
// library, tech.md §16.2): the parent port is a global on `process`, and main hands over one
// MessagePort per extra client. Main and the renderer both speak protocol.ts.
import { addPersona, DEMO_PERSONA_WRITER, diversityReport, proposeAudience, regeneratePersona, syncPersonas, type AudienceDeps } from './audience/index.ts';
import { validateCountries } from './audience/locations.ts';
import { randomUUID } from 'node:crypto';
import { assetMime, assetPath, importLocalFile, importText } from './assets.ts';
import { launchBrowserPool } from './browser/pool.ts';
import { estimateRun } from './llm/estimate.ts';
import { createGateway, testProviderKey } from './llm/gateway.ts';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, DEMO_NAVIGATOR, DEMO_SOCIALISER } from './llm/scripted.ts';
import { createFsBlobStore } from './log/blobs.ts';
import { openProject } from './log/sqlite.ts';
import { BUILTIN_PERSONA } from './persona.ts';
import { preflight } from './poi/index.ts';
import { loginPoi, webPois } from './poi/pois.ts';
import { validatePersonaSchema } from './profile/schema.ts';
import { personaProfileIsCurrent } from './profile/signature.ts';
import { buildReport } from './report/build.ts';
import { createRecorder, newRunConfig, roleOf, startRun, type RunHandle } from './run.ts';
import { allowedHosts, checkTarget } from './safety.ts';
import { createSessionStore, ROLE } from './sessions.ts';
import type { Api, ClientToEngine, EngineToClient, Method, ProjectInfo } from './protocol.ts';
import type { BlobStore, BrowserPool, LlmGateway, LoginRecording, ProjectStore, Recorder, SecretName, SessionStore, Transport } from './seams.ts';
import type { Audience, Persona, PersonaProgress, ProjectConfig, ProviderId, SessionInfo } from './types.ts';

interface PortLike {
  on(event: 'message', listener: (e: { data: unknown; ports: PortLike[] }) => void): void;
  on(event: 'close', listener: () => void): void;
  postMessage(message: unknown): void;
  start?(): void;
}

// GNOMI_FAKE_LLM=1 runs scripted personas and a scripted persona writer with no key and no cost, for UI smoke tests and demos.
const FAKE_LLM = process.env.GNOMI_FAKE_LLM === '1';

const KEYS: Record<Exclude<ProviderId, 'openai_compatible'>, { secret: SecretName; label: string }> = {
  anthropic: { secret: 'anthropic_api_key', label: 'an Anthropic' },
  openai: { secret: 'openai_api_key', label: 'an OpenAI' },
  google: { secret: 'google_api_key', label: 'a Google' },
  deepseek: { secret: 'deepseek_api_key', label: 'a DeepSeek' },
};

const clients = new Set<Transport>();
const secrets = new Map<SecretName, string>();
const runs = new Map<string, RunHandle>();
let projectRequests = 0; // includes awaited persona writes and run preflight, before a RunHandle exists
let open: { store: ProjectStore; blobs: BlobStore; record: Recorder } | null = null;
let browsers: Promise<BrowserPool> | null = null;
let sessions: SessionStore | null = null; // while a project is open and main has sent the session key
let recording: { role: string; rec: Promise<LoginRecording> } | null = null; // one login recording at a time
let setupTask: { stop: AbortController; done: Promise<unknown> } | null = null;

function writeSetup<T>(work: () => Promise<T>): Promise<T> {
  if (setupTask || runs.size) return Promise.reject(new Error('Wait for the current generation or run to finish.'));
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

function unlockedSessions(): SessionStore {
  if (!sessions) throw new Error('Recorded logins are locked: the app has not sent the session key yet. Restart Gnomi.');
  return sessions;
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

/** The model gateway for this project's routing; onThrottle tells a run to back off (tech.md §9.5). */
function gateway(record: Recorder, onThrottle?: (provider: ProviderId) => void): LlmGateway {
  if (FAKE_LLM) return createScriptedGateway({ navigator: DEMO_NAVIGATOR, socialiser: DEMO_SOCIALISER, persona_writer: DEMO_PERSONA_WRITER, judge: DEMO_JUDGE, author: DEMO_AUTHOR }, record);
  return createGateway({ secrets: { get: (name) => secrets.get(name) ?? null }, localBaseUrl: project().settings.local_base_url, record, onThrottle });
}

/** Who runs: the generated population, or the built-in persona when the project has no audience. */
function population(config: ProjectConfig): Persona[] {
  return config.audience ? current().store.listPersonas() : [BUILTIN_PERSONA];
}

function withAudience(): { config: ProjectConfig; audience: Audience } {
  const config = project();
  if (!config.audience) throw new Error('Set up the audience first');
  return { config, audience: config.audience };
}

function writer(config: ProjectConfig, emit?: (progress: PersonaProgress) => void): AudienceDeps {
  // Proposed segments may only use logins that were actually recorded (metadata only, no session key needed).
  const roles = current().store.listSessions().map((s) => s.role);
  const store = current().store;
  const task_id = randomUUID();
  const started = Date.now();
  const progress: PersonaProgress = { done: 0, total: 0, calls: 0, failed_attempts: 0, stage: 'sketching' };
  const notify = () => emit?.({ ...progress, elapsed_ms: Date.now() - started });
  return {
    llm: gateway(current().record), model: config.settings.routing.persona_writer, project: config, roles,
    signal: setupTask?.stop.signal,
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

/** Loads the role's start page with its session under containment (tech.md §9.1) and marks it verified when it held. */
async function verify(config: ProjectConfig, role: string) {
  const store = unlockedSessions();
  const saved = await store.load(role);
  if (!saved) throw new Error(`No login is recorded for "${role}" yet. Record it first.`);
  // The login POI's hosts first; the session's cookies go to every web POI in full mode, so any of their hosts may be reached.
  const pois = [recordingPoi(config), ...webPois(config.pois).filter((poi) => poi.mode === 'full')];
  const result = await (await pool()).checkSession({
    storageState: saved.state,
    startUrl: saved.info.start_url,
    allowedHosts: [...new Set(pois.flatMap(allowedHosts))],
    blockedDomains: [...new Set(pois.flatMap((poi) => poi.production_domains))],
  });
  const now = Date.now();
  if (result.ok) store.markVerified(role, now);
  return { result, info: result.ok ? { ...saved.info, verified_at: now } : saved.info };
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
    diversity: personas.length ? diversityReport(personas) : null,
    runs: store.listRuns(),
    sessions: unlocked ? store.listSessions() : [],
    setup_calls: store.listSetupCalls(),
  };
}

const info = () => readInfo(current().store, sessions !== null);

/** Lets the process exit: runs stop, the recorder and the browsers close, the project closes. Main sends it before quitting. */
async function shutdown() {
  setupTask?.stop.abort(new Error('App is closing. Completed drafts are saved.'));
  await setupTask?.done.catch(() => {});
  for (const run of runs.values()) run.stop();
  await Promise.allSettled([...runs.values()].map((run) => run.done));
  const pending = recording;
  recording = null;
  await pending?.rec.then((rec) => rec.cancel()).catch(() => {});
  const launched = browsers;
  browsers = null;
  await launched?.then((pool) => pool.close()).catch(() => {});
  open?.store.close();
  open = null;
  sessions = null;
}

function broadcast(msg: EngineToClient) {
  for (const client of clients) client.send(msg);
}

function canSwitchProject() {
  if (runs.size) throw new Error('Stop the current run before switching projects');
  if (recording) throw new Error('Save or cancel the login recording before switching projects');
  if (projectRequests) throw new Error('Wait for the current project task to finish before switching projects');
}

const handlers: { [M in Method]: (params: Api[M]['params']) => Api[M]['result'] | Promise<Api[M]['result']> } = {
  set_secret({ name, value }) {
    if (value) secrets.set(name, value);
    else secrets.delete(name);
    if (name === 'session_key') refreshSessions();
    return null;
  },
  open_project({ dir }) {
    canSwitchProject();
    // Validate/open first: a bad destination must not leave the current project with a closed database.
    const store = openProject(dir);
    let loaded: ProjectInfo;
    try { loaded = readInfo(store, secrets.has('session_key')); } catch (error) {
      store.close();
      throw error;
    }
    open?.store.close();
    open = { store, blobs: createFsBlobStore(dir), record: createRecorder(store, (event) => broadcast({ kind: 'event', event })) };
    refreshSessions();
    return loaded;
  },
  close_project() {
    canSwitchProject();
    open?.store.close();
    open = null;
    sessions = null;
    return null;
  },
  get_project: () => info(),
  save_project({ project }) {
    if (setupTask) throw new Error('Wait for persona generation to finish before saving project changes.');
    validateCountries(project.audience?.countries);
    if (project.persona_schema !== undefined) validatePersonaSchema(project.persona_schema);
    current().store.saveProject(project);
    return null;
  },
  async test_key({ provider }) {
    const credential = provider === 'openai_compatible' ? (open?.store.getProject()?.settings.local_base_url ?? null) : (secrets.get(KEYS[provider].secret) ?? null);
    if (!credential) return { ok: false, error: provider === 'openai_compatible' ? 'Set the local model endpoint in the project settings first' : 'No key saved' };
    const result = await testProviderKey(provider, credential);
    return result.ok ? { ok: true, error: null } : { ok: false, error: result.error };
  },
  propose_audience: () => writeSetup(() => proposeAudience(writer(project()))),
  generate_personas: () => writeSetup(async () => {
    const { config, audience } = withAudience();
    const progress = (value: PersonaProgress) => broadcast({ kind: 'progress', task: 'generate_personas', ...value });
    const { personas, cost_usd } = await syncPersonas(audience, current().store.listPersonas(), writer(config, progress));
    current().store.replacePersonas(personas);
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
    if (setupTask) throw new Error('Wait for persona generation to finish before editing personas.');
    persona(id);
    current().store.deletePersona(id);
    return null;
  },
  edit_persona({ persona: edited }) {
    if (setupTask) throw new Error('Wait for persona generation to finish before editing personas.');
    // Only the written fields change: the sampled traits are what keep the population honest (tech.md §2.4).
    const { persona: old } = persona(edited.id);
    const { name, job_title, background, context_of_use, goal_interpretation, voice } = edited;
    current().store.putPersona({ ...old, name, job_title, background, context_of_use, goal_interpretation, voice });
    return null;
  },
  estimate_run() {
    const config = project();
    return estimateRun({ personas: population(config), settings: config.settings, audience: config.audience, pois: config.pois });
  },
  async start_run({ reset }) {
    if (setupTask) throw new Error('Wait for persona generation to finish before starting a run.');
    const { store, blobs, record } = current();
    const config = project();
    if (runs.size) throw new Error('A run is already in progress'); // one run at a time
    // The preflight of tech.md §9.1 and §9.3: never production, never with a login that no longer works; and every POI's own.
    const refusal = preflight(config);
    if (refusal) throw new Error(refusal);
    if (reset && !webPois(config.pois).some((poi) => poi.reset_hook_url)) throw new Error('This project has no reset hook. Add one in the project settings, or start without resetting.');
    const personas = population(config);
    if (!personas.length) throw new Error('This audience has no personas yet. Generate them before starting a run.');
    if (config.persona_schema !== undefined) validatePersonaSchema(config.persona_schema);
    if (config.persona_schema && !config.audience) throw new Error('Create an audience and generate its personas before running a configured profile.');
    if (config.audience && personas.some((person) =>
      // Old projects had no writer-input signature; retain their saved profiles until a schema is configured.
      !(config.persona_schema === undefined && person.profile_signature === undefined) && !personaProfileIsCurrent(person, config),
    )) throw new Error('Profile inputs have changed. Generate personas again to refresh their biographies before starting a run.');
    const navigator = config.settings.routing.navigator.provider;
    if (!FAKE_LLM && navigator === 'openai_compatible' && !config.settings.local_base_url) throw new Error('Set the local model endpoint in the project settings first');
    if (!FAKE_LLM && navigator !== 'openai_compatible' && !secrets.get(KEYS[navigator].secret)) throw new Error(`Add ${KEYS[navigator].label} key in Settings: the navigator runs on it`);
    const verified: SessionInfo[] = [];
    for (const role of new Set(personas.map((p) => roleOf(p, config)).filter((r) => r !== null))) {
      const checked = await verify(config, role);
      if (!checked.result.ok) throw new Error(`The recorded "${role}" login no longer works (${checked.result.reason ?? `it ended on ${checked.result.url}`}). Re-record it, then start again.`);
      verified.push(checked.info);
    }
    const browserPool = await pool();
    if (runs.size) throw new Error('A run is already in progress'); // checked again: the awaits above let another start slip in
    if (setupTask) throw new Error('Wait for persona generation to finish before starting a run.');
    let run: RunHandle | undefined;
    const llm = gateway(record, (provider) => run?.throttle(provider));
    run = startRun(store.createRun(newRunConfig(config, { personas, sessions: verified, reset })), { store, blobs, browsers: browserPool, llm, record, sessions });
    const started = run;
    runs.set(started.run_id, started);
    started.done.finally(() => runs.delete(started.run_id)).catch(() => {});
    return { run_id: started.run_id };
  },
  stop_run({ run_id }) {
    runs.get(run_id)?.stop();
    return null;
  },
  async record_session({ role }) {
    const config = project();
    // The session store's rule for role names, checked before the human spends time logging in.
    if (!ROLE.test(role)) throw new Error('Name the role with 1–40 lowercase letters, digits, "-" or "_", for example "recruiter"');
    unlockedSessions(); // before opening a browser whose login could not be saved
    // Never record a production login: the session would be as sensitive as the password.
    const poi = recordingPoi(config);
    const refusal = checkTarget(poi);
    if (refusal) throw new Error(refusal);
    if (recording) throw new Error('A login recording is already open: save or cancel it first');
    const rec = pool().then((p) => p.record(poi.start_url, { headless: false }));
    recording = { role, rec };
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
    const { role, rec } = recording;
    recording = null;
    const login = await (await rec).finish();
    const now = Date.now();
    const saved: SessionInfo = { role, start_url: login.start_url, hosts: login.hosts, recorded_at: now, verified_at: now, expires_at: login.expires_at };
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
    for (const id of persona_ids) runs.get(run_id)?.resume(id);
    return null;
  },
  get_events: ({ run_id, after_seq, persona_id }) =>
    current().store.events(run_id, {
      ...(after_seq === null ? {} : { afterSeq: after_seq }),
      ...(persona_id === null ? {} : { personaId: persona_id }),
    }),
  get_report: ({ run_id }) => buildReport(current().store.events(run_id)),
  import_asset: (params) => ('path' in params ? importLocalFile(current().blobs, params.path) : importText(current().blobs, params.text, params.name)),
  async get_blob({ path }) {
    // The renderer only ever needs run evidence and POI assets; recorded logins under sessions/ stay out of its reach even encrypted.
    const asset = path.startsWith('assets/') ? path.slice('assets/'.length) : null;
    if (asset === null && !path.startsWith('runs/')) throw new Error('Only files from a run or a point of interest can be opened');
    const data = await current().blobs.get(asset === null ? path : assetPath(asset));
    return { mime: asset === null ? 'image/jpeg' : assetMime(asset), base64: Buffer.from(data).toString('base64') };
  },
};

function serve(transport: Transport) {
  clients.add(transport);
  transport.onMessage(async (msg) => {
    if (msg?.kind !== 'request') return;
    const projectTask = msg.method !== 'open_project' && msg.method !== 'close_project' && msg.method !== 'set_secret';
    if (projectTask) projectRequests++;
    try {
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
  serve(transport);
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
});
