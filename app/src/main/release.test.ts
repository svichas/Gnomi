import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newerRelease } from './release.ts';

test('a release tag ahead of this build is offered, by number and not as text', () => {
  assert.equal(newerRelease('v0.2.2', '0.2.1'), '0.2.2');
  assert.equal(newerRelease('v0.10.0', '0.9.3'), '0.10.0');
  assert.equal(newerRelease('1.0.0', '0.2.1'), '1.0.0');
});

test('the same, an older or an unreadable tag offers nothing', () => {
  assert.equal(newerRelease('v0.2.1', '0.2.1'), null);
  assert.equal(newerRelease('v0.2.0', '0.2.1'), null);
  assert.equal(newerRelease('v0.2', '0.2.1'), null);
  assert.equal(newerRelease('nightly', '0.2.1'), null);
  assert.equal(newerRelease(undefined, '0.2.1'), null);
});
