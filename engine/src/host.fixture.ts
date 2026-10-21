// Drives host.ts, the Electron utility-process entry, through a fake parent port in protocol.ts messages. host.ts reads
// its GNOMI_FAKE_* variables at import, so set them before startHost(). The shutdown message lets the test process exit.
import { after } from 'node:test';
import type { Api, EngineToClient, Method } from './protocol.ts';
import type { GnomiEvent } from '@gnomi/simulation/types.ts';

type Listener = (e: { data: unknown; ports: [] }) => void;

export async function startHost() {
  const listeners: Listener[] = [];
  const replies = new Map<number, (msg: EngineToClient) => void>();
  const progress: { done: number; total: number }[] = [];
  const events: GnomiEvent[] = [];
  (process as unknown as { parentPort: unknown }).parentPort = {
    on: (event: string, listener: Listener) => event === 'message' && listeners.push(listener),
    postMessage(msg: EngineToClient) {
      if (msg.kind === 'response') replies.get(msg.id)?.(msg);
      else if (msg.kind === 'event') events.push(msg.event);
      else if (msg.kind === 'progress') progress.push(msg);
    },
  };
  await import('./host.ts');
  const send = (data: unknown) => listeners.forEach((listener) => listener({ data, ports: [] }));
  after(() => send({ kind: 'shutdown' }));

  let nextId = 1;
  function call<M extends Method>(method: M, params: Api[M]['params']): Promise<Api[M]['result']> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      replies.set(id, (msg) => (msg.kind === 'response' && msg.ok ? resolve(msg.result as Api[M]['result']) : reject(new Error(msg.kind === 'response' && !msg.ok ? msg.error : ''))));
      send({ kind: 'request', id, method, params });
    });
  }
  return { call, send, events, progress };
}
