// Disposable signup forms exercised through the real browser driver, never a real registration service.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test, type TestContext } from 'node:test';
import type { BrowserPool, PageDriver } from '../seams.ts';
import type { Device } from '../types.ts';
import { launchBrowserPool } from './pool.ts';

const PASSWORD = 'Fixture-Password-A!';
const OTHER_PASSWORD = 'Fixture-Password-B!';
const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:20px;font:16px sans-serif}form{max-width:300px}label,input,button{display:block;margin:8px 0}input{width:280px;height:30px;box-sizing:border-box}</style>';
type Variant = 'password' | 'autocomplete' | 'toggled' | 'label';
const submitted: Array<{ password: string | null; confirmation: string | null }> = [];
let server: http.Server;
let origin: string;
let pool: BrowserPool;

function signup(variant: Variant): string {
  const attributes = variant === 'autocomplete' ? 'type="text" autocomplete="new-password"' : 'type="password"';
  const label = variant === 'label' ? '<label for="password"><div>Password wrapper</div></label>' : '<label for="password">Password</label>';
  return `<!doctype html><html lang="en"><head>${head}<title>Disposable signup</title></head><body>
    <h1>Create an account</h1><form method="post" action="/complete">
    ${label}<input id="password" name="password" aria-label="Password" ${attributes} required minlength="8">
    <label for="confirmation">Confirm password</label><input id="confirmation" name="confirmation" ${attributes} required minlength="8">
    ${variant === 'toggled' ? '<button type="button" onclick="password.type = confirmation.type = \'text\'">Show passwords</button>' : ''}
    <button type="submit">Create account</button></form></body></html>`;
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.method === 'POST' && url.pathname === '/complete') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const data = new URLSearchParams(body);
        const values = { password: data.get('password'), confirmation: data.get('confirmation') };
        submitted.push(values);
        const accepted = values.password === PASSWORD && values.confirmation === PASSWORD;
        res.statusCode = accepted ? 200 : 422;
        res.end(`<!doctype html>${head}<h1>${accepted ? 'Account created' : 'Passwords were not accepted'}</h1>`);
      });
    } else if (url.pathname === '/states') {
      res.end(`<!doctype html><html lang="en"><head>${head}<title>Password states</title></head><body>
        <label for="empty">Empty password</label><input id="empty" type="password">
        <label for="filled">Filled password</label><input id="filled" type="password" value="${PASSWORD}">
        <label for="revealed">Revealed password</label><input id="revealed" type="text" autocomplete="new-password" value="${PASSWORD}">
        </body></html>`);
    } else {
      res.end(signup((url.searchParams.get('variant') ?? 'password') as Variant));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  pool = await launchBrowserPool();
});

after(async () => {
  await pool?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function open(t: TestContext, path: string, device: Device = 'desktop'): Promise<PageDriver> {
  const page = await pool.newPage({ device, allowedHosts: ['127.0.0.1'], blockedDomains: [], storageState: null, onBlockedRequest: () => {} });
  t.after(() => page.close());
  await page.goto(origin + path);
  return page;
}

function lineFor(snapshot: string, role: string, name: string): string {
  const line = snapshot.split('\n').find((line) => line.includes(`${role} "${name}"`));
  assert.ok(line, `Missing ${role} named ${name}`);
  return line;
}

function refFrom(line: string): string {
  const ref = /\[ref=(\w+)\]/.exec(line)?.[1];
  assert.ok(ref, `Missing ref on ${line}`);
  return ref;
}

async function fill(page: PageDriver, name: string, value: string): Promise<void> {
  const snapshot = await page.snapshot();
  const outcome = await page.act({ type: 'type', ref: refFrom(lineFor(snapshot.text, 'textbox', name)), text: value });
  assert.equal(outcome.ok, true, `${name} should accept a synthetic signup password: ${outcome.error}`);
}

async function reveal(page: PageDriver): Promise<void> {
  const snapshot = await page.snapshot();
  const outcome = await page.act({ type: 'click', ref: refFrom(lineFor(snapshot.text, 'button', 'Show passwords')), text: null });
  assert.equal(outcome.ok, true);
}

async function submit(page: PageDriver): Promise<void> {
  const snapshot = await page.snapshot();
  const count = submitted.length;
  const outcome = await page.act({ type: 'click', ref: refFrom(lineFor(snapshot.text, 'button', 'Create account')), text: null });
  assert.equal(outcome.ok, true, outcome.error ?? 'Submit failed');
  assert.equal(submitted.length, count + 1, 'The browser must submit the actual form.');
  assert.deepEqual(submitted.at(-1), { password: PASSWORD, confirmation: PASSWORD });
  const completed = await page.snapshot();
  assert.match(completed.text, /Account created/);
  assert.ok(!completed.text.includes(PASSWORD), 'The confirmation page never reflects the password.');
}

for (const device of ['desktop', 'mobile'] as const) {
  for (const variant of ['password', 'autocomplete', 'toggled'] as const) {
    test(`${device} signup submits password and confirmation through snapshot refs (${variant})`, async (t) => {
      const page = await open(t, `/signup?variant=${variant}`, device);
      if (variant === 'toggled') await reveal(page);
      await fill(page, 'Password', PASSWORD);
      await fill(page, 'Confirm password', PASSWORD);
      const filled = await page.snapshot();
      for (const name of ['Password', 'Confirm password']) {
        assert.match(lineFor(filled.text, 'textbox', name), /\[password: filled\]/);
      }
      assert.ok(!filled.text.includes(PASSWORD), 'Snapshot text must never expose either entered password.');
      await submit(page);
    });
  }

  test(`${device} snapshots distinguish empty and filled password controls without their values`, async (t) => {
    const page = await open(t, '/states', device);
    const snapshot = await page.snapshot();
    assert.ok(!snapshot.text.includes(PASSWORD));
    assert.match(lineFor(snapshot.text, 'textbox', 'Empty password'), /\[password: empty\]/);
    for (const name of ['Filled password', 'Revealed password']) {
      const line = lineFor(snapshot.text, 'textbox', name);
      assert.match(line, /\[password: filled\]/);
      assert.ok(refFrom(line), 'Password state must preserve the actionable ref.');
    }
  });
}

test('a password control addressed through its nested label accepts the synthetic signup value', async (t) => {
  const page = await open(t, '/signup?variant=label');
  const snapshot = await page.snapshot();
  const wrapper = snapshot.text.split('\n').find((line) => /generic .*Password wrapper/.test(line));
  assert.ok(wrapper, 'The label wrapper should have an actionable snapshot ref.');
  const outcome = await page.act({ type: 'type', ref: refFrom(wrapper), text: PASSWORD });
  assert.equal(outcome.ok, true, outcome.error ?? 'Typing through the label failed');
  await fill(page, 'Confirm password', PASSWORD);
  assert.ok(!(await page.snapshot()).text.includes(PASSWORD));
  await submit(page);
});

for (const variant of ['autocomplete', 'toggled'] as const) {
  test(`screenshots mask entered passwords even when input type is text (${variant})`, async (t) => {
    const page = await open(t, `/signup?variant=${variant}`);
    if (variant === 'toggled') await reveal(page);
    await fill(page, 'Password', PASSWORD);
    await fill(page, 'Confirm password', PASSWORD);
    const first = Buffer.from(await page.screenshot());
    await fill(page, 'Password', OTHER_PASSWORD);
    await fill(page, 'Confirm password', OTHER_PASSWORD);
    const second = Buffer.from(await page.screenshot());
    assert.equal(second.equals(first), true, 'Different password values must produce identical masked screenshots.');
    const snapshot = await page.snapshot();
    assert.ok(!snapshot.text.includes(PASSWORD) && !snapshot.text.includes(OTHER_PASSWORD));
  });
}
