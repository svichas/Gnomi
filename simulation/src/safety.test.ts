import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedHosts, checkTarget, productionDomain } from './safety.ts';
import type { WebPoi } from './types.ts';

const poi = (over: Partial<WebPoi> = {}): WebPoi => ({
  id: 'poi-1',
  type: 'web',
  name: 'Acme',
  start_url: 'https://staging.acme.io/',
  allowed_hosts: [],
  production_domains: ['acme.com'],
  reset_hook_url: null,
  mode: 'full',
  segments: null,
  ...over,
});

test('production domains match themselves and their subdomains only', () => {
  assert.equal(productionDomain('acme.com', ['acme.com']), 'acme.com');
  assert.equal(productionDomain('App.Acme.com', [' *.ACME.com ']), 'acme.com');
  assert.equal(productionDomain('notacme.com', ['acme.com']), null);
  assert.equal(productionDomain('acme.com.evil.io', ['acme.com']), null);
});

test('checkTarget refuses listed production domains and malformed start pages', () => {
  assert.equal(checkTarget(poi()), null);
  assert.match(checkTarget(poi({ start_url: 'https://app.acme.com/jobs' })) ?? '', /^app\.acme\.com is on acme\.com, which this project lists as production\. Gnomi never runs against production/);
  assert.match(checkTarget(poi({ start_url: 'https://ACME.com/' })) ?? '', /lists as production/);
  assert.match(checkTarget(poi({ start_url: 'staging.acme.io' })) ?? '', /is not a web address Gnomi can open/);
});

test('a public host and a private address run without a staging marker', () => {
  assert.equal(checkTarget(poi({ start_url: 'https://acme.io/' })), null);
  assert.equal(checkTarget(poi({ start_url: 'http://192.168.1.20:3000/' })), null);
});

test('the reset hook must be http(s) on an allowed, non-production host', () => {
  assert.equal(checkTarget(poi({ reset_hook_url: 'https://staging.acme.io/__reset' })), null);
  assert.equal(checkTarget(poi({ reset_hook_url: 'https://hooks.acme.io/reset', allowed_hosts: ['hooks.acme.io'] })), null);
  const refused = /^The reset hook ".*" must be an http\(s\) address on one of this project's allowed hosts/;
  assert.match(checkTarget(poi({ reset_hook_url: 'https://hooks.acme.io/reset' })) ?? '', refused);
  assert.match(checkTarget(poi({ reset_hook_url: 'ftp://staging.acme.io/reset' })) ?? '', refused);
  assert.match(checkTarget(poi({ reset_hook_url: 'not a url' })) ?? '', refused);
  assert.match(checkTarget(poi({ reset_hook_url: 'https://api.acme.com/reset', allowed_hosts: ['api.acme.com'] })) ?? '', refused);
});

test('an observe-only POI may be a production site, but never a listed production domain and never with a reset hook', () => {
  const rival = poi({ mode: 'observe_only', name: 'Rival', start_url: 'https://rival.com/pricing' });
  assert.equal(checkTarget(rival), null, 'a competitor runs unless its host is a listed production domain');
  assert.match(checkTarget({ ...rival, production_domains: ['rival.com'] }) ?? '', /lists as production/);
  assert.match(checkTarget({ ...rival, reset_hook_url: 'https://rival.com/reset' }) ?? '', /"Rival" is observed only, so Gnomi never calls a reset hook on it/);
});

test('allowedHosts puts the start host first, lower-cased and de-duplicated', () => {
  assert.deepEqual(allowedHosts(poi({ allowed_hosts: ['CDN.acme.io', 'staging.acme.io', ' ', 'api.acme.io '] })), ['staging.acme.io', 'www.staging.acme.io', 'cdn.acme.io', 'api.acme.io']);
});

test('allowedHosts lets the start host redirect to its www twin and back, but never invents one for an address', () => {
  assert.deepEqual(allowedHosts(poi({ start_url: 'https://workable.com/pricing' })), ['workable.com', 'www.workable.com']);
  assert.deepEqual(allowedHosts(poi({ start_url: 'https://www.lever.co/' })), ['www.lever.co', 'lever.co']);
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1:8080/', 'http://[::1]/', 'https://www.com/'])
    assert.deepEqual(allowedHosts(poi({ start_url: url })), [new URL(url).hostname], url);
});
