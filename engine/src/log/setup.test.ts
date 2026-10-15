import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openProject } from './sqlite.ts';
import { BUILTIN_PERSONA } from '../persona.ts';

test('a v3 project gains setup storage without changing its saved population', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-setup-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = openProject(dir);
  original.replacePersonas([BUILTIN_PERSONA]);
  original.close();
  const old = new DatabaseSync(join(dir, 'project.sqlite'));
  old.exec('DROP TABLE persona_draft; DROP TABLE setup_call; PRAGMA user_version = 3;');
  old.close();
  const upgraded = openProject(dir);
  try {
    assert.deepEqual(upgraded.listPersonas(), [BUILTIN_PERSONA]);
    assert.deepEqual(upgraded.listSetupCalls(), []);
    upgraded.putPersonaDraft('new-draft', { background: 'Saved draft' });
    assert.deepEqual(upgraded.getPersonaDraft('new-draft'), { background: 'Saved draft' });
  } finally { upgraded.close(); }
});

test('writer checkpoints and setup attempts survive reopening independently of the published population', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = openProject(dir);
  store.putPersonaDraft('inputs-v1', { background: 'Completed work' });
  store.recordSetupCall({ task_id: 'task-1', persona_id: 'p-1', purpose: 'expand_persona' }, {
    payload: { role: 'persona_writer', model: 'demo', provider: 'scripted', input_tokens: 100, output_tokens: 40, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.01, latency_ms: 250, queue_ms: 10, status: 'ok', error: null },
    transcript: { request: { model: 'demo' }, response: { text: 'Completed work' } },
  });
  store.close();
  store = openProject(dir);
  try {
    assert.deepEqual(store.getPersonaDraft('inputs-v1'), { background: 'Completed work' });
    assert.equal(store.getPersonaDraft('inputs-v2'), undefined);
    assert.deepEqual(store.listPersonas(), [], 'drafts never appear as a partial population');
    assert.equal(store.listSetupCalls()[0].payload.latency_ms, 250);
    assert.equal(store.listSetupCalls()[0].purpose, 'expand_persona');
    assert.equal(store.listSetupCalls()[0].task_id, 'task-1');
    store.clearPersonaDrafts();
    assert.equal(store.getPersonaDraft('inputs-v1'), undefined);
    assert.equal(store.listSetupCalls().length, 1, 'publishing clears drafts, not diagnostic history');
  } finally { store.close(); }
});
