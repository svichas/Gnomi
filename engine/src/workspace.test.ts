import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credential } from './workspace.ts';

test('a provider needs its key, and the local one its endpoint', () => {
  const secrets = (name: string) => (name === 'openai_api_key' ? 'sk-test' : null);
  assert.equal(credential('openai', null, secrets), 'sk-test');
  assert.equal(credential('anthropic', 'http://localhost:11434/v1', secrets), null);
  assert.equal(credential('openai_compatible', 'http://localhost:11434/v1', secrets), 'http://localhost:11434/v1');
  assert.equal(credential('openai_compatible', '', secrets), null);
});
