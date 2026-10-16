import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FigmaError, figmaClient } from './client.ts';

const TOKEN = 'figd_secret-token-0123456789abcdefghij';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function client(handler: Handler, token: string | null = TOKEN) {
  const seen: { url: URL; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const api = figmaClient({
    token,
    fetch: (async (input: string | URL, init: RequestInit = {}) => {
      seen.push({ url: new URL(String(input)), init });
      return handler(new URL(String(input)), init);
    }) as typeof fetch,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { api, seen, sleeps };
}
const rejects = (promise: Promise<unknown>, kind: string, message: RegExp) =>
  assert.rejects(promise, (err) => err instanceof FigmaError && err.kind === kind && message.test(err.message), `${kind} ${message}`);

test('the token travels in a header to api.figma.com only, redirects are refused, and downloads carry no token', async () => {
  const { api, seen } = client((url) => (url.host === 'api.figma.com' ? json({ ok: true }) : new Response(new Uint8Array([1, 2, 3]))));
  await api.get('/v1/files/ABC', { depth: '2' });
  assert.equal(seen[0].url.toString(), 'https://api.figma.com/v1/files/ABC?depth=2');
  assert.deepEqual(seen[0].init.headers, { 'X-Figma-Token': TOKEN });
  assert.equal(seen[0].init.redirect, 'error');
  assert.deepEqual([...(await api.download('https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/x', 10))], [1, 2, 3]);
  assert.deepEqual(seen[1].init.headers, {});
  assert.doesNotMatch(seen[1].url.toString(), /figd_/);
});

test('without a token nothing is requested', async () => {
  const { api, seen } = client(() => json({}), null);
  await rejects(api.get('/v1/files/ABC', {}), 'no_token', /Add a Figma access token in Settings/);
  await rejects(api.check(), 'no_token', /Add a Figma access token/);
  assert.equal(seen.length, 0);
});

test('403 is told apart: a bad or expired token, a missing scope, or a file the account cannot open', async () => {
  // Figma answers 403 to all three; the profile call (/v1/me) says whether the token itself is accepted.
  const bad = client(() => json({ status: 403, err: 'Invalid token' }, 403));
  await rejects(bad.api.get('/v1/files/ABC', {}), 'bad_token', /wrong, revoked or expired \(tokens last 90 days at most\)/);
  assert.deepEqual(bad.seen.map((call) => call.url.pathname), ['/v1/files/ABC', '/v1/me']);

  const noAccess = client((url) => (url.pathname === '/v1/me' ? json({ id: '1', handle: 'x' }) : json({ status: 403, err: 'Forbidden' }, 403)));
  await rejects(noAccess.api.get('/v1/files/ABC', {}), 'no_access', /cannot open this file.*share it with that account/);

  const onlyMe = client((url) => (url.pathname === '/v1/me' ? json({ status: 403, err: 'Invalid scope(s): file_content:read. This endpoint requires the current_user:read scope' }, 403) : json({ status: 403, err: 'Forbidden' }, 403)));
  await rejects(onlyMe.api.get('/v1/files/ABC', {}), 'no_access', /cannot open this file/); // a file-only token is a valid one

  const noScope = client(() => json({ status: 403, err: 'Invalid scope(s): current_user:read. This endpoint requires the file_content:read scope' }, 403));
  await rejects(noScope.api.get('/v1/files/ABC', {}), 'bad_token', /lacks the file_content:read scope/);
  assert.equal(noScope.seen.length, 1);
});

test('404, 400 and 500 each get their own sentence', async () => {
  await rejects(client(() => json({ status: 404, err: 'Not found' }, 404)).api.get('/v1/files/ABC', {}), 'not_found', /no file at this link/);
  await rejects(client(() => json({ status: 400, err: 'Invalid parameter ids' }, 400)).api.get('/v1/images/ABC', {}), 'failed', /rejected the request: Invalid parameter ids/);
  await rejects(client(() => json({ status: 500, err: 'Render timeout' }, 500)).api.get('/v1/images/ABC', {}), 'failed', /Figma had a problem \(500\)/);
  await rejects(client(() => new Response('<html>', { status: 502 })).api.get('/v1/files/ABC', {}), 'failed', /\(502\)/);
});

test('check: the token is accepted, accepted without the profile scope, or refused', async () => {
  await client(() => json({ id: '1', handle: 'x' })).api.check();
  await client(() => json({ status: 403, err: 'Invalid scope(s): file_content:read. This endpoint requires the current_user:read scope' }, 403)).api.check();
  await rejects(client(() => json({ status: 403, err: 'Invalid token' }, 403)).api.check(), 'bad_token', /does not accept this token/);
  await rejects(client(() => json({ status: 403, err: 'Token expired' }, 403)).api.check(), 'bad_token', /expired/);
  await rejects(client(() => json({}, 503)).api.check(), 'failed', /answered 503/);
});

test('a short Retry-After is waited out and the request repeated; a long one is an error that says how long', async () => {
  let n = 0;
  const waits = client(() => (n++ < 2 ? json({ status: 429, err: 'Rate limit exceeded' }, 429, { 'Retry-After': '3' }) : json({ fine: true })));
  assert.deepEqual(await waits.api.get('/v1/files/ABC', {}), { fine: true });
  assert.deepEqual(waits.sleeps, [3000, 3000], 'it honoured the header both times');

  const never = client(() => json({}, 429, { 'Retry-After': '3' }));
  await rejects(never.api.get('/v1/files/ABC', {}), 'rate_limited', /Try again in about 3 seconds/);
  assert.equal(never.seen.length, 3, 'one try and two repeats, then it gives up');

  const days = client(() => json({}, 429, { 'Retry-After': '172800', 'X-Figma-Rate-Limit-Type': 'low', 'X-Figma-Plan-Tier': 'starter' }));
  await rejects(days.api.get('/v1/files/ABC', {}), 'rate_limited', /about 2 days.*View or Collab seat.*Dev or Full/);
  assert.deepEqual([days.seen.length, days.sleeps], [1, []], 'a long wait is not slept through');

  await rejects(client(() => json({}, 429)).api.get('/v1/files/ABC', {}), 'rate_limited', /in a minute or so/);
  await rejects(client(() => json({}, 429, { 'Retry-After': '300' })).api.get('/v1/files/ABC', {}), 'rate_limited', /about 5 minutes/);
});

test('network failures say where, and never carry the token', async () => {
  const down = client(() => { throw new TypeError(`fetch failed for ${TOKEN}`); });
  await rejects(down.api.get('/v1/files/ABC', {}), 'network', /Could not reach api\.figma\.com.*Check the internet connection/);
  await assert.rejects(down.api.get('/v1/files/ABC', {}), (err: Error) => !err.message.includes(TOKEN));
  const slow = client(() => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
  await rejects(slow.api.get('/v1/files/ABC', {}), 'network', /did not answer within 20 seconds/);
});

test('downloads refuse other hosts, plain http, errors and anything over the limit', async () => {
  const { api, seen } = client(() => new Response(new Uint8Array(11)));
  for (const url of ['http://figma-alpha-api.s3.us-west-2.amazonaws.com/x', 'https://evil.example/x', 'https://amazonaws.com.evil.example/x', 'file:///etc/passwd', 'nope']) {
    await rejects(api.download(url, 100), 'failed', /does not trust/);
  }
  assert.equal(seen.length, 0);
  await rejects(api.download('https://figma-alpha-api.s3.us-west-2.amazonaws.com/x', 10), 'failed', /larger than/);
  await rejects(client(() => new Response('denied', { status: 403 })).api.download('https://s3.amazonaws.com/x', 10), 'failed', /answered 403/);
});
