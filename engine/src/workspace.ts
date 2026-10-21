// The project work that does not depend on how a client reaches the engine: host.ts (the app) and cli.ts (a terminal) share it.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_PERSONA_WRITER, type AudienceDeps } from './audience/index.ts';
import { assetPath } from '@gnomi/simulation/assets.ts';
import { effectiveComparisonPois, validateComparison } from '@gnomi/simulation/comparison/config.ts';
import { createGateway } from '@gnomi/simulation/llm/gateway.ts';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, DEMO_NAVIGATOR, DEMO_SOCIALISER } from '@gnomi/simulation/llm/scripted.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { preflight } from '@gnomi/simulation/poi/index.ts';
import { webPois } from '@gnomi/simulation/poi/pois.ts';
import { validatePersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import { personaProfileIsCurrent } from '@gnomi/simulation/profile/signature.ts';
import type { LlmGateway, ProjectStore, Recorder, SecretName } from '@gnomi/simulation/seams.ts';
import type { Persona, PersonaProgress, ProjectConfig, ProviderId } from '@gnomi/simulation/types.ts';

export const KEYS: Record<Exclude<ProviderId, 'openai_compatible'>, { secret: SecretName; label: string }> = {
  anthropic: { secret: 'anthropic_api_key', label: 'an Anthropic' },
  openai: { secret: 'openai_api_key', label: 'an OpenAI' },
  google: { secret: 'google_api_key', label: 'a Google' },
  deepseek: { secret: 'deepseek_api_key', label: 'a DeepSeek' },
};

export type Secrets = (name: SecretName) => string | null;

/** What a provider needs before any call: the local endpoint for openai_compatible, else its key. */
export const credential = (provider: ProviderId, localBaseUrl: string | null | undefined, secrets: Secrets) =>
  provider === 'openai_compatible' ? localBaseUrl || null : secrets(KEYS[provider].secret);

/** The model gateway for this project's routing, or scripted answers with no key and no cost; onThrottle tells a run to back off (tech.md §9.5). */
export function projectGateway(opts: { fake: boolean; secrets: Secrets; config: ProjectConfig; record: Recorder; onThrottle?: (provider: ProviderId) => void }): LlmGateway {
  if (opts.fake) return createScriptedGateway({ navigator: DEMO_NAVIGATOR, socialiser: DEMO_SOCIALISER, persona_writer: DEMO_PERSONA_WRITER, judge: DEMO_JUDGE, author: DEMO_AUTHOR }, opts.record);
  return createGateway({ secrets: { get: opts.secrets }, localBaseUrl: opts.config.settings.local_base_url, record: opts.record, onThrottle: opts.onThrottle });
}

/** What the audience builder needs for this project: setup calls and drafts go to its store, progress to emit. */
export function audienceDeps(store: ProjectStore, config: ProjectConfig, llm: LlmGateway, opts: { signal?: AbortSignal; emit?: (progress: PersonaProgress) => void } = {}): AudienceDeps {
  // Proposed segments may only use logins that were actually recorded (metadata only, no session key needed).
  const roles = store.listSessions().map((s) => s.role);
  const task_id = randomUUID();
  const started = Date.now();
  const progress: PersonaProgress = { done: 0, total: 0, calls: 0, failed_attempts: 0, stage: 'sketching' };
  const notify = () => opts.emit?.({ ...progress, elapsed_ms: Date.now() - started });
  return {
    llm, model: config.settings.routing.persona_writer, project: config, roles,
    signal: opts.signal,
    cache: { get: (key) => store.getPersonaDraft(key), set: (key, value) => store.putPersonaDraft(key, value) },
    onProgress(done, total, persona) {
      Object.assign(progress, { done, total });
      if (persona) progress.recent = [persona.name, ...(progress.recent ?? [])].slice(0, 3);
      notify();
    },
    onSketched(sketched) { progress.sketched = sketched; notify(); },
    onStage(stage) { progress.stage = stage; notify(); },
    onAttempt(req, attempt) {
      store.recordSetupCall({ task_id, persona_id: req.persona_id, purpose: req.purpose ?? 'setup' }, attempt);
      progress.calls!++;
      if (attempt.payload.status !== 'ok') progress.failed_attempts!++;
      notify();
    },
  };
}

/** Who runs: the generated population, or the built-in persona when the project has no audience. */
export function population(store: ProjectStore, config: ProjectConfig): Persona[] {
  return config.audience ? store.listPersonas() : [BUILTIN_PERSONA];
}

export function checkComparison(config: ProjectConfig) {
  const comparisonProblems = validateComparison(config);
  if (comparisonProblems.length) throw new Error(`Comparison: ${comparisonProblems.join(' ')}`);
}

/** The preflight of tech.md §9.1 and §9.3 short of checking recorded logins: never production, every POI's own, personas current, keys present. Returns who runs. */
export function checkRun(store: ProjectStore, config: ProjectConfig, opts: { reset: boolean; fake: boolean; secrets: Secrets }): Persona[] {
  checkComparison(config);
  const refusal = preflight(config, (id) => { try { return existsSync(join(store.dir, assetPath(id))); } catch { return false; } });
  if (refusal) throw new Error(refusal);
  if (opts.reset && !webPois(effectiveComparisonPois(config)).some((poi) => poi.reset_hook_url)) throw new Error('This project has no reset hook for the configured access scope. Add one in the project settings, or start without resetting.');
  const personas = population(store, config);
  if (!personas.length) throw new Error('This audience has no personas yet. Generate them before starting a run.');
  const generatedCount = store.getGeneratedPersonaCount();
  if (config.audience && generatedCount !== null && generatedCount !== config.audience.persona_count) throw new Error('The persona count has changed. Generate personas again before starting a run.');
  if (config.persona_schema !== undefined) validatePersonaSchema(config.persona_schema);
  if (config.persona_schema && !config.audience) throw new Error('Create an audience and generate its personas before running a configured profile.');
  if (config.audience && personas.some((person) =>
    // Old projects had no writer-input signature; retain their saved profiles until a schema is configured.
    !(config.persona_schema === undefined && person.profile_signature === undefined) && !personaProfileIsCurrent(person, config),
  )) throw new Error('Profile inputs have changed. Generate personas again to refresh their biographies before starting a run.');
  for (const role of config.comparison ? ['navigator', 'judge'] as const : ['navigator'] as const) {
    const provider = config.settings.routing[role].provider;
    if (!opts.fake && !credential(provider, config.settings.local_base_url, opts.secrets)) throw new Error(provider === 'openai_compatible' ? 'Set the local model endpoint in the project settings first' : `Add ${KEYS[provider].label} key in Settings: the ${role} runs on it`);
  }
  return personas;
}
