import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { keyedProvider, maskKey, ProviderKeys, type Vault } from './providers.ts';

const ANTHROPIC = 'sk-ant-api03-test-key-0123456789';
const GOOGLE = 'AIzaSyTestGoogleKey0123456789abcd';
const DEEPSEEK = 'sk-0123456789abcdef0123456789abcdef';

// A stand-in for safeStorage that writes the key reversed, so a test can tell a written file from plain text.
function setup(t: TestContext, remember = true) {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-providers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const flip = (text: string) => [...text].reverse().join('');
  const vault: Vault = {
    read: async (file) => (existsSync(join(dir, file)) ? flip(readFileSync(join(dir, file), 'utf8')) : null),
    write: async (file, value) => writeFileSync(join(dir, file), flip(value)),
    canRemember: async () => remember,
  };
  const sent: [string, string | null][] = [];
  const open = async () => {
    const providers = new ProviderKeys(dir, vault, async (name, value) => void sent.push([name, value]));
    await providers.load();
    return providers;
  };
  return { dir, vault, sent, open };
}

test('keys saved before the provider list appear in it, go to the engine, and come back only masked', async (t) => {
  const { vault, sent, open } = setup(t);
  // As M0 to M3 left them: one encrypted file per key, and no other provider state.
  await vault.write('anthropic.key', ANTHROPIC);
  await vault.write('google.key', GOOGLE);
  const providers = await open();

  assert.deepEqual(sent, [['anthropic_api_key', ANTHROPIC], ['google_api_key', GOOGLE]]);
  assert.deepEqual(providers.list(), {
    keys: [
      { provider: 'anthropic', masked: 'sk-…6789', remembered: true, test: null },
      { provider: 'google', masked: 'AIz…abcd', remembered: true, test: null },
    ],
    local_test: null,
  });
  assert.doesNotMatch(JSON.stringify(providers.list()), /0123456789/);
});

test('add, test and remove move the list, the key file and the engine together; a new key drops the old test', async (t) => {
  const { dir, sent, open } = setup(t);
  const providers = await open();
  const added = await providers.save('deepseek', `  ${DEEPSEEK}\n`);
  assert.deepEqual(added, { provider: 'deepseek', masked: 'sk-…cdef', remembered: true, test: null });
  assert.deepEqual(sent.at(-1), ['deepseek_api_key', DEEPSEEK], 'the engine gets the trimmed key');
  assert.ok(!readFileSync(join(dir, 'deepseek.key'), 'utf8').includes(DEEPSEEK), 'the key file holds plain text');

  providers.recordTest('deepseek', { ok: false, error: 'DeepSeek rejected this key (401).', at: 1 });
  providers.recordTest('openai_compatible', { ok: true, error: null, at: 2, target: 'http://localhost:11434/v1' });
  const reopened = await open(); // after a restart
  assert.deepEqual(reopened.list(), {
    keys: [{ provider: 'deepseek', masked: 'sk-…cdef', remembered: true, test: { ok: false, error: 'DeepSeek rejected this key (401).', at: 1 } }],
    local_test: { ok: true, error: null, at: 2, target: 'http://localhost:11434/v1' },
  });
  assert.ok(!readFileSync(join(dir, 'provider-tests.json'), 'utf8').includes(DEEPSEEK));

  await reopened.save('deepseek', 'sk-another-key-that-is-long-enough');
  assert.equal(reopened.list().keys[0].test, null, 'a replaced key is untested');
  reopened.recordTest('deepseek', { ok: true, error: null, at: 3 });

  await reopened.remove('deepseek');
  assert.deepEqual(sent.at(-1), ['deepseek_api_key', null]);
  assert.equal(existsSync(join(dir, 'deepseek.key')), false);
  assert.deepEqual((await open()).list().keys, [], 'gone after a restart too, test and all');
  await assert.rejects(reopened.save('deepseek', '   '), /Paste a key first/);
});

test('without a secure store a key is used for this session only and never written', async (t) => {
  const { dir, sent, open } = setup(t, false);
  const providers = await open();
  assert.equal((await providers.save('anthropic', ANTHROPIC)).remembered, false);
  assert.deepEqual(sent, [['anthropic_api_key', ANTHROPIC]]);
  assert.equal(existsSync(join(dir, 'anthropic.key')), false);
  assert.deepEqual(providers.list().keys.map((entry) => entry.provider), ['anthropic']);
});

test('a mask shows at most seven characters of a long key and none of a short one; unknown providers are refused', () => {
  assert.equal(maskKey(DEEPSEEK), 'sk-…cdef');
  assert.equal(maskKey('sk-short-key'), '••••');
  assert.equal(keyedProvider('deepseek'), 'deepseek');
  for (const bad of ['mistral', 'openai_compatible', 'hasOwnProperty', 42]) assert.throws(() => keyedProvider(bad), /Unknown provider/);
});
