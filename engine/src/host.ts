// Engine entry inside Electron's utilityProcess. No Electron imports (the engine stays a plain Node
// library, tech.md §16.2): the parent port is a global on `process`, and main hands over one
// MessagePort per extra client. Main and the renderer both speak protocol.ts.
import { launchBrowserPool } from './browser/pool.ts';
import { createAnthropicGateway, testAnthropicKey } from './llm/gateway.ts';
import { createScriptedGateway, DEMO_SCRIPT } from './llm/scripted.ts';
import { createFsBlobStore } from './log/blobs.ts';
import { openProject } from './log/sqlite.ts';
import { BUILTIN_PERSONA } from './persona.ts';
import { buildReport } from './report/build.ts';
import { createRecorder, newRunConfig, startRun, type RunHandle } from './run.ts';
import { allowedHosts, checkTarget } from './safety.ts';
import { createSessionStore, ROLE } from './sessions.ts';
import type { Api, ClientToEngine, EngineToClient, Method, ProjectInfo } from './protocol.ts';
import type { BlobStore, BrowserPool, LoginRecording, ProjectStore, Recorder, SecretName, SessionStore, Transport } from './seams.ts';
import type { ProjectConfig, SessionInfo } from './types.ts';

interface PortLike {
  on(event: 'message', listener: (e: { data: unknown; ports: PortLike[] }) => void): void;
  on(event: 'close', listener: () => void): void;
  postMessage(message: unknown): void;
  start?(): void;
}

// GNOMI_FAKE_LLM=1 runs a scripted persona with no key and no cost, for UI smoke tests and demos.
const FAKE_LLM = process.env.GNOMI_FAKE_LLM === '1';

const clients = new Set<Transport>();
const secrets = new Map<SecretName, string>();
const runs = new Map<string, RunHandle>();
let open: { store: ProjectStore; blobs: BlobStore; record: Recorder } | null = null;
let browsers: Promise<BrowserPool> | null = null;
let sessions: SessionStore | null = null; // while a project is open and main has sent the session key
let recording: { role: string; rec: Promise<LoginRecording> } | null = null; // one login recording at a time

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

/** Loads the role's start page with its session under containment (tech.md §9.1) and marks it verified when it held. */
async function verify(config: ProjectConfig, role: string) {
  const store = unlockedSessions();
  const saved = await store.load(role);
  if (!saved) throw new Error(`No login is recorded for "${role}" yet. Record it first.`);
  const result = await (await pool()).checkSession({
    storageState: saved.state,
    startUrl: saved.info.start_url,
    allowedHosts: allowedHosts(config.poi),
    blockedDomains: config.poi.production_domains,
  });
  const now = Date.now();
  if (result.ok) store.markVerified(role, now);
  return { result, info: result.ok ? { ...saved.info, verified_at: now } : saved.info };
}

function info(): ProjectInfo {
  const { store } = current();
  return { dir: store.dir, project: store.getProject(), persona: BUILTIN_PERSONA, runs: store.listRuns(), sessions: sessions?.list() ?? [] };
}

function broadcast(msg: EngineToClient) {
  for (const client of clients) client.send(msg);
}

const handlers: { [M in Method]: (params: Api[M]['params']) => Api[M]['result'] | Promise<Api[M]['result']> } = {
  set_secret({ name, value }) {
    if (value) secrets.set(name, value);
    else secrets.delete(name);
    if (name === 'session_key') refreshSessions();
    return null;
  },
  open_project({ dir }) {
    if (runs.size) throw new Error('Stop the current run before switching projects');
    if (recording) throw new Error('Save or cancel the login recording before switching projects');
    open?.store.close();
    const store = openProject(dir);
    open = { store, blobs: createFsBlobStore(dir), record: createRecorder(store, (event) => broadcast({ kind: 'event', event })) };
    refreshSessions();
    return info();
  },
  get_project: () => info(),
  save_project({ project }) {
    current().store.saveProject(project);
    return null;
  },
  async test_key() {
    const apiKey = secrets.get('anthropic_api_key');
    if (!apiKey) return { ok: false, error: 'No key saved' };
    const result = await testAnthropicKey(apiKey);
    return result.ok ? { ok: true, error: null } : { ok: false, error: result.error };
  },
  async start_run({ reset }) {
    const { store, blobs, record } = current();
    const config = project();
    if (runs.size) throw new Error('A run is already in progress'); // M0 runs one at a time
    // The preflight of tech.md §9.1 and §9.3: never production, never with a login that no longer works.
    const refusal = checkTarget(config.poi);
    if (refusal) throw new Error(refusal);
    if (reset && !config.poi.reset_hook_url) throw new Error('This project has no reset hook. Add one in the project settings, or start without resetting.');
    const apiKey = secrets.get('anthropic_api_key');
    if (!apiKey && !FAKE_LLM) throw new Error('Add an Anthropic key in Settings');
    let session: SessionInfo | null = null;
    if (config.role) {
      const checked = await verify(config, config.role);
      if (!checked.result.ok)
        throw new Error(`The recorded "${config.role}" login no longer works (${checked.result.reason ?? `it ended on ${checked.result.url}`}). Re-record it, then start again.`);
      session = checked.info;
    }
    const browserPool = await pool();
    if (runs.size) throw new Error('A run is already in progress'); // checked again: the awaits above let another start slip in
    const llm = apiKey && !FAKE_LLM ? createAnthropicGateway({ apiKey, record }) : createScriptedGateway(DEMO_SCRIPT, record);
    const run = startRun(store.createRun(newRunConfig(config, { session, reset })), { store, blobs, browsers: browserPool, llm, record, sessions });
    runs.set(run.run_id, run);
    run.done.finally(() => runs.delete(run.run_id)).catch(() => {});
    return { run_id: run.run_id };
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
    const refusal = checkTarget(config.poi);
    if (refusal) throw new Error(refusal);
    if (recording) throw new Error('A login recording is already open: save or cancel it first');
    const rec = pool().then((p) => p.record(config.poi.start_url, { headless: false }));
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
  resume_persona({ run_id, persona_id }) {
    runs.get(run_id)?.resume(persona_id);
    return null;
  },
  get_events: ({ run_id, after_seq }) => current().store.events(run_id, after_seq === null ? {} : { afterSeq: after_seq }),
  get_report: ({ run_id }) => buildReport(current().store.events(run_id)),
  async get_blob({ path }) {
    // The renderer only ever needs run evidence; recorded logins under sessions/ stay out of its reach even encrypted.
    if (!path.startsWith('runs/')) throw new Error('Only files from a run can be opened');
    const data = await current().blobs.get(path);
    return { mime: 'image/jpeg', base64: Buffer.from(data).toString('base64') };
  },
};

function serve(transport: Transport) {
  clients.add(transport);
  transport.onMessage(async (msg) => {
    if (msg?.kind !== 'request') return;
    try {
      const handler = handlers[msg.method] as (params: unknown) => unknown;
      transport.send({ kind: 'response', id: msg.id, ok: true, result: await handler(msg.params) });
    } catch (err) {
      transport.send({ kind: 'response', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
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

// Main is a client over the parent port; { kind: 'connect' } hands over ports for other clients (the renderer).
serve({
  send: (msg) => parentPort.postMessage(msg),
  onMessage: (handler) =>
    parentPort.on('message', (e) => {
      const data = e.data as { kind?: string };
      if (data?.kind === 'connect') e.ports.forEach(servePort);
      else handler(data as ClientToEngine);
    }),
});
