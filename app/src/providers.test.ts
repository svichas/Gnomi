import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, PROVIDER_DEFAULTS } from '@gnomi/simulation/settings.ts';
import { configuredProviders, egressList, routeOptions, routeProblem, withAvailableProvider, type ProviderEntry, type ProviderList } from './providers.ts';

const entry = (provider: ProviderEntry['provider']): ProviderEntry => ({ provider, masked: 'sk-…abcd', remembered: true, test: null });

test('a provider is configured once it has a key, and the local endpoint once the project gives it an address', () => {
  assert.deepEqual(configuredProviders([entry('deepseek'), entry('anthropic')], null), ['anthropic', 'deepseek']);
  assert.deepEqual(configuredProviders([], '  '), []);
  assert.deepEqual(configuredProviders([entry('openai')], 'http://localhost:11434/v1'), ['openai', 'openai_compatible']);
});

test('routes offer only configured providers, keep the one they use, and say what an unconfigured one needs', () => {
  const configured = configuredProviders([entry('anthropic'), entry('deepseek')], null);
  assert.deepEqual(routeOptions(configured, 'anthropic'), ['anthropic', 'deepseek']);
  assert.deepEqual(routeOptions(configured, 'openai'), ['anthropic', 'openai', 'deepseek'], 'a route to a removed provider stays visible');
  assert.equal(routeProblem('deepseek', configured), null);
  assert.equal(routeProblem('openai', configured), 'The selected AI provider is not connected. Add it under Providers or choose a connected provider.');
  assert.equal(routeProblem('openai_compatible', configured), 'The local endpoint has no address. Add it under Providers.');
});

test('one connected provider replaces unavailable routes, including the persona writer', () => {
  for (const provider of ['deepseek', 'openai', 'google'] as const) {
    const result = withAvailableProvider(DEFAULT_SETTINGS, [entry(provider)]);
    assert.deepEqual(result.routing, PROVIDER_DEFAULTS[provider]);
    assert.equal(result.screenshots, DEFAULT_SETTINGS.screenshots);
  }
  assert.equal(DEFAULT_SETTINGS.routing.persona_writer.provider, 'anthropic', 'defaults are not mutated');
});

test('a local endpoint alone supplies every task with its default model', () => {
  const settings = { ...DEFAULT_SETTINGS, local_base_url: 'http://localhost:11434/v1' };
  assert.deepEqual(withAvailableProvider(settings, []).routing, PROVIDER_DEFAULTS.openai_compatible);
});

test('connected routes keep their selected models while unavailable routes are repaired', () => {
  const settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, navigator: { provider: 'deepseek' as const, model: 'my-selected-model' } } };
  const result = withAvailableProvider(settings, [entry('deepseek')]);
  assert.deepEqual(result.routing.navigator, settings.routing.navigator);
  assert.deepEqual(result.routing.persona_writer, PROVIDER_DEFAULTS.deepseek.persona_writer);
  assert.equal(withAvailableProvider(result, [entry('deepseek')]), result, 'reconciling again is a no-op');
});

test('a check model on a provider that is gone falls back to the judge, and one still connected stays', () => {
  const check_model = { provider: 'openai' as const, model: 'my-check-model' };
  const settings = { ...DEFAULT_SETTINGS, finding_check: true, routing: PROVIDER_DEFAULTS.deepseek, check_model };
  const moved = withAvailableProvider(settings, [entry('deepseek')]);
  assert.equal(moved.check_model, undefined);
  assert.equal(moved.finding_check, true);
  assert.equal(withAvailableProvider(moved, [entry('deepseek')]), moved, 'reconciling again is a no-op');
  assert.deepEqual(withAvailableProvider(settings, [entry('openai')]).check_model, check_model);
  assert.equal(withAvailableProvider(settings, [entry('deepseek'), entry('openai')]), settings, 'with two connected nothing is chosen for you');
});

test('no provider or multiple connected providers do not silently choose a replacement', () => {
  assert.equal(withAvailableProvider(DEFAULT_SETTINGS, []), DEFAULT_SETTINGS);
  assert.equal(withAvailableProvider(DEFAULT_SETTINGS, [entry('deepseek'), entry('openai')]), DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, routing: PROVIDER_DEFAULTS.deepseek };
  assert.equal(withAvailableProvider(settings, [entry('deepseek'), entry('anthropic')]), settings);
});

test('the egress list names each connected provider and the local endpoint, and Figma only while a token is saved', () => {
  const list = (over: Partial<ProviderList>): ProviderList => ({ keys: [], local_test: null, figma: null, ...over });
  const hosts = (l: ProviderList, local: string | null = null) => egressList(l, local).map((e) => e.host);
  assert.deepEqual(hosts(list({})), []);
  assert.deepEqual(hosts(list({ keys: [entry('deepseek'), entry('google')] }), 'http://localhost:11434/v1'), ['api.deepseek.com', 'generativelanguage.googleapis.com', 'localhost:11434']);
  assert.deepEqual(hosts(list({ keys: [entry('anthropic')] }), 'not a url'), ['api.anthropic.com']);
  assert.deepEqual(hosts(list({ figma: { masked: 'fig…6789', remembered: true, test: null } })), ['api.figma.com', '*.amazonaws.com']);
});
