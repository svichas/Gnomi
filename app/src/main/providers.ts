import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretName } from '@gnomi/simulation/seams.ts';
import type { ProviderId } from '@gnomi/simulation/types.ts';
import { KEYED_PROVIDERS, type FigmaEntry, type KeyedProvider, type KeyTest, type ProviderEntry, type ProviderList } from '../providers.ts';

// One encrypted file per key, under the names they have had since M0, so keys saved before the list simply appear in it.
const KEYS: Record<KeyedProvider, { file: string; secret: SecretName }> = {
  anthropic: { file: 'anthropic.key', secret: 'anthropic_api_key' },
  openai: { file: 'openai.key', secret: 'openai_api_key' },
  google: { file: 'google.key', secret: 'google_api_key' },
  deepseek: { file: 'deepseek.key', secret: 'deepseek_api_key' },
};
const FIGMA = { file: 'figma.key', secret: 'figma_token' } as const satisfies { file: string; secret: SecretName };
const TESTS = 'provider-tests.json';

/** Where keys are kept: plain files only this user can read in the app (fileVault), stand-ins in tests. Names are relative to the folder. */
export interface Vault {
  read(file: string): Promise<string | null>;
  write(file: string, value: string): Promise<void>;
  /** False where the OS has no secure store: a key then lasts until Gnomi quits. */
  canRemember(): Promise<boolean>;
}

/**
 * Keys as plain files with mode 0600, not safeStorage, so macOS never asks for Keychain access. A file safeStorage wrote
 * (up to 0.3.0) starts with its "v10" or "v11" prefix, which no key or hex session key does: `decrypt` reads it a last
 * time and it is rewritten plain.
 */
export function fileVault(dir: string, decrypt: (data: Buffer) => Promise<string>): Vault {
  const path = (file: string) => join(dir, file);
  const write = async (file: string, value: string) => writeFileSync(path(file), value, { mode: 0o600 });
  return {
    async read(file) {
      if (!existsSync(path(file))) return null;
      const data = readFileSync(path(file));
      if (!/^v1[01]/.test(data.toString('latin1', 0, 3))) return data.toString('utf8');
      try {
        const value = await decrypt(data);
        await write(file, value);
        return value;
      } catch {
        console.warn(`${file} could not be decrypted and is ignored.`); // never the value
        return null;
      }
    },
    write,
    canRemember: async () => true,
  };
}

/** Enough of a key to tell two apart: its first three and last four characters, and nothing of a short one. */
export const maskKey = (key: string) => (key.length >= 20 ? `${key.slice(0, 3)}…${key.slice(-4)}` : '••••');

export function keyedProvider(value: unknown): KeyedProvider {
  if (typeof value === 'string' && Object.hasOwn(KEYS, value)) return value as KeyedProvider;
  throw new Error('Unknown provider');
}

type Tested = ProviderId | 'figma';

function readTests(path: string): Partial<Record<Tested, KeyTest>> {
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
  private figma: { masked: string; remembered: boolean } | null = null;
  private readonly tests: Partial<Record<Tested, KeyTest>>;
  private readonly dir: string;
  private readonly vault: Vault;
  private readonly send: (name: SecretName, value: string | null) => Promise<unknown>;

  constructor(dir: string, vault: Vault, send: (name: SecretName, value: string | null) => Promise<unknown>) {
    this.dir = dir;
    this.vault = vault;
    this.send = send;
    this.tests = readTests(join(dir, TESTS));
  }

  /** Hands every saved key to the engine, one at a time so a key file left by safeStorage asks for Keychain access once. */
  async load() {
    for (const provider of KEYED_PROVIDERS) {
      const key = await this.vault.read(KEYS[provider].file);
      if (!key) continue;
      await this.send(KEYS[provider].secret, key);
      this.saved.set(provider, { masked: maskKey(key), remembered: true });
    }
    const token = await this.vault.read(FIGMA.file);
    if (token) {
      await this.send(FIGMA.secret, token);
      this.figma = { masked: maskKey(token), remembered: true };
    }
  }

  list(): ProviderList {
    const keys = KEYED_PROVIDERS.flatMap((provider) => {
      const saved = this.saved.get(provider);
      return saved ? [{ provider, ...saved, test: this.tests[provider] ?? null }] : [];
    });
    return { keys, local_test: this.tests.openai_compatible ?? null, figma: this.figma && { ...this.figma, test: this.tests.figma ?? null } };
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

  /** Adds the Figma token, or replaces it. It is held like a provider's key: encrypted on disk, sent to the engine, shown masked. */
  async saveFigma(token: string): Promise<FigmaEntry> {
    const value = token.trim();
    if (!value) throw new Error('Paste a token first');
    if (!/^[\x21-\x7e]+$/.test(value)) throw new Error('That does not look like a Figma token. Paste the token alone, without spaces or line breaks.');
    await this.send(FIGMA.secret, value);
    const remembered = await this.vault.canRemember();
    if (remembered) await this.vault.write(FIGMA.file, value);
    this.figma = { masked: maskKey(value), remembered };
    this.recordTest('figma', null);
    return { ...this.figma, test: null };
  }

  async removeFigma() {
    rmSync(join(this.dir, FIGMA.file), { force: true });
    await this.send(FIGMA.secret, null);
    this.figma = null;
    this.recordTest('figma', null);
  }

  recordTest(provider: Tested, test: KeyTest | null) {
    if (test) this.tests[provider] = test;
    else delete this.tests[provider];
    writeFileSync(join(this.dir, TESTS), JSON.stringify(this.tests));
  }
}
