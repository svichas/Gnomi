import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretName } from '@gnomi/engine/seams.ts';
import type { ProviderId } from '@gnomi/engine/types.ts';
import { KEYED_PROVIDERS, type KeyedProvider, type KeyTest, type ProviderEntry, type ProviderList } from '../providers.ts';

// One encrypted file per key, under the names they have had since M0, so keys saved before the list simply appear in it.
const KEYS: Record<KeyedProvider, { file: string; secret: SecretName }> = {
  anthropic: { file: 'anthropic.key', secret: 'anthropic_api_key' },
  openai: { file: 'openai.key', secret: 'openai_api_key' },
  google: { file: 'google.key', secret: 'google_api_key' },
  deepseek: { file: 'deepseek.key', secret: 'deepseek_api_key' },
};
const TESTS = 'provider-tests.json';

/** Where keys are kept: files encrypted by the OS (safeStorage) in the app, stand-ins in tests. Names are relative to the folder. */
export interface Vault {
  read(file: string): Promise<string | null>;
  write(file: string, value: string): Promise<void>;
  /** False where the OS has no secure store: a key then lasts until Gnomi quits. */
  canRemember(): Promise<boolean>;
}

/** Enough of a key to tell two apart: its first three and last four characters, and nothing of a short one. */
export const maskKey = (key: string) => (key.length >= 20 ? `${key.slice(0, 3)}…${key.slice(-4)}` : '••••');

export function keyedProvider(value: unknown): KeyedProvider {
  if (typeof value === 'string' && Object.hasOwn(KEYS, value)) return value as KeyedProvider;
  throw new Error('Unknown provider');
}

function readTests(path: string): Partial<Record<ProviderId, KeyTest>> {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {}; // none yet, or unreadable: the rows say "not tested"
  }
}

/**
 * The providers with a saved key. Main hands each key to the engine (`send`) and keeps only its mask; the last test of
 * each provider is kept in provider-tests.json beside the key files, with no key in it.
 */
export class ProviderKeys {
  private readonly saved = new Map<KeyedProvider, { masked: string; remembered: boolean }>();
  private readonly tests: Partial<Record<ProviderId, KeyTest>>;
  private readonly dir: string;
  private readonly vault: Vault;
  private readonly send: (name: SecretName, value: string | null) => Promise<unknown>;

  constructor(dir: string, vault: Vault, send: (name: SecretName, value: string | null) => Promise<unknown>) {
    this.dir = dir;
    this.vault = vault;
    this.send = send;
    this.tests = readTests(join(dir, TESTS));
  }

  /** Hands every saved key to the engine, one at a time so macOS asks for Keychain access once. */
  async load() {
    for (const provider of KEYED_PROVIDERS) {
      const key = await this.vault.read(KEYS[provider].file);
      if (!key) continue;
      await this.send(KEYS[provider].secret, key);
      this.saved.set(provider, { masked: maskKey(key), remembered: true });
    }
  }

  list(): ProviderList {
    const keys = KEYED_PROVIDERS.flatMap((provider) => {
      const saved = this.saved.get(provider);
      return saved ? [{ provider, ...saved, test: this.tests[provider] ?? null }] : [];
    });
    return { keys, local_test: this.tests.openai_compatible ?? null };
  }

  /** Adds a provider, or replaces its key; the old key's test no longer applies. */
  async save(provider: KeyedProvider, key: string): Promise<ProviderEntry> {
    const value = key.trim();
    if (!value) throw new Error('Paste a key first');
    await this.send(KEYS[provider].secret, value);
    const remembered = await this.vault.canRemember();
    if (remembered) await this.vault.write(KEYS[provider].file, value);
    this.saved.set(provider, { masked: maskKey(value), remembered });
    this.recordTest(provider, null);
    return { provider, masked: maskKey(value), remembered, test: null };
  }

  async remove(provider: KeyedProvider) {
    rmSync(join(this.dir, KEYS[provider].file), { force: true });
    await this.send(KEYS[provider].secret, null);
    this.saved.delete(provider);
    this.recordTest(provider, null);
  }

  recordTest(provider: ProviderId, test: KeyTest | null) {
    if (test) this.tests[provider] = test;
    else delete this.tests[provider];
    writeFileSync(join(this.dir, TESTS), JSON.stringify(this.tests));
  }
}
