import type { Api, EngineToClient, Method, SessionRun } from '@gnomi/engine/protocol.ts';
import type { GnomiEvent, PersonaProgress } from '@gnomi/simulation/types.ts';
import type { Startup } from '../../startup.ts';

// The engine client: typed requests over the MessagePort that main hands to the page (tech.md §11).
let port: MessagePort | undefined;
let nextId = 1;
const pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();
const listeners = new Set<{ listener: (event: GnomiEvent) => void; projectDir: string | undefined }>();
const sessionListeners = new Set<(run: SessionRun) => void>();
let eventProject: string | undefined;
export function setEventProject(dir: string) { eventProject = dir; }
const progressListeners = new Set<(progress: PersonaProgress) => void>();

const STOPPED = 'The engine stopped unexpectedly. Quit and reopen Gnomi to continue.';
let closed = false;
let stop: (message: string) => void;
/** Resolves with a message if the engine goes away: its process died, so its end of the port closed. */
export const stopped = new Promise<string>((resolve) => (stop = resolve));

// Listens from module load: the preload posts the port as soon as the page has loaded, and again after a reload.
export const connected = new Promise<Startup>((resolve) => {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || e.data?.gnomi !== 'port' || !e.ports[0]) return;
    port = e.ports[0];
    port.addEventListener('close', () => {
      closed = true;
      pending.forEach((waiting) => waiting.reject(new Error(STOPPED)));
      pending.clear();
      stop(STOPPED);
    });
    port.onmessage = ({ data }: MessageEvent<EngineToClient>) => {
      if (data.kind === 'event') {
        listeners.forEach(({ listener, projectDir }) => {
          if (!data.project_dir || data.project_dir === projectDir) listener(data.event);
        });
        return;
      }
      if (data.kind === 'session_run') {
        sessionListeners.forEach((listener) => listener(data.run));
        return;
      }
      if (data.kind === 'progress') {
        progressListeners.forEach((listener) => listener(data)); // the one task so far is generate_personas
        return;
      }
      const waiting = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) waiting?.resolve(data.result);
      else waiting?.reject(new Error(data.error));
    };
    resolve({ startupError: e.data.startupError, sessionsPersist: e.data.sessionsPersist });
  });
});

export async function call<M extends Method>(method: M, params: Api[M]['params']): Promise<Api[M]['result']> {
  await connected;
  if (closed) throw new Error(STOPPED);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
    port?.postMessage({ kind: 'request', id, method, params });
  });
}

/** Every event the engine appends, from now on; returns the unsubscribe function. */
export function onEvent(listener: (event: GnomiEvent) => void, projectDir = eventProject): () => void {
  const subscription = { listener, projectDir };
  listeners.add(subscription);
  return () => listeners.delete(subscription);
}

export function onSessionRun(listener: (run: SessionRun) => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** Progress of a long request (writing personas), from now on; returns the unsubscribe function. */
export function onProgress(listener: (progress: PersonaProgress) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

/** Electron prefixes errors thrown by main's IPC handlers; the designer only needs the sentence. */
export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}
