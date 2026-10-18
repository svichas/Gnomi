import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Page } from 'playwright-core';
import type { BrowserPool, LoginRecording, StorageState } from '../seams.ts';
import { launchBrowserPool } from './pool.ts';

const CANARY = 'canary-password-7f3a';
const hits: string[] = [];
let pool: BrowserPool;
let third: http.Server;
let app: http.Server;
let appOrigin: string;

before(async () => {
  third = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'image/gif');
    res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
  });
  await new Promise<void>((resolve) => third.listen(0, '127.0.0.1', resolve));
  const thirdOrigin = `http://127.0.0.1:${(third.address() as AddressInfo).port}`;

  // A login form that posts to `action`, and a page that needs the cookie it sets.
  const loginPage = (action: string) => `<!doctype html><title>Sign in</title><h1>Sign in</h1><img src="${thirdOrigin}/logo.gif" alt="">
    <form method="post" action="${action}"><input name="user" aria-label="User"><input name="pass" type="password" aria-label="Password"><button>Sign in</button></form>`;
  app = http.createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    const signedIn = (req.headers.cookie ?? '').split('; ').includes('session=valid');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.method === 'POST') {
      req.resume(); // the credentials are never looked at
      res.setHeader('set-cookie', `session=valid; Path=/; HttpOnly${path === '/login' ? '; Max-Age=3600' : ''}`);
      res.statusCode = 302;
      res.setHeader('location', '/app');
      res.end();
    } else if (path === '/login' || path === '/login-session') {
      res.end(loginPage(path));
    } else if (path === '/app') {
      if (signedIn) res.end('<!doctype html><title>Home</title><h1>Welcome back</h1>');
      else (res.statusCode = 302), res.setHeader('location', '/login'), res.end();
    } else if (path === '/app-401') {
      if (signedIn) res.end('<!doctype html><title>Home</title><h1>Welcome back</h1>');
      else (res.statusCode = 401), res.end('<!doctype html><title>Unauthorized</title><p>Please sign in again</p>');
    } else {
      res.end('<!doctype html><title>Page</title>');
    }
  });
  await new Promise<void>((resolve) => app.listen(0, resolve));
  appOrigin = `http://localhost:${(app.address() as AddressInfo).port}`;
  pool = await launchBrowserPool();
});

beforeEach(() => {
  hits.length = 0;
});

after(async () => {
  await pool.close();
  for (const server of [third, app]) {
    server.closeAllConnections();
    server.close();
  }
});

/** An origin nothing listens on: a port that was just free. */
async function deadOrigin(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

async function record(t: TestContext, path: string): Promise<{ recording: LoginRecording; page: Page }> {
  const recording = await pool.record(appOrigin + path, { headless: true });
  t.after(() => recording.cancel());
  return { recording, page: recording.page as Page };
}

/** Logs in the way a person would: typing into the form and pressing the button. */
async function logIn(page: Page): Promise<void> {
  await page.fill('input[name=user]', 'alice@example.com');
  await page.fill('input[type=password]', CANARY);
  await page.click('button');
  await page.waitForURL(`${appOrigin}/app`);
}

test('record: finish() returns the cookies, the page after login, the hosts seen and the earliest expiry', async (t) => {
  const { recording, page } = await record(t, '/login');
  await logIn(page);
  const done = await recording.finish();
  const cookies = done.storageState.cookies as { name: string; value: string; domain: string }[];
  assert.deepEqual(cookies.map(({ name, value, domain }) => [name, value, domain]), [['session', 'valid', 'localhost']]);
  assert.equal(done.start_url, `${appOrigin}/app`);
  assert.deepEqual(done.hosts, ['127.0.0.1', 'localhost']); // the third-party image the login page loaded, sorted
  assert.ok(Math.abs(done.expires_at! - (Date.now() + 3_600_000)) < 10_000, `${done.expires_at}`);
  assert.ok(!JSON.stringify(done).includes(CANARY)); // what the person typed is nowhere in the result
  assert.equal(page.isClosed(), true); // finish() closed the browser
});

test('record: expires_at is null when every cookie is a session cookie', async (t) => {
  const { recording, page } = await record(t, '/login-session');
  await logIn(page);
  assert.equal((await recording.finish()).expires_at, null);
});

test('record: finish() says so when the window was closed first, and the browser went with it', async (t) => {
  const { recording, page } = await record(t, '/login');
  const browser = page.context().browser()!;
  await page.close();
  for (let i = 0; browser.isConnected() && i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(browser.isConnected(), false);
  await assert.rejects(recording.finish(), new Error('The recorder window was closed before the login was saved'));
});

test('record: cancel() closes the browser and nothing can be saved afterwards', async (t) => {
  const { recording, page } = await record(t, '/login');
  await recording.cancel();
  assert.equal(page.isClosed(), true);
  await assert.rejects(recording.finish(), /closed before the login was saved/);
});

test('record: a page that cannot load rejects instead of leaving a window behind', async () => {
  await assert.rejects(pool.record(`${await deadOrigin()}/`, { headless: true }), /ERR_CONNECTION_REFUSED/);
});

const session = (value: string): StorageState => ({
  cookies: [{ name: 'session', value, domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
  origins: [],
});
const check = (startPath: string, storageState: StorageState, allowedHosts = ['localhost']) =>
  pool.checkSession({ storageState, startUrl: appOrigin + startPath, allowedHosts, blockedDomains: [] });

test('checkSession: ok with a valid session', async () => {
  assert.deepEqual(await check('/app', session('valid')), { ok: true, url: `${appOrigin}/app`, reason: null });
});

test('checkSession: not ok when the server sends the session to a login page', async () => {
  assert.deepEqual(await check('/app', session('expired')), { ok: false, url: `${appOrigin}/login`, reason: 'landed on a login page' });
});

test('checkSession: not ok when the start page answers 401', async () => {
  assert.deepEqual(await check('/app-401', session('expired')), { ok: false, url: `${appOrigin}/app-401`, reason: 'the start page answered 401' });
});

test('checkSession: holds the same containment, quietly', async () => {
  // The login page loads a third-party image; the check refuses it without a report and without failing.
  assert.equal((await check('/login', session('expired'))).reason, 'landed on a login page');
  assert.deepEqual(hits, []);
});

test('checkSession: a failure is a result, never an exception', async () => {
  const dead = `${await deadOrigin()}/`;
  const unreachable = await pool.checkSession({ storageState: session('valid'), startUrl: dead, allowedHosts: ['127.0.0.1'], blockedDomains: [] });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.url, dead);
  assert.match(unreachable.reason!, /ERR_CONNECTION_REFUSED/);

  const refused = await check('/app', session('valid'), []); // the start page's own host is not allowed
  assert.deepEqual([refused.ok, /ERR_BLOCKED_BY_CLIENT/.test(refused.reason!)], [false, true]);

  const malformed = await check('/app', { cookies: 'nope' });
  assert.equal(malformed.ok, false);
  assert.ok(malformed.reason && !malformed.reason.includes('nope'));
});
