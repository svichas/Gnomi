import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultAudience } from './audience/index.ts';
import { checkRun, credential } from './workspace.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { DEFAULT_SETTINGS, PROVIDER_DEFAULTS } from '@gnomi/simulation/settings.ts';
import type { LlmRole, ProjectConfig, RunSettings, WebPoi } from '@gnomi/simulation/types.ts';

test('a provider needs its key, and the local one its endpoint', () => {
  const secrets = (name: string) => (name === 'openai_api_key' ? 'sk-test' : null);
  assert.equal(credential('openai', null, secrets), 'sk-test');
  assert.equal(credential('anthropic', 'http://localhost:11434/v1', secrets), null);
  assert.equal(credential('openai_compatible', 'http://localhost:11434/v1', secrets), 'http://localhost:11434/v1');
  assert.equal(credential('openai_compatible', '', secrets), null);
});

test('the start check needs a key for every role the run will use, and none with scripted models', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-workspace-'));
  const store = openProject(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const poi: WebPoi = { id: 'poi-1', type: 'web', name: 'Gym', start_url: 'http://localhost:3001/', allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null };
  const base: ProjectConfig = { name: 'Gym', description: '', pois: [poi], goal: 'Post a job', role: null, audience: defaultAudience({ name: 'Gym', role: null, goal: 'Post a job' }), settings: DEFAULT_SETTINGS };
  store.replacePersonas([BUILTIN_PERSONA]);
  const anthropic = (name: string) => (name === 'anthropic_api_key' ? 'sk-test' : null);
  const on = (role: LlmRole, settings: Partial<RunSettings> = {}) => ({ ...base, settings: { ...DEFAULT_SETTINGS, ...settings, routing: { ...DEFAULT_SETTINGS.routing, [role]: PROVIDER_DEFAULTS.openai[role] } } });
  const check = (config: ProjectConfig, fake = false) => checkRun(store, config, { reset: false, fake, secrets: anthropic });
  assert.equal(check(base).length, 1);
  for (const role of ['socialiser', 'judge', 'author'] as const) assert.throws(() => check(on(role)), new RegExp(`OpenAI key in Settings: the ${role} runs on it`));
  assert.doesNotThrow(() => check(on('judge'), true));
  // Unused roles need no key: no social rounds, and the persona writer has already written everyone.
  assert.doesNotThrow(() => check(on('socialiser', { social: false })));
  assert.doesNotThrow(() => check(on('persona_writer')));
});
