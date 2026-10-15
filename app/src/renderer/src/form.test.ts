import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '@gnomi/engine/settings.ts';
import type { ProjectConfig, RunSettings, SessionInfo } from '@gnomi/engine/types.ts';
import { getPersonaSchema } from '@gnomi/engine/profile/schema.ts';
import { blankAudience } from './audience.ts';
import { hostOf, hostToConfirm, initialDraft, offeredHosts, problemFor, startHost, toConfig } from './form.ts';
import type { Draft, Form } from './form.ts';

const form = (changes: Partial<Form> = {}, rest: Partial<Omit<Draft, 'form'>> = {}): Draft => ({
  form: { ...initialDraft(null).form, name: 'Gym', url: 'http://localhost:3000', goal: 'Post a job', ...changes },
  settings: DEFAULT_SETTINGS,
  audience: null,
  ...rest,
});

test('hostOf takes a bare host, a host with a port, or a whole address, and refuses anything else', () => {
  assert.equal(hostOf('cdn.example.com'), 'cdn.example.com');
  assert.equal(hostOf('  CDN.Example.com:8443 '), 'cdn.example.com');
  assert.equal(hostOf('https://api.example.com/v1/x?y=1#z'), 'api.example.com');
  assert.equal(hostOf('127.0.0.1:3000'), '127.0.0.1');
  assert.equal(hostOf('not a host'), null);
  assert.equal(hostOf(''), null);
});

test('startHost is only for http(s) addresses', () => {
  assert.equal(startHost('http://localhost:3000/x'), 'localhost');
  assert.equal(startHost('localhost:3000'), null); // parses as a URL with the scheme "localhost:"
  assert.equal(startHost('ftp://example.com'), null);
});

test('a host without a staging marker has to be confirmed, and the confirmation belongs to that host', () => {
  assert.equal(hostToConfirm('http://localhost:3000'), null);
  assert.equal(hostToConfirm('https://staging.acme.com'), null);
  assert.equal(hostToConfirm('https://app.acme.com'), 'app.acme.com');

  const prod = form({ url: 'https://app.acme.com' });
  assert.equal(toConfig(prod), 'Confirm that this is not a production site.');
  assert.equal(toConfig(form({ url: 'https://app.acme.com', confirmedHost: 'other.acme.com' })), 'Confirm that this is not a production site.');
  const confirmed = toConfig(form({ url: 'https://app.acme.com', confirmedHost: 'app.acme.com' }));
  assert.ok(typeof confirmed !== 'string' && confirmed.poi.not_production);
  const staging = toConfig(form({ confirmedHost: 'localhost' }));
  assert.ok(typeof staging !== 'string' && !staging.poi.not_production, 'a staging-looking host is never marked as confirmed');
});

test('toConfig builds the POI with its safety settings and names what is missing', () => {
  assert.equal(toConfig(form({ name: ' ' })), 'Give the project a name.');
  assert.match(String(toConfig(form({ url: 'staging.example.com' }))), /full web address/);
  assert.equal(toConfig(form({ goal: '' })), 'Say what the persona should try to do.');
  assert.match(String(toConfig(form({ production: 'acme.com, not a domain' }))), /"not a domain" is not a domain name/);
  assert.match(String(toConfig(form({ reset: 'nope' }))), /reset hook/);

  const config = toConfig(
    form({ production: 'Acme.com, https://app.acme.com/x, acme.com', reset: ' http://localhost:3000/reset ', allowed: ['cdn.example.com', 'localhost', 'cdn.example.com'], role: 'recruiter' }),
  );
  assert.ok(typeof config !== 'string');
  assert.deepEqual(config.poi, {
    id: 'poi-1',
    type: 'web',
    name: 'localhost',
    start_url: 'http://localhost:3000',
    allowed_hosts: ['cdn.example.com'], // the start page's own host is always allowed, so it is not listed
    production_domains: ['acme.com', 'app.acme.com'],
    not_production: false,
    reset_hook_url: 'http://localhost:3000/reset',
  });
  assert.equal(config.role, 'recruiter');
});

test('a project saved before M1 opens with empty safety settings and logged out', () => {
  const before = { name: 'Gym', description: 'd', goal: 'g', poi: { id: 'poi-1', type: 'web', name: 'localhost', start_url: 'http://localhost:3000' } };
  assert.deepEqual(initialDraft(before as unknown as ProjectConfig), {
    form: {
      name: 'Gym',
      description: 'd',
      url: 'http://localhost:3000',
      goal: 'g',
      confirmedHost: null,
      production: '',
      reset: '',
      allowed: [],
      role: null,
    },
    settings: DEFAULT_SETTINGS,
    audience: null,
  });
});

test('offeredHosts lists recorded, allowed and added hosts once each, never the start page', () => {
  const session = (hosts: string[]): SessionInfo => ({ role: 'r', start_url: 'http://localhost/', hosts, recorded_at: 1, verified_at: null, expires_at: null });
  assert.deepEqual(
    offeredHosts([session(['localhost', 'cdn.example.com', 'API.example.com']), session(['cdn.example.com'])], ['api.example.com', 'old.example.com'], ['new.example.com'], 'localhost'),
    ['api.example.com', 'cdn.example.com', 'new.example.com', 'old.example.com'],
  );
});

test('the run settings are checked, and a problem is worded for the tab that shows it', () => {
  const settings = (changes: Partial<RunSettings>) => form({}, { settings: { ...DEFAULT_SETTINGS, ...changes } });
  assert.equal(typeof toConfig(settings({})), 'object');
  assert.match(String(toConfig(settings({ concurrency: 33 }))), /^Settings: concurrency must be a whole number from 1 to 32/);
  assert.match(String(toConfig(settings({ concurrency: 0 }))), /concurrency/);
  assert.match(String(toConfig(settings({ cost_budget_usd: 0 }))), /cost budget/);
  assert.match(String(toConfig(settings({ wall_clock_budget_min: -1 }))), /time budget/);
  assert.match(String(toConfig(settings({ local_base_url: 'localhost:11434' }))), /local endpoint/);
  const local = { ...DEFAULT_SETTINGS.routing, navigator: { provider: 'openai_compatible' as const, model: 'gemma4:e4b' } };
  assert.match(String(toConfig(settings({ routing: local }))), /navigator uses the local endpoint/);
  assert.equal(typeof toConfig(settings({ routing: local, local_base_url: ' http://localhost:11434/v1 ' })), 'object');
  assert.match(String(toConfig(settings({ routing: { ...DEFAULT_SETTINGS.routing, judge: { provider: 'anthropic', model: ' ' } } }))), /model for the judge/);

  assert.equal(problemFor('Settings: concurrency must be a whole number from 1 to 32.', 'settings'), 'concurrency must be a whole number from 1 to 32.');
  assert.equal(problemFor('Settings: concurrency must be a whole number from 1 to 32.', 'project'), 'Settings: concurrency must be a whole number from 1 to 32.');
  assert.equal(problemFor('Give the project a name.', 'audience'), 'On the Project tab: Give the project a name.');
  assert.equal(problemFor('Give the project a name.', 'project'), 'Give the project a name.');
});

test('the audience goes into the project cleaned up, or stops the save with a sentence', () => {
  const audience = blankAudience('An ATS');
  audience.segments[0] = { ...audience.segments[0], name: ' Recruiters ', typical_goals: ['post jobs', '  ', ' screen '], goal_override: '  ' };
  const config = toConfig(form({}, { audience }));
  assert.ok(typeof config !== 'string');
  assert.deepEqual(config.audience?.segments[0].typical_goals, ['post jobs', 'screen']);
  assert.equal(config.audience?.segments[0].name, 'Recruiters');
  assert.equal(config.audience?.segments[0].goal_override, null);
  assert.match(String(toConfig(form({}, { audience: { ...audience, persona_count: 2 } }))), /^Audience: the persona count/);
});

test('profile schemas round-trip only when configured and invalid schemas stop project save', () => {
  assert.equal(Object.hasOwn(initialDraft(null), 'persona_schema'), false);
  const original = toConfig(form());
  assert.ok(typeof original !== 'string');
  assert.equal(Object.hasOwn(original, 'persona_schema'), false);
  const persona_schema = getPersonaSchema();
  persona_schema.attributes.find((attribute) => attribute.id === 'employer')!.enabled = false;
  const configured = toConfig(form({}, { persona_schema }));
  assert.ok(typeof configured !== 'string');
  assert.deepEqual(initialDraft(configured).persona_schema, persona_schema);
  persona_schema.attributes.find((attribute) => attribute.id === 'name')!.enabled = false;
  assert.match(String(toConfig(form({}, { persona_schema }))), /^Audience:.*Core/);
});
