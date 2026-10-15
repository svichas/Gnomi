import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { StorageState } from './seams.ts';
import { createFsBlobStore } from './log/blobs.ts';
import { openProject } from './log/sqlite.ts';
import { createSessionStore } from './sessions.ts';
import type { SessionInfo } from './types.ts';

const KEY = randomBytes(32).toString('hex');
const OTHER_KEY = randomBytes(32).toString('hex');
const LOST = 'The saved login for recruiter cannot be decrypted on this machine; record it again';

const info = (role: string): SessionInfo => ({
  role,
  start_url: 'http://localhost:3001/app',
  hosts: ['localhost', 'cdn.example.com'],
  recorded_at: 1000,
  verified_at: null,
  expires_at: 9_999_999,
});

// Canary values: they must never appear in the stored blob.
const state: StorageState = {
  cookies: [{ name: 'session', value: 'COOKIE-CANARY-7731', domain: 'localhost', path: '/', httpOnly: true }],
  origins: [{ origin: 'http://localhost:3001', localStorage: [{ name: 'token', value: 'LOCAL-CANARY-9902' }] }],
};

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-sessions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openProject(dir);
  const blobs = createFsBlobStore(dir);
  return { dir, store, blobs, sessions: createSessionStore(store, blobs, KEY) };
}

test('a saved login loads back with its metadata', async (t) => {
  const { sessions } = setup(t);
  await sessions.save(info('recruiter'), state);
  assert.deepEqual(await sessions.load('recruiter'), { info: info('recruiter'), state });
  assert.deepEqual(sessions.list(), [info('recruiter')]);
  assert.equal(await sessions.load('admin'), null);
});

test('the stored blob holds neither cookie values nor plaintext', async (t) => {
  const { blobs, sessions } = setup(t);
  await sessions.save(info('recruiter'), state);
  const blob = Buffer.from(await blobs.get('sessions/recruiter.session'));
  assert.equal(blob[0], 1);
  for (const secret of ['COOKIE-CANARY-7731', 'LOCAL-CANARY-9902', '"cookies"', '"origins"', 'localhost']) {
    assert.equal(blob.includes(secret), false, secret);
  }
});

test('a wrong key, a flipped byte and a blob copied to another role each fail with the same message', async (t) => {
  const { store, blobs, sessions } = setup(t);
  await sessions.save(info('recruiter'), state);
  await assert.rejects(createSessionStore(store, blobs, OTHER_KEY).load('recruiter'), { message: LOST });

  const blob = Buffer.from(await blobs.get('sessions/recruiter.session'));
  blob[blob.length - 1] ^= 0x01;
  await blobs.put('sessions/recruiter.session', blob);
  await assert.rejects(sessions.load('recruiter'), { message: LOST });

  await sessions.save(info('recruiter'), state);
  await sessions.save(info('admin'), state);
  await blobs.put('sessions/admin.session', await blobs.get('sessions/recruiter.session'));
  await assert.rejects(sessions.load('admin'), {
    message: 'The saved login for admin cannot be decrypted on this machine; record it again',
  });
});

test('a missing blob asks for a new recording rather than failing differently', async (t) => {
  const { dir, sessions } = setup(t);
  await sessions.save(info('recruiter'), state);
  rmSync(join(dir, 'sessions', 'recruiter.session'));
  await assert.rejects(sessions.load('recruiter'), { message: LOST });
});

test('bad role names are refused and good ones accepted', async (t) => {
  const { sessions } = setup(t);
  // Uppercase is refused: on a case-insensitive disk Admin and admin would share one file.
  for (const bad of ['', '../x', 'a/b', 'a.b', '-x', '_x', 'a'.repeat(41), 'Recruiter']) {
    await assert.rejects(sessions.save({ ...info('x'), role: bad }, state), /Invalid role name/, bad);
    await assert.rejects(sessions.load(bad), /Invalid role name/, bad);
  }
  for (const good of ['a', 'recruiter-2_b', 'a'.repeat(40)]) {
    await sessions.save({ ...info('x'), role: good }, state);
    assert.equal((await sessions.load(good))?.info.role, good);
  }
});

test('bad session keys are refused', (t) => {
  const { store, blobs } = setup(t);
  for (const bad of ['', 'abc', 'g'.repeat(64), '0'.repeat(63), '0'.repeat(66)]) {
    assert.throws(() => createSessionStore(store, blobs, bad), /64 hex characters/, bad);
  }
});

test('markVerified updates verified_at and refuses an unknown role', async (t) => {
  const { sessions } = setup(t);
  await sessions.save(info('recruiter'), state);
  sessions.markVerified('recruiter', 5000);
  assert.equal(sessions.list()[0].verified_at, 5000);
  assert.throws(() => sessions.markVerified('admin', 1), /No recorded login for admin/);
});

test('two saves of the same state write different blobs, with a fresh IV each time', async (t) => {
  const { blobs, sessions } = setup(t);
  await sessions.save(info('recruiter'), state);
  const first = Buffer.from(await blobs.get('sessions/recruiter.session'));
  await sessions.save(info('recruiter'), state);
  const second = Buffer.from(await blobs.get('sessions/recruiter.session'));
  assert.notDeepEqual(first, second);
  assert.notDeepEqual(first.subarray(1, 13), second.subarray(1, 13));
  assert.deepEqual(await sessions.load('recruiter'), { info: info('recruiter'), state });
});
