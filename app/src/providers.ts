import { PROVIDER_DEFAULTS } from '@gnomi/engine/settings.ts';
import type { LlmRole, ProviderId, RunSettings } from '@gnomi/engine/types.ts';

// The provider list of the Settings page. Keys stay in main, encrypted by the OS; the page only ever sees what is here.

export type KeyedProvider = Exclude<ProviderId, 'openai_compatible'>; // the local endpoint needs an address, not a key
export const KEYED_PROVIDERS: KeyedProvider[] = ['anthropic', 'openai', 'google', 'deepseek'];

/** The last "Test key" of a provider. `target` is the address a local endpoint test reached; the result lapses when it changes. */
export interface KeyTest {
  ok: boolean;
  error: string | null;
  at: number;
  target?: string;
}

/** A provider with a saved key, as the page sees it. */
export interface ProviderEntry {
  provider: KeyedProvider;
  masked: string; // e.g. sk-…f3a9
  remembered: boolean; // false: this computer has no secure store, so the key lasts until Gnomi quits
  test: KeyTest | null;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  openai_compatible: 'Local endpoint',
};
const ALL = Object.keys(PROVIDER_LABELS) as ProviderId[];

/** What the Settings page reads: the saved keys, and the last test of the project's local endpoint. */
export interface ProviderList {
  keys: ProviderEntry[];
  local_test: KeyTest | null;
}

/** Providers a route can use: those with a saved key, and the local endpoint once the project gives it an address. */
export function configuredProviders(entries: ProviderEntry[], localBaseUrl: string | null): ProviderId[] {
  return ALL.filter((id) => (id === 'openai_compatible' ? !!localBaseUrl?.trim() : entries.some((entry) => entry.provider === id)));
}

/** When there is only one connected provider, use it for tasks whose provider is unavailable. Keep valid choices. */
export function withAvailableProvider(settings: RunSettings, entries: ProviderEntry[]): RunSettings {
  const configured = configuredProviders(entries, settings.local_base_url);
  if (configured.length !== 1) return settings;
  const provider = configured[0];
  const missing = (Object.keys(settings.routing) as LlmRole[]).filter((role) => settings.routing[role].provider !== provider);
  if (!missing.length) return settings;
  const routing = { ...settings.routing };
  for (const role of missing) routing[role] = { ...PROVIDER_DEFAULTS[provider][role] };
  return { ...settings, routing };
}

/** What a route needs before its provider can answer, or null. */
export function routeProblem(provider: ProviderId, configured: ProviderId[]): string | null {
  if (configured.includes(provider)) return null;
  return provider === 'openai_compatible' ? 'The local endpoint has no address. Add it under Providers.' : 'The selected AI provider is not connected. Add it under Providers or choose a connected provider.';
}

/** A route's provider choices: the configured ones, plus the one it uses now, so a route to a removed provider stays visible and flagged. */
export const routeOptions = (configured: ProviderId[], current: ProviderId): ProviderId[] => ALL.filter((id) => id === current || configured.includes(id));
