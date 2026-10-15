import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuredProviders, routeOptions, routeProblem, type ProviderEntry } from './providers.ts';

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
  assert.equal(routeProblem('openai', configured), 'No OpenAI key is saved. Add one under Providers.');
  assert.equal(routeProblem('openai_compatible', configured), 'The local endpoint has no address. Add it under Providers.');
});
