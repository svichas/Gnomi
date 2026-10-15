import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectConfig, SessionInfo } from '@gnomi/engine/types.ts';
import { hostOf, hostToConfirm, initialForm, offeredHosts, startHost, toConfig } from './form.ts';
import type { Form } from './form.ts';

const form = (changes: Partial<Form> = {}): Form => ({ ...initialForm(null), name: 'Gym', url: 'http://localhost:3000', goal: 'Post a job', ...changes });

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
  assert.equal(toConfig({ ...prod, confirmedHost: 'other.acme.com' }), 'Confirm that this is not a production site.');
  const confirmed = toConfig({ ...prod, confirmedHost: 'app.acme.com' });
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
  assert.deepEqual(initialForm(before as unknown as ProjectConfig), {
    name: 'Gym',
    description: 'd',
    url: 'http://localhost:3000',
    goal: 'g',
    confirmedHost: null,
    production: '',
    reset: '',
    allowed: [],
    role: null,
  });
});

test('offeredHosts lists recorded, allowed and added hosts once each, never the start page', () => {
  const session = (hosts: string[]): SessionInfo => ({ role: 'r', start_url: 'http://localhost/', hosts, recorded_at: 1, verified_at: null, expires_at: null });
  assert.deepEqual(
    offeredHosts([session(['localhost', 'cdn.example.com', 'API.example.com']), session(['cdn.example.com'])], ['api.example.com', 'old.example.com'], ['new.example.com'], 'localhost'),
    ['api.example.com', 'cdn.example.com', 'new.example.com', 'old.example.com'],
  );
});
