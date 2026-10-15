import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api, EngineToClient, Method } from '@gnomi/engine/protocol.ts';
import { app, BrowserWindow, ipcMain, MessageChannelMain, safeStorage, session, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';

// A second instance would open the same project and mark the first one's live run interrupted.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => BrowserWindow.getAllWindows()[0]?.focus());

const rendererUrl = process.env.ELECTRON_RENDERER_URL; // set by `electron-vite dev`

// Only the bundled page and its own script and styles; the dev server also needs inline styles and a websocket.
const CSP = rendererUrl
  ? "default-src 'self' 'unsafe-inline' ws://localhost:*; img-src data:"
  : "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";

// Main is a protocol client of the engine over the utility process's parent port (engine/src/host.ts).
let engine: UtilityProcess | undefined;
let nextId = 1;
const pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();

function request<M extends Method>(method: M, params: Api[M]['params']): Promise<Api[M]['result']> {
  return new Promise((resolve, reject) => {
    if (!engine) return reject(new Error('The engine is not running'));
    const id = nextId++;
    pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
    engine.postMessage({ kind: 'request', id, method, params });
  });
}

// Secrets live encrypted in userData, never in a project folder, and are only ever sent to the engine.
const secretFile = (name: string) => join(app.getPath('userData'), name);
let hasKey = false;

async function readSecret(name: string): Promise<string | null> {
  if (!existsSync(secretFile(name))) return null;
  try {
    return (await safeStorage.decryptStringAsync(readFileSync(secretFile(name)))).result;
  } catch {
    console.warn(`${name} could not be decrypted and is ignored.`); // never the value
    return null;
  }
}

async function writeSecret(name: string, value: string) {
  writeFileSync(secretFile(name), await safeStorage.encryptStringAsync(value), { mode: 0o600 });
}

// Linux without a secret store would keep the key readable by anyone (tech.md §4.11): then it lives for this session only.
async function canRemember(): Promise<boolean> {
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
  return safeStorage.isAsyncEncryptionAvailable();
}

/** The key that encrypts recorded logins on disk: made on first start, then kept like the API key. */
async function loadSessionKey(): Promise<{ key: string; remembered: boolean }> {
  const stored = await readSecret('session.key');
  if (stored && /^[0-9a-f]{64}$/.test(stored)) return { key: stored, remembered: true };
  const key = randomBytes(32).toString('hex');
  const remembered = await canRemember();
  if (remembered) await writeSecret('session.key', key);
  return { key, remembered }; // not remembered: recorded logins end with this app session
}

interface Startup {
  startupError: string | null; // set instead of rejecting, so the page can show it
  sessionsPersist: boolean; // false: recorded logins are forgotten when the app quits
}

/** Starts the engine, gives it the secrets and opens the project. */
async function startEngine(): Promise<Startup> {
  let sessionsPersist = true;
  try {
    const child = utilityProcess.fork(join(import.meta.dirname, 'host.js'), [], { serviceName: 'Gnomi engine' });
    engine = child;
    child.on('message', (msg: EngineToClient) => {
      if (msg.kind !== 'response') return; // events are for the renderer, which has its own port
      const waiting = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok) waiting?.resolve(msg.result);
      else waiting?.reject(new Error(msg.error));
    });
    child.on('exit', (code) => {
      // shortcut: no automatic restart; the page tells the user to relaunch. Supervise and restart with the M7 robustness pass.
      engine = undefined;
      for (const waiting of pending.values()) waiting.reject(new Error(`The engine stopped (exit code ${code})`));
      pending.clear();
    });
    // shortcut: one fixed project folder; add a project picker when more than one project is needed (M6 import/export).
    const dir = process.env.GNOMI_PROJECT_DIR || join(app.getPath('userData'), 'projects', 'Default.gnomi');
    const sessionKey = await loadSessionKey();
    sessionsPersist = sessionKey.remembered;
    await request('set_secret', { name: 'session_key', value: sessionKey.key });
    await Promise.all([
      request('open_project', { dir }),
      readSecret('anthropic.key').then(async (key) => {
        if (!key) return;
        await request('set_secret', { name: 'anthropic_api_key', value: key });
        hasKey = true;
      }),
    ]);
    return { startupError: null, sessionsPersist };
  } catch (err) {
    return { startupError: err instanceof Error ? err.message : String(err), sessionsPersist };
  }
}

ipcMain.handle('save-key', async (_event, key: unknown) => {
  if (typeof key !== 'string' || !key.trim()) throw new Error('Paste a key first');
  const secret = key.trim();
  await request('set_secret', { name: 'anthropic_api_key', value: secret });
  hasKey = true;
  const remembered = await canRemember();
  if (remembered) await writeSecret('anthropic.key', secret);
  return { remembered };
});
ipcMain.handle('has-key', () => hasKey);
ipcMain.handle('clear-key', async () => {
  rmSync(secretFile('anthropic.key'), { force: true });
  await request('set_secret', { name: 'anthropic_api_key', value: null });
  hasKey = false;
});

function createWindow(started: Promise<Startup>) {
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    title: 'Gnomi',
    backgroundColor: '#fafaf9',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // The window only ever shows the bundled page.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // A fresh port on every load, because a reloaded page has lost the previous one.
  win.webContents.on('did-finish-load', async () => {
    const startup = await started;
    const { port1, port2 } = new MessageChannelMain();
    if (engine) engine.postMessage({ kind: 'connect' }, [port1]);
    else port1.close(); // the page sees its port close and reports that the engine stopped
    win.webContents.postMessage('gnomi-port', startup, [port2]);
  });
  if (rendererUrl) void win.loadURL(rendererUrl);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });
  createWindow(startEngine());
});
app.on('window-all-closed', () => app.quit()); // macOS apps usually stay open here; quitting also stops the engine
app.on('will-quit', () => engine?.kill());
