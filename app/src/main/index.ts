import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api, EngineToClient, Method } from '@gnomi/engine/protocol.ts';
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, nativeImage, safeStorage, session, shell, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import appIcon from '../../../assets/brand/gnomi-app-icon.png?asset';
import type { ProjectAction, ProjectActionResult, ProjectCatalog } from '../projects.ts';
import type { KeyTest } from '../providers.ts';
import { REPORT_FORMATS } from '../reports.ts';
import type { ReportFormat } from '../reports.ts';
import type { Startup } from '../startup.ts';
import { AudienceLibrary } from './audiences.ts';
import { ProjectLibrary } from './projects.ts';
import { keyedProvider, ProviderKeys } from './providers.ts';

// A second instance would open the same project and mark the first one's live run interrupted.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => BrowserWindow.getAllWindows()[0]?.focus());

const rendererUrl = process.env.ELECTRON_RENDERER_URL; // set by `electron-vite dev`

// Only the bundled page and its own script and styles; the dev server also needs inline styles and a websocket.
// worker-src blob: is the swarm layout, which ForceAtlas2 starts from a Blob of its own bundled code.
const CSP = rendererUrl
  ? "default-src 'self' 'unsafe-inline' ws://localhost:*; img-src 'self' data:; font-src 'self'; worker-src blob:"
  : "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; worker-src blob:; base-uri 'none'; form-action 'none'";

// Main is a protocol client of the engine over the utility process's parent port (engine/src/host.ts).
let engine: UtilityProcess | undefined;
let nextId = 1;
const pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();
let library: ProjectLibrary;
let audiences: AudienceLibrary;
let providers: ProviderKeys;
let currentProjectId = '';
let changingProject = false;

const catalog = (): ProjectCatalog => ({ projects: library.list(), currentId: currentProjectId });
const lastProjectFile = () => join(app.getPath('userData'), 'current-project');

/** The preferred project if it is still there, else the newest, else a new one. */
function projectOr(preferred?: string): string {
  const entries = library.list();
  return entries.find((entry) => entry.id === preferred)?.id ?? entries[0]?.id ?? library.create('Untitled project').id;
}

async function openManagedProject(id: string) {
  const project = await request('open_project', { dir: library.directory(id), project_id: id });
  currentProjectId = id;
  writeFileSync(lastProjectFile(), id);
  return project;
}

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
    const override = process.env.GNOMI_PROJECT_DIR;
    library = new ProjectLibrary(join(app.getPath('userData'), 'projects'), override);
    audiences = new AudienceLibrary(join(app.getPath('userData'), 'audiences.json'));
    providers = new ProviderKeys(app.getPath('userData'), { read: readSecret, write: writeSecret, canRemember }, (name, value) => request('set_secret', { name, value }));
    const sessionKey = await loadSessionKey();
    sessionsPersist = sessionKey.remembered;
    await request('set_secret', { name: 'session_key', value: sessionKey.key });
    await Promise.all([
      (async () => {
        if (override) {
          await request('open_project', { dir: override, project_id: 'development' });
          currentProjectId = 'development';
        } else {
          await openManagedProject(projectOr(existsSync(lastProjectFile()) ? readFileSync(lastProjectFile(), 'utf8') : ''));
        }
      })(),
      providers.load(),
    ]);
    return { startupError: null, sessionsPersist };
  } catch (err) {
    return { startupError: err instanceof Error ? err.message : String(err), sessionsPersist };
  }
}

ipcMain.handle('list-providers', () => providers.list());
ipcMain.handle('save-key', (_event, provider: unknown, key: unknown) => providers.save(keyedProvider(provider), typeof key === 'string' ? key : ''));
ipcMain.handle('clear-key', (_event, provider: unknown) => providers.remove(keyedProvider(provider)));
ipcMain.handle('test-key', async (_event, provider: unknown): Promise<KeyTest> => {
  const id = provider === 'openai_compatible' ? provider : keyedProvider(provider);
  // The engine tests the address saved with the open project, so that is the one the result belongs to.
  const target = id === 'openai_compatible' ? (await request('get_project', {})).project?.settings.local_base_url : null;
  const { ok, error } = await request('test_key', { provider: id });
  const test: KeyTest = { ok, error, at: Date.now(), ...(target ? { target } : {}) };
  providers.recordTest(id, test);
  return test;
});

ipcMain.handle('save-figma-token', (_event, token: unknown) => providers.saveFigma(typeof token === 'string' ? token : ''));
ipcMain.handle('clear-figma-token', () => providers.removeFigma());
ipcMain.handle('test-figma-token', async (): Promise<KeyTest> => {
  const { ok, error } = await request('figma_test', {});
  const test: KeyTest = { ok, error, at: Date.now() };
  providers.recordTest('figma', test);
  return test;
});

ipcMain.handle('list-audiences', () => audiences.list());
ipcMain.handle('save-audience', (_event, name: unknown, audience: unknown, schema: unknown) => audiences.save(name, audience, schema));
ipcMain.handle('delete-audience', (_event, id: unknown) => audiences.remove(id));

ipcMain.handle('list-projects', () => catalog());
ipcMain.handle('list-runs', () => library.runs());
ipcMain.handle('project-action', async (_event, input: ProjectAction): Promise<ProjectActionResult> => {
  if (!input || !['create', 'open', 'rename', 'duplicate', 'delete', 'export'].includes(input.action)) throw new Error('Unknown project action.');
  if (changingProject) throw new Error('Another project action is still finishing.');
  if (input.action !== 'create') library.directory(input.id); // validates opaque IDs before any side effect
  changingProject = true;
  const previous = currentProjectId;
  let closed = false;
  try {
    let destination: string | undefined;
    if (input.action === 'export') {
      const result = await dialog.showOpenDialog({ title: 'Export project folder', buttonLabel: 'Export here', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths[0]) return { catalog: catalog(), project: null, canceled: true };
      destination = result.filePaths[0];
    }
    // Navigation detaches a live project without stopping it. Folder mutations still require the
    // target to be idle; other projects' runs keep their own stores and continue in the background.
    if (input.action !== 'create' && input.action !== 'open') {
      await request('close_project', { dir: library.directory(input.id) });
      closed = true;
    }
    let selected = previous;
    let exportedTo: string | undefined;
    switch (input.action) {
      case 'create': selected = library.create(input.name).id; break;
      case 'open': selected = input.id; break;
      case 'rename': library.rename(input.id, input.name); break;
      case 'duplicate': selected = library.duplicate(input.id, input.name).id; break;
      case 'export': exportedTo = library.exportFolder(input.id, destination!); break;
      case 'delete': {
        await library.trash(input.id, (path) => shell.trashItem(path));
        if (input.id === previous) selected = projectOr();
        break;
      }
    }
    const project = await openManagedProject(selected);
    closed = false;
    return { catalog: catalog(), project, ...(exportedTo ? { exportedTo } : {}) };
  } catch (err) {
    if (closed) {
      try {
        await openManagedProject(projectOr(previous));
      } catch {
        throw new Error('The project action failed and the previous project could not be reopened. Restart Gnomi.');
      }
    }
    throw err;
  } finally {
    changingProject = false;
  }
});

// Evidence screenshots shrunk for an exported report; one that cannot be read is left out.
const THUMBNAIL_WIDTH = 640;
ipcMain.handle('report-thumbnails', async (_event, paths: unknown) => {
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) throw new Error('Unknown screenshots.');
  const thumbnails: Record<string, string> = {};
  await Promise.all(paths.map(async (path) => {
    const blob = await request('get_blob', { path }).catch(() => null); // the engine hands out run files only
    const image = blob && nativeImage.createFromBuffer(Buffer.from(blob.base64, 'base64'));
    if (!image || image.isEmpty()) return;
    const small = image.getSize().width > THUMBNAIL_WIDTH ? image.resize({ width: THUMBNAIL_WIDTH, quality: 'good' }) : image;
    thumbnails[path] = `data:image/jpeg;base64,${small.toJPEG(70).toString('base64')}`;
  }));
  return thumbnails;
});

/** Prints exported HTML in a hidden window with no scripts and a session of its own, where the app's CSP (no inline styles) does not apply. */
async function printPdf(html: string): Promise<Buffer> {
  const dir = mkdtempSync(join(app.getPath('temp'), 'gnomi-print-'));
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, partition: 'gnomi-print' } });
  try {
    writeFileSync(join(dir, 'report.html'), html);
    await win.loadFile(join(dir, 'report.html'));
    return await win.webContents.printToPDF({ printBackground: true });
  } finally {
    win.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}

ipcMain.handle('save-report', async (_event, format: unknown, runId: unknown, content: unknown): Promise<string | null> => {
  if (typeof format !== 'string' || !Object.hasOwn(REPORT_FORMATS, format)) throw new Error('Unknown export format.');
  if (typeof runId !== 'string' || typeof content !== 'string') throw new Error('Nothing to export.');
  const kind = format as ReportFormat;
  const result = await dialog.showSaveDialog({
    title: 'Export report',
    defaultPath: `gnomi-report-${runId.replace(/[^\w-]/g, '')}.${kind}`,
    filters: [{ name: REPORT_FORMATS[kind], extensions: [kind] }],
  });
  if (result.canceled || !result.filePath) return null;
  writeFileSync(result.filePath, kind === 'pdf' ? await printPdf(content) : content);
  return result.filePath;
});

function createWindow(started: Promise<Startup>) {
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    title: 'Gnomi',
    icon: appIcon,
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
  app.dock?.setIcon(appIcon);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });
  createWindow(startEngine());
});
app.on('window-all-closed', () => app.quit()); // macOS apps usually stay open here; quitting also stops the engine

// The engine closes its Chrome and the project when asked, so nothing is orphaned; kill() only if it has not exited in two seconds.
let quitting = false;
app.on('before-quit', (event) => {
  const child = engine;
  if (quitting || !child) return;
  quitting = true;
  event.preventDefault();
  const fallback = setTimeout(() => child.kill(), 2000);
  child.once('exit', () => {
    clearTimeout(fallback);
    app.quit();
  });
  child.postMessage({ kind: 'shutdown' });
});
