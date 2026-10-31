// Drives host.ts, the Electron utility-process entry, through a fake parent port in protocol.ts messages. host.ts reads
// its GNOMI_FAKE_* variables at import, so set them before startHost(). The shutdown message lets the test process exit.
import { after } from 'node:test';
import type { Api, EngineToClient, Method } from './protocol.ts';
import type { GnomiEvent } from '@gnomi/simulation/types.ts';

type Listener = (e: { data: unknown; ports: unknown[] }) => void;

export async function startHost() {
  const listeners: Listener[] = [];
  const replies = new Map<number, (msg: EngineToClient) => void>();
  const progress: { done: number; total: number }[] = [];
  const events: GnomiEvent[] = [];
  const toMain: EngineToClient[] = []; // anything but responses, which main would drop
  const repeatFailures: string[] = [];
  const reply = (msg: EngineToClient) => {
    if (msg.kind === 'response') replies.get(msg.id)?.(msg);
    else if (msg.kind === 'event') events.push(msg.event);
    else if (msg.kind === 'progress') progress.push(msg);
    else if (msg.kind === 'repeat_failed') repeatFailures.push(msg.error);
  };
  (process as unknown as { parentPort: unknown }).parentPort = {
    on: (event: string, listener: Listener) => event === 'message' && listeners.push(listener),
    postMessage: (msg: EngineToClient) => (msg.kind === 'response' ? reply(msg) : toMain.push(msg)),
  };
  await import('./host.ts');
  const send = (data: unknown, ports: unknown[] = []) => listeners.forEach((listener) => listener({ data, ports }));
  after(() => send({ kind: 'shutdown' }));

  let nextId = 1;
  const caller = (post: (data: unknown) => void) => <M extends Method>(method: M, params: Api[M]['params']): Promise<Api[M]['result']> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      replies.set(id, (msg) => (msg.kind === 'response' && msg.ok ? resolve(msg.result as Api[M]['result']) : reject(new Error(msg.kind === 'response' && !msg.ok ? msg.error : ''))));
      post({ kind: 'request', id, method, params });
    });
  };

  /** A renderer's port, as main hands it over with { kind: 'connect' }. */
  function connect() {
    const portListeners: Listener[] = [];
    send({ kind: 'connect' }, [{ on: (event: string, listener: Listener) => event === 'message' && portListeners.push(listener), postMessage: reply }]);
    return caller((data) => portListeners.forEach((listener) => listener({ data, ports: [] })));
  }
  connect(); // the renderer, which events and progress stream to
  return { call: caller(send), connect, send, events, progress, toMain, repeatFailures };
}
