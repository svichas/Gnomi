import type { Audience, ProviderId, Routing, RunSettings } from './types.ts';

// Model defaults per provider and role (tech.md §10.2). Pure: the renderer imports these too.
export const PROVIDER_DEFAULTS: Record<ProviderId, Routing> = {
  anthropic: {
    navigator: { provider: 'anthropic', model: 'claude-haiku-5-5' },
    socialiser: { provider: 'anthropic', model: 'claude-haiku-5-5' },
    persona_writer: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    judge: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    author: { provider: 'anthropic', model: 'claude-opus-5-5' },
  },
  openai: {
    navigator: { provider: 'openai', model: 'gpt-6-luna' },
    socialiser: { provider: 'openai', model: 'gpt-6-luna' },
    persona_writer: { provider: 'openai', model: 'gpt-6.1-sol' },
    judge: { provider: 'openai', model: 'gpt-6.1-sol' },
    author: { provider: 'openai', model: 'gpt-6.1-sol' },
  },
  google: {
    navigator: { provider: 'google', model: 'gemini-3.5-flash-lite' },
    socialiser: { provider: 'google', model: 'gemini-3.5-flash-lite' },
    persona_writer: { provider: 'google', model: 'gemini-3.8-flash' },
    judge: { provider: 'google', model: 'gemini-3.8-flash' },
    author: { provider: 'google', model: 'gemini-4-argon' },
  },
  openai_compatible: {
    navigator: { provider: 'openai_compatible', model: 'gemma4:e4b' },
    socialiser: { provider: 'openai_compatible', model: 'gemma4:e4b' },
    persona_writer: { provider: 'openai_compatible', model: 'qwen3:30b' },
    judge: { provider: 'openai_compatible', model: 'qwen3:30b' },
    author: { provider: 'openai_compatible', model: 'qwen3:30b' },
  },
};

export const DEFAULT_SETTINGS: RunSettings = {
  routing: PROVIDER_DEFAULTS.anthropic,
  local_base_url: null,
  concurrency: 12,
  cost_budget_usd: 5,
  wall_clock_budget_min: 60,
  screenshots: true,
  social: false,
  rounds: 5,
};

export const MAX_ROUNDS = 10;

/** R for a run (tech.md §6.4), or 0 when it has no social rounds: off in settings, or no audience to make a swarm. */
export function socialRounds(settings: RunSettings, audience: Audience | null): number {
  return settings.social && audience ? Math.min(MAX_ROUNDS, Math.max(1, Math.floor(settings.rounds ?? 5))) : 0;
}
