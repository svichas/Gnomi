import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Page } from 'playwright-core';
import type { BrowserPool } from '../seams.ts';
import type { PageFlags } from '../types.ts';
import { inspect } from './inspect.ts';
import { launchBrowserPool } from './pool.ts';
import { listen, stop } from './server.fixture.ts';

// Built at runtime so the source never holds anything that looks like a live key.
const key = (prefix: string) => `${prefix}_${'live'}_${'x'.repeat(24)}`;
const testKey = `${'pk'}_${'test'}_${'x'.repeat(24)}`;
const pad = 'x'.repeat(2_100_000); // past the 2 MB scan cap

const pages: Record<string, string> = {
  '/': '<title>Dashboard</title><h1>Dashboard</h1><p>All quiet</p>',
  '/password': '<title>Settings</title><form><input type="password" aria-label="Password"></form>',
  '/hidden-password': '<title>Settings</title><form><input type="password" style="display:none"></form>',
  '/framed-login': '<title>Home</title><iframe srcdoc="<input type=password>"></iframe>',
  '/new-password': '<title>Settings</title><form><input type="password" autocomplete="new-password" aria-label="New password"></form>',
  '/change-password': '<title>Settings</title><form><input type="password" aria-label="Current"><input type="password" aria-label="New"></form>',
  '/recaptcha': '<title>Contact</title><div class="g-recaptcha" data-sitekey="x"></div>',
  '/recaptcha-frame': '<title>Contact</title><iframe src="/frame"></iframe><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>',
  '/hcaptcha': '<title>Contact</title><div class="h-captcha"></div>',
  '/hcaptcha-frame': '<title>Contact</title><iframe src="https://newassets.hcaptcha.com/captcha/v1/x"></iframe>',
  '/turnstile': '<title>Contact</title><div class="cf-turnstile"></div>',
  '/turnstile-frame': '<title>Contact</title><iframe src="https://challenges.cloudflare.com/cdn-cgi/x"></iframe>',
  '/cloudflare-wait': '<title>Just a moment...</title><p>Checking your browser</p>',
  '/cloudflare-blocked': '<title>Attention Required! | Cloudflare</title><p>Sorry, you have been blocked</p>',
  '/cloudflare-form': '<title>One sec</title><form id="challenge-form"></form>',
  '/two-challenges': '<title>Contact</title><div class="h-captcha"></div><div class="g-recaptcha"></div>',
  '/pk': `<title>Pay</title><script>const stripe = Stripe("${key('pk')}")</script>`,
  '/sk': `<title>Pay</title><script>const secret = "${key('sk')}"</script>`,
  '/rk': `<title>Pay</title><p>${key('rk')}</p>`,
  '/test-key': `<title>Pay</title><script>const stripe = Stripe("${testKey}")</script>`,
  '/two-keys': `<title>Pay</title><script>const a = "${key('sk')}", b = "${key('pk')}"</script>`,
  '/key-early': `<title>Pay</title><script>const a = "${key('pk')}"</script><p>${pad}</p>`,
  '/key-late': `<title>Pay</title><p>${pad}</p><script>const a = "${key('pk')}"</script>`,
};

let pool: BrowserPool;
let server: http.Server;
let origin: string;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(pages[new URL(req.url!, 'http://x').pathname] ?? '<title>Page</title><h1>Page</h1>');
  });
  origin = await listen(server);
  pool = await launchBrowserPool();
});

after(async () => {
  await pool.close();
  stop(server);
});

async function flagsAt(t: TestContext, path: string): Promise<PageFlags> {
  const page = await pool.newPage({ device: 'desktop', allowedHosts: ['127.0.0.1'], blockedDomains: [], storageState: null, onBlockedRequest: () => {} });
  t.after(() => page.close());
  await page.goto(origin + path);
  return page.inspect();
}

const flags = (over: Partial<PageFlags> = {}): PageFlags => ({ login: false, challenge: null, live_key: null, ...over });

test('an ordinary page raises nothing', async (t) => {
  assert.deepEqual(await flagsAt(t, '/'), flags());
  assert.deepEqual(await flagsAt(t, '/settings/profile'), flags());
});

test('login: a login-like path, or a visible password field in any frame', async (t) => {
  for (const path of ['/login', '/account/sign-in', '/users/sign_in', '/signin', '/login.html', '/oauth/authorize', '/oauth2/callback', '/sso/start', '/auth/callback']) {
    assert.deepEqual(await flagsAt(t, path), flags({ login: true }), path);
  }
  for (const path of ['/authors', '/blog/signing-tips', '/catalogin']) assert.deepEqual(await flagsAt(t, path), flags(), `${path} only contains a login word`);
  assert.deepEqual(await flagsAt(t, '/new-password'), flags(), 'setting a new password is not logging in');
  assert.deepEqual(await flagsAt(t, '/change-password'), flags(), 'two password fields side by side change a password');
  assert.deepEqual(await flagsAt(t, '/password'), flags({ login: true }));
  assert.deepEqual(await flagsAt(t, '/framed-login'), flags({ login: true }));
  assert.deepEqual(await flagsAt(t, '/hidden-password'), flags()); // not visible, so nobody is being asked to log in
});

test('challenge: reCAPTCHA, hCaptcha and Turnstile widgets and frames', async (t) => {
  assert.equal((await flagsAt(t, '/recaptcha')).challenge, 'recaptcha');
  assert.equal((await flagsAt(t, '/recaptcha-frame')).challenge, 'recaptcha');
  assert.equal((await flagsAt(t, '/hcaptcha')).challenge, 'hcaptcha');
  assert.equal((await flagsAt(t, '/hcaptcha-frame')).challenge, 'hcaptcha');
  assert.equal((await flagsAt(t, '/turnstile')).challenge, 'turnstile');
  assert.equal((await flagsAt(t, '/turnstile-frame')).challenge, 'turnstile');
});

test('challenge: Cloudflare interstitials by title or form', async (t) => {
  assert.equal((await flagsAt(t, '/cloudflare-wait')).challenge, 'cloudflare');
  assert.equal((await flagsAt(t, '/cloudflare-blocked')).challenge, 'cloudflare');
  assert.equal((await flagsAt(t, '/cloudflare-form')).challenge, 'cloudflare');
});

test('challenge: the first kind in the documented order wins', async (t) => {
  assert.equal((await flagsAt(t, '/two-challenges')).challenge, 'recaptcha');
});

test('live_key: Stripe live prefixes in the page HTML, never the key itself', async (t) => {
  assert.deepEqual(await flagsAt(t, '/pk'), flags({ live_key: 'pk_live_' }));
  assert.deepEqual(await flagsAt(t, '/sk'), flags({ live_key: 'sk_live_' }));
  assert.deepEqual(await flagsAt(t, '/rk'), flags({ live_key: 'rk_live_' }));
  assert.deepEqual(await flagsAt(t, '/test-key'), flags()); // test keys are what staging should have
  assert.equal((await flagsAt(t, '/two-keys')).live_key, 'pk_live_'); // first prefix in the list, wherever it sits in the page
});

test('live_key: only the first ~2 MB of HTML is scanned', async (t) => {
  assert.equal((await flagsAt(t, '/key-early')).live_key, 'pk_live_');
  assert.equal((await flagsAt(t, '/key-late')).live_key, null);
});

test('a redirect that destroys the page mid-check is checked again once the new page has loaded; other errors still throw', async () => {
  const fake = (fail: string) => {
    const calls: string[] = [];
    const page = {
      url: () => 'http://gym.test/login',
      frames: () => [],
      async evaluate() {
        calls.push('evaluate');
        if (calls.length === 1) throw new Error(fail);
        return { challenge: 'recaptcha', live_key: null };
      },
      async waitForLoadState() {
        calls.push('load');
      },
    };
    return { page: page as unknown as Page, calls };
  };
  const redirected = fake('page.evaluate: Execution context was destroyed, most likely because of a navigation');
  assert.deepEqual(await inspect(redirected.page), flags({ login: true, challenge: 'recaptcha' }));
  assert.deepEqual(redirected.calls, ['evaluate', 'load', 'evaluate']);
  await assert.rejects(inspect(fake('page.evaluate: Target page, context or browser has been closed').page), /has been closed/);
});
