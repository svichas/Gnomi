import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { BrowserContext } from 'playwright-core';
import type { BrowserPool, PageDriver, PageOptions, StorageState } from '../seams.ts';
import { hostRule, startContainment } from './contain.ts';
import { launchBrowserPool } from './pool.ts';
import { deadOrigin, listen, stop } from './server.fixture.ts';

type Blocked = Parameters<PageOptions['onBlockedRequest']>[0];

// The page is served from `localhost`; a second server on 127.0.0.1 stands in for a third party (another hostname).
const hits: string[] = [];
const reached = () => [...hits]; // what the third party saw (a copy, so assertions do not narrow `hits`)
let pool: BrowserPool;
let third: http.Server;
let app: http.Server;
let thirdOrigin: string;
let appOrigin: string;

before(async () => {
  third = http.createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    hits.push(`${req.method} ${path}`);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8');
    res.end(path.endsWith('.js') ? 'window.thirdLoaded = true' : '<title>Third page</title><h1>Third party</h1>');
  });
  third.on('upgrade', (req, socket) => {
    hits.push(`UPGRADE ${req.url}`);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  third.on('connection', () => hits.push('CONNECTION')); // any socket at all, even one that never sends a request
  thirdOrigin = await listen(third);

  app = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const other = url.searchParams.get('third') ?? '';
    const redirect = (location: string) => {
      res.statusCode = 302;
      res.setHeader('location', location);
      res.end();
    };
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/cookie') {
      res.end(`<!doctype html><title>Cookie</title><p>cookie: ${req.headers.cookie ?? 'none'}</p>`);
    } else if (url.pathname === '/redirect') {
      redirect(`${other}/landed`);
    } else if (url.pathname === '/https-redirect') {
      redirect(`https://${new URL(other).host}/secure`); // no certificate needed: the proxy refuses the CONNECT before any TLS
    } else if (url.pathname === '/api-redirect') {
      redirect(`${other}/api-landed`);
    } else if (url.pathname === '/img-redirect') {
      redirect(`${other}/img-landed`);
    } else if (url.pathname === '/redirects') {
      const q = encodeURIComponent(other);
      res.end(`<!doctype html><title>Redirects</title><h1>Redirects</h1>
        <img src="/img-redirect?third=${q}" alt="pixel">
        <script>fetch('/api-redirect?third=${q}', { mode: 'no-cors' }).catch(() => {});</script>`);
    } else if (url.pathname === '/links') {
      const q = encodeURIComponent(other);
      res.end(`<!doctype html><title>Links</title><h1>Links</h1>
        <a href="${other}/page">Leave</a>
        <a href="/redirect?third=${q}">Via redirect</a>
        <a href="/https-redirect?third=${q}">Via secure redirect</a>
        <a href="${url.searchParams.get('dead') ?? ''}/">Dead host</a>`);
    } else if (url.pathname === '/reads') {
      res.end(`<!doctype html><title>Reads</title><h1>Reads</h1>
        <img src="${other}/pixel.gif" alt="pixel">
        <script src="${other}/lib.js"></script>
        <a href="${other}/page">Leave</a>
        <script>
          fetch('${other}/api', { mode: 'no-cors' }).catch(() => {});
          fetch('${other}/write', { method: 'POST', mode: 'no-cors', body: 'x' }).catch(() => {});
        </script>`);
    } else if (url.pathname === '/ws') {
      res.end(`<!doctype html><title>WS</title><p id="events">events: </p><script>
        const events = [];
        const ws = new WebSocket('${other.replace('http', 'ws')}/socket');
        for (const type of ['open', 'error', 'close']) ws.addEventListener(type, () => { events.push(type); document.getElementById('events').textContent = 'events: ' + events.join(','); });
      </script>`);
    } else {
      res.end(`<!doctype html><title>App</title><body><h1>App</h1>
        <img src="${other}/pixel.gif?uid=secret-123" alt="pixel">
        <script src="${other}/lib.js"></script>
        <a href="${other}/page">Leave</a>
        <script>
          fetch('${other}/api?x=1', { mode: 'no-cors' }).catch(() => {});
          fetch('${other}/api?x=2', { mode: 'no-cors' }).catch(() => {});
          fetch('${other}/other', { mode: 'no-cors' }).catch(() => {});
        </script></body>`);
    }
  });
  appOrigin = await listen(app, null);
  pool = await launchBrowserPool();
});

beforeEach(() => {
  hits.length = 0;
});

after(async () => {
  await pool.close();
  stop(third, app);
});

async function open(t: TestContext, opts: { allowedHosts: string[]; blockedDomains?: string[]; storageState?: StorageState }, blocked: Blocked[] = []): Promise<PageDriver> {
  const page = await pool.newPage({ device: 'desktop', blockedDomains: [], storageState: null, ...opts, onBlockedRequest: (request) => blocked.push(request) });
  t.after(() => page.close());
  return page;
}

const withThird = (path: string, origin = thirdOrigin, extra = '') => `${appOrigin}${path}?third=${encodeURIComponent(origin)}${extra}`;
const summary = (blocked: Blocked[]) => blocked.map((b) => `${b.method} ${b.url.replace(/^[a-z]+:\/\/[^/]+/, '')} navigation=${b.navigation}`).sort();
const refOf = (text: string, line: RegExp) => line.exec(text)![1];

/** What a client sends to a proxy, byte for byte, and everything it gets back until the proxy hangs up. */
function exchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (received += chunk));
    socket.on('close', () => resolve(received));
    socket.on('error', reject);
    socket.write(request);
  });
}

async function eventually(check: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await check();
    } catch (e) {
      if (attempt >= 20) throw e;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

test('hostRule: exact lower-case match, blocked domains and their subdomains win, no partial suffix matches', () => {
  const allows = hostRule(['App.Example.com', 'cdn.tracker.example.com', 'evilexample.com', 'example.com'], ['Example.com']);
  assert.equal(allows('app.example.com'), false); // a subdomain of a blocked domain, though listed
  assert.equal(allows('example.com'), false); // the blocked domain itself, though listed
  assert.equal(allows('evilexample.com'), true); // ends with "example.com" but is not a subdomain of it
  const open = hostRule(['App.Example.com', 'localhost'], []);
  assert.deepEqual([open('app.example.com'), open('APP.EXAMPLE.COM'), open('www.app.example.com'), open('example.com'), open('localhost'), open('')], [true, true, false, false, true, false]);
});

test('an unlisted third party receives nothing, and each distinct path is reported once', async (t) => {
  const blocked: Blocked[] = [];
  const page = await open(t, { allowedHosts: ['localhost'] }, blocked);
  await page.goto(withThird('/'));
  assert.deepEqual(reached(), []);
  // /api is asked for twice with different queries: one report, and none of the URLs keeps its query string.
  assert.deepEqual(summary(blocked), ['GET /api navigation=false', 'GET /lib.js navigation=false', 'GET /other navigation=false', 'GET /pixel.gif navigation=false']);
  assert.ok(blocked.every((b) => b.host === '127.0.0.1' && b.url.startsWith(thirdOrigin) && !b.url.includes('?')));
});

test('a third party listed in allowedHosts is reachable', async (t) => {
  const blocked: Blocked[] = [];
  const page = await open(t, { allowedHosts: ['localhost', '127.0.0.1'] }, blocked);
  await page.goto(withThird('/'));
  assert.deepEqual(blocked, []);
  assert.deepEqual(reached().filter((hit) => hit !== 'CONNECTION').sort(), ['GET /api', 'GET /api', 'GET /lib.js', 'GET /other', 'GET /pixel.gif']);
});

test('blockedDomains beat allowedHosts, for the host itself and for its subdomains', async (t) => {
  const blocked: Blocked[] = [];
  const exact = await open(t, { allowedHosts: ['localhost', '127.0.0.1'], blockedDomains: ['127.0.0.1'] }, blocked);
  await exact.goto(withThird('/'));
  assert.deepEqual(reached(), []);
  assert.equal(blocked.length, 4);

  // *.localhost resolves to the loopback, so the same server answers under a subdomain name.
  const cdn = `http://cdn.tracker.localhost:${new URL(thirdOrigin).port}`;
  const listed = ['localhost', 'cdn.tracker.localhost'];
  const control = await open(t, { allowedHosts: listed });
  await control.goto(withThird('/', cdn));
  assert.ok(reached().length > 0, 'the control run must reach the server under the subdomain name');
  hits.length = 0;
  blocked.length = 0;
  const sub = await open(t, { allowedHosts: listed, blockedDomains: ['tracker.localhost'] }, blocked);
  await sub.goto(withThird('/', cdn));
  assert.deepEqual(reached(), []);
  assert.ok(blocked.length === 4 && blocked.every((b) => b.host === 'cdn.tracker.localhost'));
});

test('a click on a link to a blocked host is refused, reported as a navigation, and undone', async (t) => {
  const blocked: Blocked[] = [];
  const page = await open(t, { allowedHosts: ['localhost'] }, blocked);
  await page.goto(withThird('/links'));
  const outcome = await page.act({ type: 'click', ref: refOf((await page.snapshot()).text, /link "Leave" \[ref=(\w+)\]/), text: null });
  assert.deepEqual(summary(blocked), ['GET /page navigation=true']);
  assert.deepEqual(reached(), []);
  // The persona hears that the link leads outside the product, and is still on the page it clicked from.
  assert.deepEqual([outcome.ok, outcome.error, outcome.url_after], [false, 'host_not_allowed', outcome.url_before]);
  assert.equal(outcome.target?.name, 'Leave');
  assert.equal((await page.snapshot()).title, 'Links');
});

test('a WebSocket to a blocked host fails without reaching the server, and a listed one connects', async (t) => {
  const blocked: Blocked[] = [];
  const closed = await open(t, { allowedHosts: ['localhost'] }, blocked);
  await closed.goto(withThird('/ws'));
  // Exactly "close": the page never saw the socket open.
  await eventually(async () => assert.match((await closed.snapshot()).text, /"events: close"/));
  assert.deepEqual(reached(), []);
  assert.deepEqual(summary(blocked), ['GET /socket navigation=false']);
  assert.ok(blocked[0].url.startsWith('ws://127.0.0.1:'));

  const connected = await open(t, { allowedHosts: ['localhost', '127.0.0.1'] });
  await connected.goto(withThird('/ws'));
  await eventually(async () => assert.match((await connected.snapshot()).text, /events: open/));
  assert.ok(reached().includes('UPGRADE /socket'));
});

test('navigate passes only hosts that pass the same rule', async (t) => {
  const page = await open(t, { allowedHosts: ['localhost'] });
  await page.goto(`${appOrigin}/`);
  const refused = await page.act({ type: 'navigate', ref: null, text: `${thirdOrigin}/page` });
  assert.deepEqual([refused.ok, refused.error, refused.url_after], [false, 'host_not_allowed', `${appOrigin}/`]);
  assert.deepEqual(reached(), []);

  const both = await open(t, { allowedHosts: ['localhost', '127.0.0.1'] });
  await both.goto(`${appOrigin}/`);
  const allowed = await both.act({ type: 'navigate', ref: null, text: `${thirdOrigin}/page` });
  assert.deepEqual([allowed.ok, allowed.url_after], [true, `${thirdOrigin}/page`]);

  const blockedDomain = await open(t, { allowedHosts: ['localhost', '127.0.0.1'], blockedDomains: ['127.0.0.1'] });
  await blockedDomain.goto(`${appOrigin}/`);
  assert.equal((await blockedDomain.act({ type: 'navigate', ref: null, text: `${thirdOrigin}/page` })).error, 'host_not_allowed');
});

test('storageState cookies reach the server', async (t) => {
  const storageState: StorageState = {
    cookies: [{ name: 'session', value: 'abc123', domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
    origins: [],
  };
  const withSession = await open(t, { allowedHosts: ['localhost'], storageState });
  await withSession.goto(`${appOrigin}/cookie`);
  assert.match((await withSession.snapshot()).text, /cookie: session=abc123/);
  const loggedOut = await open(t, { allowedHosts: ['localhost'] });
  await loggedOut.goto(`${appOrigin}/cookie`);
  assert.match((await loggedOut.snapshot()).text, /cookie: none/);
});

// Playwright's Chromium backend never routes redirect hops, so these reach the proxy gate (loopback included: 127.0.0.1 is the third party).
test('a listed host that redirects a page load to an unlisted one cannot reach it', async (t) => {
  const blocked: Blocked[] = [];
  const page = await open(t, { allowedHosts: ['localhost'] }, blocked);
  await page.goto(withThird('/redirect'));
  assert.deepEqual(reached(), []);
  assert.deepEqual(summary(blocked), ['GET /landed navigation=true']);
});

test('a listed host that redirects images and fetches to an unlisted one cannot reach it', async (t) => {
  const blocked: Blocked[] = [];
  const page = await open(t, { allowedHosts: ['localhost'] }, blocked);
  await page.goto(withThird('/redirects'));
  await eventually(async () => assert.equal(blocked.length, 2));
  assert.deepEqual(reached(), []);
  assert.deepEqual(summary(blocked), ['GET /api-landed navigation=false', 'GET /img-landed navigation=false']);
});

test('a redirect to an https:// host is refused at the tunnel, before any TLS', async (t) => {
  const blocked: Blocked[] = [];
  const page = await open(t, { allowedHosts: ['localhost'] }, blocked);
  await assert.rejects(page.goto(withThird('/https-redirect')), /net::ERR_/);
  assert.deepEqual(reached(), []); // not even a socket reached the server
  assert.deepEqual(summary(blocked), ['CONNECT / navigation=false']);
  assert.equal(blocked[0].host, '127.0.0.1');
});

test('a click that lands on an unlisted host through a redirect is undone, whether it is http or https', async (t) => {
  const blocked: Blocked[] = [];
  const page = await open(t, { allowedHosts: ['localhost'] }, blocked);
  await page.goto(withThird('/links'));
  for (const name of ['Via redirect', 'Via secure redirect']) {
    const { text } = await page.snapshot();
    const outcome = await page.act({ type: 'click', ref: refOf(text, new RegExp(`link "${name}" \\[ref=(\\w+)\\]`)), text: null });
    assert.deepEqual([outcome.ok, outcome.error, outcome.url_after], [false, 'host_not_allowed', outcome.url_before], name);
    assert.equal((await page.snapshot()).title, 'Links', name);
    // The refreshed snapshot still works for the next step.
    const again = await page.act({ type: 'click', ref: refOf((await page.snapshot()).text, /link "Leave" \[ref=(\w+)\]/), text: null });
    assert.equal(again.error, 'host_not_allowed');
  }
  assert.deepEqual(reached(), []);
});

test('navigate to a listed address that redirects off the list is undone too', async (t) => {
  const page = await open(t, { allowedHosts: ['localhost'] });
  await page.goto(`${appOrigin}/`);
  const outcome = await page.act({ type: 'navigate', ref: null, text: withThird('/redirect') });
  assert.deepEqual([outcome.ok, outcome.error, outcome.url_after], [false, 'host_not_allowed', `${appOrigin}/`]);
  assert.deepEqual(reached(), []);
});

test('a listed host that is simply down is a broken page for the persona to report, not a containment refusal', async (t) => {
  const page = await open(t, { allowedHosts: ['localhost', '127.0.0.1'] });
  await page.goto(withThird('/links', thirdOrigin, `&dead=${encodeURIComponent(await deadOrigin())}`));
  const outcome = await page.act({ type: 'click', ref: refOf((await page.snapshot()).text, /link "Dead host" \[ref=(\w+)\]/), text: null });
  assert.deepEqual([outcome.ok, outcome.error], [true, null]);
  assert.ok(outcome.url_after.startsWith('chrome-error://'), outcome.url_after);
});

test('the proxy refuses and reports whatever reaches it, and forwards nothing', async (t) => {
  const blocked: Blocked[] = [];
  const containment = await startContainment(['localhost'], [], (request) => blocked.push(request));
  t.after(() => containment.close());
  const port = Number(new URL(containment.proxy.server).port);
  const target = new URL(thirdOrigin).host;

  // What the browser sends for https:// and wss:// targets, then plain http in absolute form (with a query that must not be kept).
  assert.match(await exchange(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`), /^HTTP\/1\.1 403 /);
  assert.match(await exchange(port, `GET ${thirdOrigin}/x?token=1 HTTP/1.1\r\nHost: ${target}\r\nSec-Fetch-Mode: navigate\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 403 /);
  assert.match(await exchange(port, `POST ${thirdOrigin}/y HTTP/1.1\r\nHost: ${target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 403 /);
  // The same again adds nothing; a listed host is refused as well, since those never come here (they bypass the proxy).
  await exchange(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  assert.match(await exchange(port, `CONNECT ${new URL(appOrigin).host} HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 403 /);
  // Not a proxy request (origin form): turned away without a report.
  assert.match(await exchange(port, 'GET /x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400 /);

  assert.deepEqual(summary(blocked), ['CONNECT / navigation=false', 'CONNECT / navigation=false', 'GET /x navigation=true', 'POST /y navigation=false']);
  assert.ok(blocked.every((b) => !b.url.includes('?')));
  assert.deepEqual(reached(), []);
});

test('observe-only: the proxy tunnels to a public host but never to the loopback, a blocked domain or without observe', async (t) => {
  const blocked: Blocked[] = [];
  const observe = { robots: () => true };
  const target = new URL(thirdOrigin).host;
  const tunnel = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\nGET /through HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`;

  // The real lookup: 127.0.0.1 is the user's own machine, so nothing goes through.
  const real = await startContainment(['localhost'], [], (request) => blocked.push(request), observe);
  t.after(() => real.close());
  assert.match(await exchange(Number(new URL(real.proxy.server).port), tunnel), /^HTTP\/1\.1 403 /);

  // A host that resolves to public addresses (stubbed onto the fixture) gets a tunnel, the bytes sent with the CONNECT included.
  const stubbed = await startContainment(['localhost'], ['blocked.example'], (request) => blocked.push(request), observe, async () => '127.0.0.1');
  t.after(() => stubbed.close());
  const port = Number(new URL(stubbed.proxy.server).port);
  const answer = await exchange(port, tunnel);
  assert.match(answer, /^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 200 OK/);
  assert.match(answer, /Third party/);
  assert.deepEqual(reached().filter((hit) => hit !== 'CONNECTION'), ['GET /through']);
  assert.match(await exchange(port, `CONNECT cdn.blocked.example:443 HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 403 /);

  // Without observe, the same stub changes nothing.
  const full = await startContainment(['localhost'], [], (request) => blocked.push(request), undefined, async () => '127.0.0.1');
  t.after(() => full.close());
  assert.match(await exchange(Number(new URL(full.proxy.server).port), tunnel), /^HTTP\/1\.1 403 /);

  assert.deepEqual(blocked.map((b) => `${b.method} ${b.host}`), ['CONNECT 127.0.0.1', 'CONNECT cdn.blocked.example', 'CONNECT 127.0.0.1']);
  assert.deepEqual(reached().filter((hit) => hit !== 'CONNECTION'), ['GET /through']);
});

test('observe-only: a page\'s reads may leave the listed hosts, its writes and page loads may not, and the loopback stays shut', async (t) => {
  const blocked: Blocked[] = [];
  const page = await pool.newPage({
    device: 'desktop', allowedHosts: ['localhost'], blockedDomains: [], storageState: null, observe: { robots: () => true },
    onBlockedRequest: (request) => blocked.push(request),
  });
  t.after(() => page.close());
  await page.goto(withThird('/reads'));
  const leave = await page.act({ type: 'click', ref: refOf((await page.snapshot()).text, /link "Leave" \[ref=(\w+)\]/), text: null });
  assert.equal(leave.error, 'host_not_allowed');
  await eventually(async () => assert.equal(blocked.length, 5));
  // The reads pass route() and are refused at the proxy (a plain-http loopback host); the write and the page load never leave.
  assert.deepEqual(blocked.map((b) => `${b.method} ${new URL(b.url).pathname} ${b.reason} navigation=${b.navigation}`).sort(), [
    'GET /api host navigation=false', 'GET /lib.js host navigation=false', 'GET /page host navigation=true', 'GET /pixel.gif host navigation=false',
    'POST /write host navigation=false',
  ]);
  assert.deepEqual(reached(), []);
});

test('the bypass list sends only listed hosts straight out, loopback rule first', async (t) => {
  const containment = await startContainment(['App.Example.com', 'localhost', '*.evil.com', 'example.com', 'x y', '[::1]', '127.0.0.1', 'localhost'], ['example.com'], () => {});
  t.after(() => containment.close());
  // Wildcards, odd names and blocked domains (subdomains included) never get in; later rules win, so <-loopback> leads.
  assert.equal(containment.proxy.bypass, '<-loopback>,localhost,[::1],127.0.0.1');
});

test('the proxy shuts down with its context', async () => {
  const containment = await startContainment(['localhost'], [], () => {});
  const emitter = new EventEmitter();
  await containment.install(Object.assign(emitter, { route: async () => {}, routeWebSocket: async () => {} }) as unknown as BrowserContext);
  const port = Number(new URL(containment.proxy.server).port);
  assert.match(await exchange(port, 'GET /x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400 /); // up
  emitter.emit('close');
  await assert.rejects(exchange(port, 'GET /x HTTP/1.1\r\nHost: x\r\n\r\n'), /ECONNREFUSED/);
});
