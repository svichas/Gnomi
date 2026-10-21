import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import type { BrowserPool, PageOptions } from '../seams.ts';
import { fetchRobots, parseRobots, rateLimiter, robotsAllows } from './observe.ts';
import { launchBrowserPool } from './pool.ts';
import { listen } from './server.fixture.ts';

type Blocked = Parameters<PageOptions['onBlockedRequest']>[0];

test('rateLimiter spaces calls two seconds apart in call order and lets a late call through at once', async () => {
  let now = 0;
  const waits: number[] = [];
  const pace = rateLimiter(2_000, () => now, async (ms) => void waits.push(ms));
  await pace();
  await pace();
  await pace();
  assert.deepEqual(waits, [2_000, 4_000], 'three calls at once: the second waits one interval, the third two');
  now = 10_000;
  await pace();
  now = 10_500;
  await pace();
  assert.deepEqual(waits, [2_000, 4_000, 1_500], 'after a quiet spell the next call goes at once and the one after waits out the rest');
});

test('parseRobots takes the gnomi groups, else the * groups, and robotsAllows lets the longest match decide', () => {
  const text = [
    'Disallow: /before-any-group',
    '# a comment',
    'User-agent: *',
    'Disallow: /private # trailing comment',
    'Allow: /private/ok',
    'Disallow: /*.pdf$',
    'Disallow: /search?q=',
    'Sitemap: https://example.com/sitemap.xml',
    '',
    'User-agent: OtherBot',
    'Disallow: /',
  ].join('\r\n');
  const rules = parseRobots(text);
  const allows = (path: string) => robotsAllows(rules, path);
  assert.equal(allows('/'), true);
  assert.equal(allows('/before-any-group'), true, 'a rule before any user-agent line belongs to no group');
  assert.equal(allows('/private'), false);
  assert.equal(allows('/privateer'), false, 'a pattern matches as a prefix');
  assert.equal(allows('/private/ok/page'), true, 'the longer allow wins');
  assert.equal(allows('/docs/guide.pdf'), false);
  assert.equal(allows('/docs/guide.pdf?v=2'), true, '$ anchors the end');
  assert.equal(allows('/search?q=cats'), false, 'the query is part of the path');
  assert.equal(allows('/search'), true);

  const mine = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: Gnomi/1.0\nUser-agent: SomeBot\nDisallow: /admin\nDisallow:\n\nUser-agent: gnomi\nAllow: /admin/help\n');
  assert.equal(robotsAllows(mine, '/pricing'), true, 'a group naming gnomi replaces the * group');
  assert.equal(robotsAllows(mine, '/admin'), false);
  assert.equal(robotsAllows(mine, '/admin/help'), true, 'every gnomi group counts');
  assert.equal(robotsAllows([{ allow: false, pattern: '/page' }, { allow: true, pattern: '/page' }], '/page'), true, 'allow wins a tie');
  assert.equal(robotsAllows([{ allow: false, pattern: '/a*' }, { allow: true, pattern: '/a/b' }], '/a/b'), true, 'longer pattern, not earlier rule');
  assert.deepEqual(parseRobots(''), []);
  assert.deepEqual(parseRobots('User-agent: OtherBot\nDisallow: /'), [], 'no group for gnomi or * means no rules');
});

test('fetchRobots: 2xx rules, a 4xx allows everything, a 5xx or no answer keeps out of the host, other hosts are never checked', async (t) => {
  let answer = { status: 200, body: 'User-agent: *\nDisallow: /private' };
  const server = http.createServer((req, res) => {
    if (req.url !== '/robots.txt') return void res.writeHead(404).end();
    res.writeHead(answer.status, { 'content-type': 'text/plain' }).end(answer.body);
  });
  const origin = await listen(server);
  t.after(() => server.close());
  const at = (path: string, base = origin) => new URL(path, base);

  const parsed = await fetchRobots(`${origin}/start`);
  assert.equal(parsed(at('/private/x')), false);
  assert.equal(parsed(at('/start')), true);
  assert.equal(parsed(at('/private', 'http://cdn.example.test')), true, 'only the start host has rules');

  answer = { status: 404, body: '' };
  assert.equal((await fetchRobots(origin))(at('/private')), true);
  answer = { status: 503, body: '' };
  const down = await fetchRobots(origin);
  assert.equal(down(at('/')), false);
  assert.equal(down(at('/', 'http://cdn.example.test')), true);
  server.close();
  assert.equal((await fetchRobots(origin))(at('/')), false, 'no answer at all keeps out too');
});

// —— In the browser ——

const hits: { method: string; path: string; at: number }[] = [];
let pool: BrowserPool;
let site: http.Server;
let origin: string;

before(async () => {
  site = http.createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    hits.push({ method: req.method!, path, at: Date.now() });
    if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /private\nAllow: /private/ok\n');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (path !== '/') return void res.end(`<!doctype html><title>${path}</title><h1>Page ${path}</h1>`);
    res.end(`<!doctype html><title>Home</title><h1>Home</h1><p id="ws">socket: none</p>
      <form method="post" action="/save"><label>Note <input name="note"></label><button>Save</button></form>
      <form onsubmit="return false"><button type="button" onclick="fetch('/api', { method: 'POST', body: 'x' }).catch(() => {})">Send by script</button></form>
      <button type="button" onclick="fetch('/beacon', { method: 'POST', body: 'x' }).catch(() => {}); this.textContent = 'Opened'">Open menu</button>
      <a href="/private">Private</a> <a href="/private/ok">Allowed</a>
      <script>const ws = new WebSocket('ws://' + location.host + '/socket'); ws.onerror = () => { document.getElementById('ws').textContent = 'socket: error'; };</script>`);
  });
  site.on('upgrade', (req, socket) => {
    hits.push({ method: 'UPGRADE', path: req.url!, at: Date.now() });
    socket.destroy();
  });
  origin = await listen(site, null);
  pool = await launchBrowserPool();
});

beforeEach(() => {
  hits.length = 0;
});

after(async () => {
  await pool?.close();
  site?.closeAllConnections();
  site?.close();
});

const refOf = (text: string, role: string, name: string) => new RegExp(`- ${role} "${name}".*?\\[ref=([^\\]\\s]+)\\]`).exec(text)![1];

test('observe-only: a form post and a script write fail as submit_blocked before the network, a robots.txt path as robots_disallowed', async (t) => {
  const blocked: Blocked[] = [];
  const page = await pool.newPage({
    device: 'desktop', allowedHosts: ['localhost'], blockedDomains: [], storageState: null,
    observe: { robots: await fetchRobots(`${origin}/`) },
    onBlockedRequest: (request) => blocked.push(request),
  });
  t.after(() => page.close());
  await page.goto(`${origin}/`);
  let snap = await page.snapshot();

  await page.act({ type: 'type', ref: refOf(snap.text, 'textbox', 'Note'), text: 'hello' });
  const save = await page.act({ type: 'click', ref: refOf(snap.text, 'button', 'Save'), text: null });
  assert.equal(save.error, 'submit_blocked');
  assert.equal(save.ok, false);
  assert.equal(save.url_after, `${origin}/`, 'back on the page that holds the form, not on a browser error page');

  snap = await page.snapshot();
  assert.equal((await page.act({ type: 'click', ref: refOf(snap.text, 'button', 'Send by script'), text: null })).error, 'submit_blocked');
  assert.equal((await page.act({ type: 'click', ref: refOf(snap.text, 'button', 'Open menu'), text: null })).error, null, 'a background write outside a form is the page\'s, not the click\'s');
  const privately = await page.act({ type: 'click', ref: refOf(snap.text, 'link', 'Private'), text: null });
  assert.equal(privately.error, 'robots_disallowed');
  assert.equal(privately.url_after, `${origin}/`);
  snap = await page.snapshot();
  const allowed = await page.act({ type: 'click', ref: refOf(snap.text, 'link', 'Allowed'), text: null });
  assert.equal(allowed.error, null);
  assert.equal(allowed.url_after, `${origin}/private/ok`);

  const summary = blocked.map((b) => `${b.method} ${new URL(b.url).pathname} ${b.reason} navigation=${b.navigation}`).sort();
  assert.deepEqual(summary, ['GET /private robots navigation=true', 'GET /socket observe_only navigation=false', 'POST /api observe_only navigation=false', 'POST /beacon observe_only navigation=false', 'POST /save observe_only navigation=true']);
  assert.deepEqual(hits.filter((h) => h.method !== 'GET').map((h) => `${h.method} ${h.path}`), [], 'no write and no WebSocket reached the site');
  assert.ok(!hits.some((h) => h.path === '/private'), 'the disallowed page was never fetched');

  await assert.rejects(page.goto(`${origin}/private`), /robots\.txt of localhost:\d+ does not let automated visitors open \/private/);
});

test('observe-only: page loads in one context are at least two seconds apart', async (t) => {
  const page = await pool.newPage({
    device: 'desktop', allowedHosts: ['localhost'], blockedDomains: [], storageState: null, observe: { robots: () => true }, onBlockedRequest: () => {},
  });
  t.after(() => page.close());
  await page.goto(`${origin}/a`);
  await page.goto(`${origin}/b`);
  await page.goto(`${origin}/c`);
  const loads = hits.filter((h) => h.method === 'GET' && ['/a', '/b', '/c'].includes(h.path)).map((h) => h.at);
  assert.equal(loads.length, 3);
  for (let i = 1; i < loads.length; i++) assert.ok(loads[i] - loads[i - 1] >= 1_950, `load ${i + 1} came ${loads[i] - loads[i - 1]} ms after the one before`);
});
