import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedHosts, checkTarget, looksLikeStaging, productionDomain } from './safety.ts';
import type { WebPoi } from './types.ts';

const poi = (over: Partial<WebPoi> = {}): WebPoi => ({
  id: 'poi-1',
  type: 'web',
  name: 'Acme',
  start_url: 'https://staging.acme.io/',
  allowed_hosts: [],
  production_domains: ['acme.com'],
  not_production: false,
  reset_hook_url: null,
  mode: 'full',
  segments: null,
  ...over,
});

test('staging markers count only as whole hostname tokens', () => {
  for (const host of ['staging.acme.com', 'acme-stage.io', 'app.test', 'dev.acme.com', 'qa-eu.acme.com', 'sandbox.acme.io', 'preview--shop.netlify.app', 'acme.local', 'localhost', 'STAGING.Acme.com', 'staging.acme.com.'])
    assert.ok(looksLikeStaging(host), host);
  for (const host of ['devtools.com', 'latest.io', 'contest.acme.com', 'stagecoach.com', 'acme.com', 'qatar.example', 'localhosting.com', 'testimonials.acme.com', 'developer.acme.com'])
    assert.ok(!looksLikeStaging(host), host);
});

test('loopback and private addresses count as staging, public ones do not', () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.1.1', '[::1]', '::1', '[fd12:3456::1]', 'fe80::1'])
    assert.ok(looksLikeStaging(host), host);
  for (const host of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '11.0.0.1', '[2001:db8::1]', '256.1.1.1', 'fcbarcelona.com'])
    assert.ok(!looksLikeStaging(host), host);
});

test('production domains match themselves and their subdomains only', () => {
  assert.equal(productionDomain('acme.com', ['acme.com']), 'acme.com');
  assert.equal(productionDomain('App.Acme.com', [' *.ACME.com ']), 'acme.com');
  assert.equal(productionDomain('notacme.com', ['acme.com']), null);
  assert.equal(productionDomain('acme.com.evil.io', ['acme.com']), null);
});

test('checkTarget refuses production, even when confirmed as not production', () => {
  assert.equal(checkTarget(poi()), null);
  assert.match(checkTarget(poi({ start_url: 'https://app.acme.com/jobs' })) ?? '', /^app\.acme\.com is on acme\.com, which this project lists as production\. Gnomi never runs against production/);
  assert.match(checkTarget(poi({ start_url: 'https://ACME.com/', not_production: true })) ?? '', /lists as production/);
  assert.match(checkTarget(poi({ start_url: 'staging.acme.io' })) ?? '', /is not a web address Gnomi can open/);
});

test('a host with no staging marker needs the not-production confirmation', () => {
  assert.match(checkTarget(poi({ start_url: 'https://acme.io/' })) ?? '', /acme\.io does not look like a staging or test address\. If it is not production, confirm "This is not production"/);
  assert.equal(checkTarget(poi({ start_url: 'https://acme.io/', not_production: true })), null);
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
  assert.equal(checkTarget(rival), null, 'a competitor needs no not-production confirmation');
  assert.match(checkTarget({ ...rival, production_domains: ['rival.com'] }) ?? '', /lists as production/);
  assert.match(checkTarget({ ...rival, reset_hook_url: 'https://rival.com/reset' }) ?? '', /"Rival" is observed only, so Gnomi never calls a reset hook on it/);
});

test('allowedHosts puts the start host first, lower-cased and de-duplicated', () => {
  assert.deepEqual(allowedHosts(poi({ allowed_hosts: ['CDN.acme.io', 'staging.acme.io', ' ', 'api.acme.io '] })), ['staging.acme.io', 'cdn.acme.io', 'api.acme.io']);
});
