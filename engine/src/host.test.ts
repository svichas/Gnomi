// host.ts is the Electron utility-process entry, driven here through a fake parent port in protocol.ts messages.
// Only refusals are tested: each happens before a browser starts, which would outlive the test (host never closes it).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createFsBlobStore } from './log/blobs.ts';
import { openProject } from './log/sqlite.ts';
import { createSessionStore } from './sessions.ts';
import type { Api, EngineToClient, Method } from './protocol.ts';
import type { ProjectConfig } from './types.ts';

type Listener = (e: { data: unknown; ports: [] }) => void;
const listeners: Listener[] = [];
const replies = new Map<number, (msg: EngineToClient) => void>();
(process as unknown as { parentPort: unknown }).parentPort = {
  on: (event: string, listener: Listener) => event === 'message' && listeners.push(listener),
  postMessage: (msg: EngineToClient) => msg.kind === 'response' && replies.get(msg.id)?.(msg),
};
process.env.GNOMI_FAKE_LLM = '1'; // no key needed to reach the preflight
await import('./host.ts');

let nextId = 1;
function call<M extends Method>(method: M, params: Api[M]['params']): Promise<Api[M]['result']> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    replies.set(id, (msg) => (msg.kind === 'response' && msg.ok ? resolve(msg.result as Api[M]['result']) : reject(new Error(msg.kind === 'response' && !msg.ok ? msg.error : ''))));
    for (const listener of listeners) listener({ data: { kind: 'request', id, method, params }, ports: [] });
  });
}

const dir = mkdtempSync(join(tmpdir(), 'gnomi-host-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const key = randomBytes(32).toString('hex');
const project = (poi: Partial<ProjectConfig['poi']> = {}, role: string | null = null): ProjectConfig => ({
  name: 'Acme',
  description: '',
  poi: { id: 'poi-1', type: 'web', name: 'Acme', start_url: 'https://staging.acme.io/', allowed_hosts: [], production_domains: ['acme.com'], not_production: false, reset_hook_url: null, ...poi },
  goal: 'Post a job',
  role,
});

test('start_run refuses production, an unconfirmed host and a reset with no hook', async () => {
  await call('open_project', { dir });
  await call('save_project', { project: project({ start_url: 'https://app.acme.com/' }) });
  await assert.rejects(call('start_run', { reset: false }), /app\.acme\.com is on acme\.com, which this project lists as production/);
  await call('save_project', { project: project({ start_url: 'https://acme.io/' }) });
  await assert.rejects(call('start_run', { reset: false }), /does not look like a staging or test address/);
  await call('save_project', { project: project() });
  await assert.rejects(call('start_run', { reset: true }), /This project has no reset hook/);
});

test('a project with a role needs the session key and a recorded login before it runs', async () => {
  await call('save_project', { project: project({}, 'recruiter') });
  await assert.rejects(call('start_run', { reset: false }), /Recorded logins are locked/);
  await assert.rejects(call('check_session', { role: 'recruiter' }), /Recorded logins are locked/);
  await call('set_secret', { name: 'session_key', value: key });
  await assert.rejects(call('start_run', { reset: false }), /No login is recorded for "recruiter" yet\. Record it first\./);
  assert.deepEqual((await call('get_project', {})).sessions, []);

  const store = openProject(dir); // the same project folder, as the recorder would have left it
  const info = { role: 'recruiter', start_url: 'https://staging.acme.io/home', hosts: ['staging.acme.io'], recorded_at: 1, verified_at: 1, expires_at: null };
  await createSessionStore(store, createFsBlobStore(dir), key).save(info, { cookies: [] });
  store.close();
  assert.deepEqual((await call('get_project', {})).sessions, [info]);
});

test('record_session refuses a role the session store cannot name, and a production target, before any browser opens', async () => {
  await call('set_secret', { name: 'session_key', value: key });
  await assert.rejects(call('record_session', { role: 'Recruiters team' }), /1–40 lowercase letters/);
  await call('save_project', { project: project({ start_url: 'https://www.acme.com/' }) });
  await assert.rejects(call('record_session', { role: 'recruiter' }), /lists as production/);
  await assert.rejects(call('save_session', {}), /No login recording is open/);
  assert.equal(await call('cancel_recording', {}), null);
});

test('resume_persona and stop_run ignore a run that is not in progress', async () => {
  assert.equal(await call('resume_persona', { run_id: 'r-9999', persona_id: 'p-001' }), null);
  assert.equal(await call('stop_run', { run_id: 'r-9999' }), null);
});
