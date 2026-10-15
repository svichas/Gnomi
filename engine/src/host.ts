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
import type { Api, ClientToEngine, EngineToClient, Method, ProjectInfo } from './protocol.ts';
import type { BlobStore, BrowserPool, ProjectStore, Recorder, SecretName, Transport } from './seams.ts';

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

function current() {
  if (!open) throw new Error('No project is open');
  return open;
}

function info(): ProjectInfo {
  const { store } = current();
  return { dir: store.dir, project: store.getProject(), persona: BUILTIN_PERSONA, runs: store.listRuns() };
}

function broadcast(msg: EngineToClient) {
  for (const client of clients) client.send(msg);
}

const handlers: { [M in Method]: (params: Api[M]['params']) => Api[M]['result'] | Promise<Api[M]['result']> } = {
  set_secret({ name, value }) {
    if (value) secrets.set(name, value);
    else secrets.delete(name);
    return null;
  },
  open_project({ dir }) {
    if (runs.size) throw new Error('Stop the current run before switching projects');
    open?.store.close();
    const store = openProject(dir);
    open = { store, blobs: createFsBlobStore(dir), record: createRecorder(store, (event) => broadcast({ kind: 'event', event })) };
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
  async start_run() {
    const { store, blobs, record } = current();
    const project = store.getProject();
    if (!project) throw new Error('Set up the project first');
    if (runs.size) throw new Error('A run is already in progress'); // M0 runs one at a time
    const apiKey = secrets.get('anthropic_api_key');
    if (!apiKey && !FAKE_LLM) throw new Error('Add an Anthropic key in Settings');
    browsers ??= launchBrowserPool().catch((err) => {
      browsers = null;
      throw err;
    });
    const pool = await browsers;
    const llm = apiKey && !FAKE_LLM ? createAnthropicGateway({ apiKey, record }) : createScriptedGateway(DEMO_SCRIPT, record);
    const run = startRun(store.createRun(newRunConfig(project)), { store, blobs, browsers: pool, llm, record });
    runs.set(run.run_id, run);
    run.done.finally(() => runs.delete(run.run_id)).catch(() => {});
    return { run_id: run.run_id };
  },
  stop_run({ run_id }) {
    runs.get(run_id)?.stop();
    return null;
  },
  get_events: ({ run_id, after_seq }) => current().store.events(run_id, after_seq === null ? {} : { afterSeq: after_seq }),
  get_report: ({ run_id }) => buildReport(current().store.events(run_id)),
  async get_blob({ path }) {
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
