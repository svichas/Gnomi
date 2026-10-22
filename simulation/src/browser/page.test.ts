import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { BrowserPool, PageDriver } from '../seams.ts';
import type { Action, ActionOutcome, Device } from '../types.ts';
import { DEFAULT_SIGNALS, failedAction, smallTarget, validationError } from '../signals/index.ts';
import { launchBrowserPool } from './pool.ts';
import { listen } from './server.fixture.ts';

const SECRET = 'hunter2-secret';
const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
const items = Array.from({ length: 40 }, (_, i) => `<li><a href="/job/${i}">Backend engineer ${i}</a></li>`).join('');

const pages: Record<string, string> = {
  '/': `<!doctype html><html lang="en"><head>${head}<title>Gnomi fixture</title></head><body>
<nav aria-label="Main"><a href="/next">Next page</a> <a href="/long">Long page</a></nav>
<main>
  <h1>Post a job</h1>
  <form onsubmit="return false">
    <label for="title">Job title</label> <input id="title" placeholder="e.g. Backend engineer">
    <label for="dept">Department</label> <select id="dept"><option>Engineering</option><option>Design</option><option>Sales</option></select>
    <label for="pw">Password</label> <input id="pw" type="password" value="${SECRET}">
    <label for="pw2">Confirm</label> <input id="pw2" type="password" placeholder="Repeat it" value="${SECRET}">
    <label for="shown">Revealed</label> <input id="shown" type="text" autocomplete="current-password" value="${SECRET}">
    <label for="pw3"><div>Password wrapper</div></label> <input id="pw3" type="password" aria-label="Wrapped">
    <input readonly value="read only" aria-label="Locked"> <input disabled value="switched off" aria-label="Off">
    <button type="button" onclick="const p = document.createElement('p'); p.textContent = 'Saved!'; document.body.append(p)">Save</button>
    <button type="button">Dead button</button>
    <button type="button" onclick="this.remove()">Vanish</button>
    <button type="button" disabled>Disabled</button>
  </form>
  <iframe title="Embedded" srcdoc="<button onclick=&quot;document.body.append('clicked')&quot;>Inside frame</button>"></iframe>
</main></body></html>`,
  '/next': `<!doctype html><html><head>${head}<title>Next page</title></head><body><h1>Next page</h1><a href="/">Home</a></body></html>`,
  '/shared-label': `<!doctype html>${head}<label>Credentials<input aria-label="Username"><input aria-label="Password" type="password" value="${SECRET}"></label>`,
  '/long': `<!doctype html><html><head>${head}<title>Long page</title></head><body><main><h1>Long page</h1>
<p>${'Lorem ipsum dolor sit amet. '.repeat(150)}</p><div style="height:1500px"></div><ul>${items}</ul><div style="height:3000px"></div><button>Bottom button</button></main></body></html>`,
  // A custom drop-down closed with opacity 0, as a real vendor pricing page builds it, and a native checkbox under a custom skin.
  '/custom-select': `<!doctype html><html><head>${head}<title>Custom select</title></head><body>
<div role="combobox" aria-label="Dropdown"><button type="button" onclick="this.nextElementSibling.style.opacity = '1'; this.nextElementSibling.style.pointerEvents = 'auto'">1 - 20 employees</button>
<div style="opacity:0;pointer-events:none"><ol><li>1 - 20 employees</li><li>21 - 50 employees</li></ol></div></div>
<label><input type="checkbox" style="opacity:0"> Annual billing</label></body></html>`,
  // A phone menu collapsed as a real marketing site builds it: zero height and pointer-events: none, its links still in the accessibility tree.
  '/mobile-menu': `<!doctype html><html><head>${head}<title>Mobile menu</title></head><body>
<header><div><button aria-label="menu button" onclick="const n = document.querySelector('nav'); n.style.height = 'auto'; n.style.pointerEvents = 'auto'">☰</button></div>
<nav style="height:0;overflow:hidden;pointer-events:none"><div><a href="/next">Pricing</a></div></nav></header>
<main><div><h1>Home</h1></div></main></body></html>`,
  // Custom selects as react-select builds them, opening on mousedown: a searchable one's search box covers its placeholder,
  // and a plain one's input is a 0×0 dummy pushed off to the left.
  '/react-select': `<!doctype html><html><head>${head}<title>React select</title></head><body>
<div onmousedown="document.getElementById('categories').hidden = false" style="width:300px;border:1px solid #888">
<div style="display:grid;padding:8px"><div style="grid-area:1/1/2/3;cursor:default">Choose a category</div>
<div style="grid-area:1/1/2/3"><input aria-label="Category" style="width:100%;border:0;padding:0;background:transparent"></div></div></div>
<ul id="categories" role="listbox" hidden><li role="option">Hiking</li></ul>
<div onmousedown="document.getElementById('sizes').hidden = false" style="width:300px;border:1px solid #888;margin-top:20px">
<div style="display:grid;padding:8px"><div style="grid-area:1/1/2/3">Choose a size</div>
<input role="combobox" aria-label="Size" readonly style="grid-area:1/1/2/3;width:1px;padding:0;border:0;position:relative;left:-100px;transform:scale(.01)"></div></div>
<ul id="sizes" role="listbox" hidden><li role="option">Large</li></ul></body></html>`,
  '/dates': `<!doctype html><html><head>${head}<title>Dates</title></head><body>
<input type="date" aria-label="Day"> <input type="time" aria-label="Start time"> <input type="datetime-local" aria-label="When" value="2020-01-01T10:00"></body></html>`,
  '/time-list': `<!doctype html><html><head>${head}<title>Time list</title></head><body><h1>Pick a time</h1>
<ul role="listbox" aria-label="Time" style="height:100px;overflow-y:auto;margin:0">${Array.from({ length: 12 }, (_, h) => `<li role="option" style="height:30px">${String(h).padStart(2, '0')}:00</li>`).join('')}</ul>
<div style="height:3000px"></div></body></html>`,
  '/keys-and-tabs': `<!doctype html><html><head>${head}<title>Keys and tabs</title></head><body>
<input aria-label="Search" onkeydown="if (event.key === 'Enter') document.body.append('Searched for ' + this.value)">
<a href="/next" target="_blank">Open in a new tab</a>
<button onclick="fetch('/delay/4000', { method: 'POST' }).then(() => document.body.append('Saved slowly'))">Slow save</button>
<button onclick="fetch('/delay/1500')">Poll</button></body></html>`,
  // What a page shows a moment after an action: suggestions after a 300 ms debounce and a fetch, options after a slow GET,
  // a menu on a timer, and a save's error after a slow POST.
  '/late': `<!doctype html><html><head>${head}<title>Late</title></head><body>
<label for="where">Meeting point</label><input id="where" autocomplete="off"><ul id="places" role="listbox" aria-label="Places"></ul>
<button type="button" onclick="fetch('/delay/700').then(() => { categories.innerHTML = '<li role=option>Hiking</li>' })">Choose a category</button><ul id="categories" role="listbox" aria-label="Categories"></ul>
<button type="button" onclick="setTimeout(() => { actions.innerHTML = '<li role=menuitem>Duplicate</li>' }, 400)">More actions</button><ul id="actions" role="menu" aria-label="Actions"></ul>
<button type="button">Dead button</button>
<form onsubmit="event.preventDefault(); fetch('/delay/1200', { method: 'POST' }).then(() => { const a = document.createElement('div'); a.setAttribute('role', 'alert'); a.textContent = 'Please choose a category'; document.body.append(a) })"><button>Publish</button></form>
<script>let t; where.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => fetch('/delay/150').then(() => { places.innerHTML = '<li role=option>Athens Riviera</li>' }), 300) })</script>
</body></html>`,
  // Clicks whose effect is a state change no DOM node shows (a tick, a choice, the caret, a download, a switch in a shadow root),
  // a dead button, one below the fold, and a list that scrolls.
  '/state': `<!doctype html><html><head>${head}<title>State</title></head><body>
<label><input type="checkbox"> Free event</label> <label><input type="radio" name="level"> Easy</label> <label><input type="radio" name="level"> Hard</label>
<label for="name">Event name</label> <input id="name"> <label for="kind">Kind</label> <select id="kind"><option>A</option><option>B</option></select>
<button type="button">Dead button</button> <a href="/file.csv" download>Export attendees</a> <notify-switch></notify-switch>
<ul aria-label="Stops" style="height:150px;overflow:auto">${Array.from({ length: 20 }, (_, i) => `<li>Stop ${i}</li>`).join('')}</ul>
<div style="height:2500px"></div><button type="button">Dead low button</button>
<script>customElements.define('notify-switch', class extends HTMLElement { connectedCallback() {
  const root = this.attachShadow({ mode: 'open' });
  root.innerHTML = '<button role="switch" aria-checked="false">Notify me</button>';
  root.firstChild.onclick = (e) => e.target.setAttribute('aria-checked', String(e.target.getAttribute('aria-checked') !== 'true'));
} });</script></body></html>`,
  // Controls a person's tap cannot reach: under a see-through 'Saving…' overlay, a chat bubble, a cookie bar at the bottom of a
  // page that cannot scroll, a modal dialog; a link in a collapsed accordion; a menu item hidden since the snapshot. The title
  // lists every click that landed.
  '/covers': `<!doctype html><html><head>${head}<title>clicks:</title></head><body style="margin:0">
<script>document.addEventListener('click', (e) => { document.title += ' ' + (e.target.closest('[data-n]') ?? e.target).dataset.n }, true)</script>
<button data-n="publish" style="position:absolute;left:20px;top:20px">Publish</button>
<div data-n="saving" style="position:fixed;left:0;top:0;width:200px;height:80px;background:rgba(255,255,255,.6)">Saving…</div>
<button data-n="next" style="position:absolute;left:20px;top:120px;width:90px;height:50px">Next</button>
<div data-n="chat" role="button" aria-label="Open chat" style="position:fixed;left:10px;top:110px;width:120px;height:70px;border-radius:35px;background:#36f"></div>
<button data-n="save" style="position:absolute;left:20px;top:220px">Save draft</button>
<button data-n="delete" style="position:absolute;left:20px;top:260px" onclick="document.querySelector('dialog').showModal()">Delete event</button>
<dialog data-n="dialog"><p>Delete this event?</p></dialog>
<section style="position:absolute;left:300px;top:20px"><button data-n="shipping">Shipping</button>
<div style="max-height:0;overflow:hidden"><a data-n="privacy" href="#privacy">Privacy policy</a></div><button data-n="returns">Returns</button></section>
<div style="position:absolute;left:600px;top:20px"><button data-n="account" onclick="setTimeout(() => { menu.style.display = 'none' }, 200)">Account</button>
<ul id="menu"><li><a data-n="logout" href="#logout">Log out</a></li></ul></div>
<button data-n="continue" style="position:absolute;left:20px;top:700px;width:300px;height:44px">Continue</button>
<div data-n="cookies" role="region" aria-label="Cookies" style="position:fixed;left:0;right:0;bottom:0;height:140px;background:#eee">We use cookies. <button data-n="accept">Accept all</button></div>
</body></html>`,
  // Checkboxes and radios as skins build them: sr-only inside the label, sr-only beside a label[for] card, transparent under a ::before box.
  '/skins': `<!doctype html><html><head>${head}<title>Skins</title><style>
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
label{display:block;position:relative;min-height:44px;padding:8px 8px 8px 40px;margin:8px;border:1px solid #888}
.skin input{position:absolute;left:8px;top:12px;z-index:-1;width:16px;height:16px;margin:0;opacity:0}
.skin span::before{content:"";position:absolute;left:8px;top:12px;width:16px;height:16px;border:1px solid #888;background:#fff}
</style></head><body>
<label><input type="checkbox" class="sr"> Email notifications</label>
<input type="radio" name="size" id="small" class="sr"><label for="small">Small</label>
<input type="radio" name="size" id="large" class="sr"><label for="large">Large</label>
<label class="skin"><input type="checkbox"><span>I agree to the terms</span></label></body></html>`,
  // A menu that shows on :hover, a slider set by arrow keys, and a menu button that listens only for touch, as older phone menus do.
  '/hover': `<!doctype html><html><head>${head}<title>Hover</title><style>.sub{display:none}.menu:hover .sub{display:block}</style></head><body>
<nav><div class="menu"><a href="/next">Events</a><ul class="sub"><li><a href="/long">Create event</a></li></ul></div></nav></body></html>`,
  '/slider': `<!doctype html><html><head>${head}<title>Slider</title></head><body><p>Group size</p>
<div role="slider" tabindex="0" aria-label="Group size" aria-valuemin="1" aria-valuemax="20" aria-valuenow="5"
onkeydown="const k = { ArrowRight: 1, ArrowLeft: -1 }[event.key]; if (k) this.ariaValueNow = Math.min(20, Math.max(1, +this.ariaValueNow + k))">●</div></body></html>`,
  '/touch': `<!doctype html><html><head>${head}<title>Touch</title></head><body>
<button ontouchend="event.preventDefault(); document.body.append('Menu open')">Menu</button></body></html>`,
  '/slow-form': `<!doctype html><html><head>${head}<title>Slow form</title></head><body><form method="post" action="/create"><button>Create event</button></form></body></html>`,
  '/errors': `<!doctype html><html><head>${head}<title>Errors</title></head><body>
<button onclick="console.error('boom from the app'); console.error('boom from the app'); fetch('/status/500?token=secret'); fetch('http://blocked.test/beacon').catch(() => {}); setTimeout(() => { throw new Error('kaboom'); })">Break</button>
<a href="/status/404">Broken link</a></body></html>`,
};

let pool: BrowserPool;
let server: http.Server;
let origin: string;
let posts = 0; // form POSTs /create received

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/shot') {
      // Two inputs whose values come from the query, to compare screenshots of different values.
      const { password = '', text = '' } = Object.fromEntries(url.searchParams);
      res.end(`<!doctype html><title>shot</title><body style="margin:20px"><input type="password" value="${password}" style="width:200px;height:30px"> <input value="${text}" style="width:200px;height:30px"></body>`);
    } else if (url.pathname.startsWith('/delay/')) {
      setTimeout(() => res.end('ok'), Number(url.pathname.slice('/delay/'.length)));
    } else if (url.pathname === '/create') {
      posts++;
      setTimeout(() => res.end('<title>Created</title><h1>Event created</h1>'), 6_000);
    } else if (url.pathname === '/file.csv') {
      res.setHeader('content-type', 'text/csv');
      res.setHeader('content-disposition', 'attachment; filename="attendees.csv"');
      res.end('name\nAlice\n');
    } else if (url.pathname.startsWith('/status/')) {
      res.statusCode = Number(url.pathname.slice('/status/'.length));
      res.end('<h1>Failed</h1>');
    } else {
      res.end(pages[url.pathname] ?? '<h1>Not found</h1>');
    }
  });
  origin = await listen(server);
  pool = await launchBrowserPool();
});

after(async () => {
  await pool.close();
  server.close();
});

async function open(t: TestContext, path = '/', device: Device = 'desktop'): Promise<PageDriver> {
  const page = await pool.newPage({ device, allowedHosts: [new URL(origin).hostname], blockedDomains: [], storageState: null, onBlockedRequest: () => {} });
  t.after(() => page.close());
  await page.goto(origin + path);
  return page;
}

const act = (page: PageDriver, type: Action['type'], ref: string | null = null, text: string | null = null): Promise<ActionOutcome> => page.act({ type, ref, text });

function refOf(snapshot: string, line: RegExp): string {
  const match = line.exec(snapshot);
  assert.ok(match, `no snapshot line matches ${line}`);
  return match[1];
}

function jpegWidth(bytes: Uint8Array): number {
  for (let i = 2; i < bytes.length; ) {
    if (bytes[i] !== 0xff) i++;
    else if (bytes[i + 1] >= 0xc0 && bytes[i + 1] <= 0xc3) return (bytes[i + 7] << 8) | bytes[i + 8];
    else i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  throw new Error('no JPEG frame header');
}

test('snapshot carries url, title, refs, boxes and a hash that tracks the content', async (t) => {
  const page = await open(t);
  const first = await page.snapshot();
  assert.equal(first.url, `${origin}/`);
  assert.equal(first.title, 'Gnomi fixture');
  assert.match(first.text, /button "Save" \[ref=e\d+\] \[box=\d+,\d+,\d+,\d+\]/);
  assert.match(first.text, /heading "Post a job" \[level=1\] \[ref=e\d+\]/);
  assert.match(first.hash, /^[0-9a-f]{40}$/);
  assert.equal((await page.snapshot()).hash, first.hash);
  await act(page, 'click', refOf(first.text, /button "Save" \[ref=(\w+)\]/));
  assert.notEqual((await page.snapshot()).hash, first.hash);
});

test('click by ref changes the DOM and reports dom_changed with the target', async (t) => {
  const page = await open(t);
  const { text } = await page.snapshot();
  const outcome = await act(page, 'click', refOf(text, /button "Save" \[ref=(\w+)\]/));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.error, null);
  assert.equal(outcome.dom_changed, true);
  assert.equal(outcome.url_before, outcome.url_after);
  assert.equal(outcome.target?.role, 'button');
  assert.equal(outcome.target?.name, 'Save');
  assert.equal(outcome.target?.box?.length, 4);
  assert.match((await page.snapshot()).text, /Saved!/);
});

test('a click that changes nothing reports dom_changed=false', async (t) => {
  const page = await open(t);
  const { text } = await page.snapshot();
  const outcome = await act(page, 'click', refOf(text, /button "Dead button" \[ref=(\w+)\]/));
  assert.deepEqual([outcome.ok, outcome.dom_changed], [true, false]);
});

test('clicking a link navigates and reports both URLs', async (t) => {
  const page = await open(t);
  const { text } = await page.snapshot();
  const outcome = await act(page, 'click', refOf(text, /link "Next page" \[ref=(\w+)\]/));
  assert.deepEqual([outcome.url_before, outcome.url_after, outcome.dom_changed], [`${origin}/`, `${origin}/next`, true]);
  assert.equal((await page.snapshot()).title, 'Next page');
});

test('a click inside an iframe is addressable and counts as a DOM change', async (t) => {
  const page = await open(t);
  const { text } = await page.snapshot();
  const outcome = await act(page, 'click', refOf(text, /button "Inside frame" \[ref=(\w+)\]/));
  assert.deepEqual([outcome.ok, outcome.dom_changed], [true, true]);
});

test('type fills a textbox, replacing what was there', async (t) => {
  const page = await open(t);
  const ref = refOf((await page.snapshot()).text, /textbox "Job title" \[ref=(\w+)\]/);
  assert.equal((await act(page, 'type', ref, 'Junior Engineer')).ok, true);
  const outcome = await act(page, 'type', ref, 'Senior Backend Engineer');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.target?.name, 'Job title');
  const { text } = await page.snapshot();
  assert.match(text, /Senior Backend Engineer/);
  assert.doesNotMatch(text, /Junior Engineer/);
});

test('type into something that cannot hold text is not_editable', async (t) => {
  const page = await open(t);
  const { text } = await page.snapshot();
  for (const line of [/button "Save" \[ref=(\w+)\]/, /textbox "Locked" \[ref=(\w+)\]/, /textbox "Off" \[disabled\] \[ref=(\w+)\]/, /combobox "Department" \[ref=(\w+)\]/]) {
    const outcome = await act(page, 'type', refOf(text, line), 'x');
    assert.deepEqual([outcome.ok, outcome.error], [false, 'not_editable'], String(line));
  }
});

test('select picks an option by label', async (t) => {
  const page = await open(t);
  const ref = refOf((await page.snapshot()).text, /combobox "Department" \[ref=(\w+)\]/);
  assert.equal((await act(page, 'select', ref, 'Design')).ok, true);
  const { text } = await page.snapshot();
  assert.match(text, /option "Design" \[selected\]/);
  assert.doesNotMatch(text, /option "Engineering" \[selected\]/);
});

test('select of an option that does not exist is option_not_found', async (t) => {
  const page = await open(t);
  const ref = refOf((await page.snapshot()).text, /combobox "Department" \[ref=(\w+)\]/);
  const outcome = await act(page, 'select', ref, 'Nope');
  assert.deepEqual([outcome.ok, outcome.error], [false, 'option_not_found']);
});

test('select on a custom list that is not a <select> is not_a_select', async (t) => {
  const page = await open(t, '/custom-select');
  const ref = refOf((await page.snapshot()).text, /combobox "Dropdown" \[ref=(\w+)\]/);
  const outcome = await act(page, 'select', ref, '21 - 50 employees');
  assert.deepEqual([outcome.ok, outcome.error], [false, 'not_a_select']);
});

test('content at opacity 0 stays out of the snapshot until it shows, a transparent form field stays in', async (t) => {
  const page = await open(t, '/custom-select');
  const closed = (await page.snapshot()).text;
  assert.doesNotMatch(closed, /21 - 50 employees/);
  assert.match(closed, /checkbox "Annual billing"/);
  await act(page, 'click', refOf(closed, /button "1 - 20 employees" \[ref=(\w+)\]/));
  // Shows once the page's own style opens it: the snapshot put the page's styles back.
  assert.match((await page.snapshot()).text, /listitem \[ref=\w+\].*: 21 - 50 employees/);
});

test('a collapsed menu stays out of the snapshot, and a ref the persona was not shown taps nothing', async (t) => {
  const page = await open(t, '/mobile-menu', 'mobile');
  const closed = (await page.snapshot()).text;
  assert.doesNotMatch(closed, /Pricing/);
  // A ref Playwright still resolves but the snapshot left out (a hoisted wrapper), as a model guessing one would send.
  const refs = [...closed.matchAll(/\[ref=e(\d+)\]/g)].map((m) => +m[1]);
  const unseen = Array.from({ length: Math.max(...refs) - Math.min(...refs) }, (_, i) => Math.min(...refs) + i).find((n) => !refs.includes(n));
  assert.ok(unseen, closed);
  assert.equal((await act(page, 'click', `e${unseen}`)).error, 'ref_not_found');
  await act(page, 'click', refOf(closed, /button "menu button" \[ref=(\w+)\]/));
  const opened = (await page.snapshot()).text;
  assert.match((await act(page, 'click', refOf(opened, /link "Pricing" \[ref=(\w+)\]/))).url_after, /\/next$/);
});

test('personas can type passwords while existing and entered values stay out of snapshots', async (t) => {
  const page = await open(t);
  const { text } = await page.snapshot();
  assert.doesNotMatch(text, new RegExp(SECRET)); // the type=password inputs and the one a toggle revealed as type=text
  assert.match(text, /textbox "Password" \[ref=\w+\] \[box=\d+,\d+,\d+,\d+\] \[password: filled\]/);
  for (const name of ['Password', 'Confirm', 'Revealed']) {
    const outcome = await act(page, 'type', refOf(text, new RegExp(`textbox "${name}" \\[ref=(\\w+)\\]`)), 'my-new-password');
    assert.deepEqual([outcome.ok, outcome.error], [true, null], name);
  }
  // A label's descendant addresses the same editable control.
  const viaLabel = await act(page, 'type', refOf(text, /generic \[ref=(\w+)\] \[box=[\d,]+\]: Password wrapper/), 'my-new-password');
  assert.deepEqual([viaLabel.ok, viaLabel.error], [true, null]);
  assert.doesNotMatch((await page.snapshot()).text, /my-new-password/);
});

test('screenshot masks password inputs but not other inputs', async (t) => {
  const page = await open(t);
  const shot = async (query: string) => {
    const shotPage = await open(t, `/shot?${query}`);
    return Buffer.from(await shotPage.screenshot());
  };
  assert.deepEqual(await shot('password=aaaaaaaa&text=same'), await shot('password=bbbbbbbb&text=same'));
  assert.notDeepEqual(await shot('password=same&text=aaaaaaaa'), await shot('password=same&text=bbbbbbbb'));
  void page;
});

test('a password stays masked when its enclosing label points at a different control', async (t) => {
  const page = await open(t, '/shared-label');
  const snapshot = await page.snapshot();
  assert.doesNotMatch(snapshot.text, new RegExp(SECRET));
  assert.match(snapshot.text, /textbox "Password"[^\n]*\[password: filled\]/);
  assert.doesNotMatch(snapshot.text, /textbox "Username"[^\n]*\[password:/);
});

test('screenshot is a JPEG at one pixel per CSS pixel', async (t) => {
  const desktop = await open(t);
  const bytes = await desktop.screenshot();
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8]);
  assert.equal(jpegWidth(bytes), 1280);
  const mobile = await open(t, '/', 'mobile');
  assert.equal(jpegWidth(await mobile.screenshot()), 393);
});

test('unknown, malformed and stale refs are ref_not_found, never an exception', async (t) => {
  const page = await open(t);
  const { text } = await page.snapshot();
  for (const ref of ['e9999', 'f9e1', 'not a ref!!', '[ref=e1]', 'e1 >> text=Save']) {
    const outcome = await act(page, 'click', ref);
    assert.deepEqual([outcome.ok, outcome.error], [false, 'ref_not_found'], ref);
  }
  const vanish = refOf(text, /button "Vanish" \[ref=(\w+)\]/);
  assert.equal((await act(page, 'click', vanish)).ok, true);
  const stale = await act(page, 'click', vanish);
  assert.deepEqual([stale.ok, stale.error], [false, 'ref_not_found']);
  assert.equal((await page.snapshot()).title, 'Gnomi fixture'); // the page survived all of it
});

test('missing ref or text is a short error, not an exception', async (t) => {
  const page = await open(t);
  assert.equal((await act(page, 'click')).error, 'missing ref');
  assert.equal((await act(page, 'navigate')).error, 'navigate needs a url');
  assert.equal((await act(page, 'scroll')).error, "scroll needs a ref, or text 'up' or 'down'");
  const ref = refOf((await page.snapshot()).text, /textbox "Job title" \[ref=(\w+)\]/);
  assert.equal((await act(page, 'type', ref)).error, 'type needs text');
});

test('navigate stays on the allowed origin', async (t) => {
  const page = await open(t);
  for (const url of ['https://example.com/', `http://localhost:${new URL(origin).port}/`, '//example.com/x', 'javascript:alert(1)', 'data:text/html,hi']) {
    const outcome = await act(page, 'navigate', null, url);
    assert.deepEqual([outcome.ok, outcome.error, outcome.url_after], [false, 'host_not_allowed', `${origin}/`], url);
  }
  const ok = await act(page, 'navigate', null, '/next');
  assert.deepEqual([ok.ok, ok.url_after, ok.dom_changed], [true, `${origin}/next`, true]);
  assert.equal((await act(page, 'navigate', null, `${origin}/long`)).url_after, `${origin}/long`);
});

test('back returns to the previous URL', async (t) => {
  const page = await open(t);
  await act(page, 'navigate', null, '/next');
  const outcome = await act(page, 'back');
  assert.deepEqual([outcome.ok, outcome.url_before, outcome.url_after], [true, `${origin}/next`, `${origin}/`]);
});

test('read returns the element text, cut at 2,000 characters', async (t) => {
  const page = await open(t);
  const short = await act(page, 'read', refOf((await page.snapshot()).text, /heading "Post a job" \[level=1\] \[ref=(\w+)\]/));
  assert.deepEqual([short.ok, short.text], [true, 'Post a job']);
  const long = await open(t, '/long');
  const outcome = await act(long, 'read', refOf((await long.snapshot()).text, /main \[ref=(\w+)\]/));
  assert.equal(outcome.text?.length, 2001);
  assert.ok(outcome.text?.endsWith('…'));
  assert.equal(outcome.dom_changed, false);
});

test('scroll moves the page by wheel, and to a ref', async (t) => {
  const page = await open(t, '/long');
  const headingY = async () => Number(/heading "Long page".*?\[box=-?\d+,(-?\d+),/.exec((await page.snapshot()).text)![1]);
  const top = await headingY();
  assert.equal((await act(page, 'scroll', null, 'down')).ok, true);
  const down = await headingY();
  assert.ok(down < top - 400, `${top} -> ${down}`);
  await act(page, 'scroll', null, 'up');
  assert.equal(await headingY(), top);
  const bottom = refOf((await page.snapshot()).text, /button "Bottom button" \[ref=(\w+)\]/);
  assert.equal((await act(page, 'scroll', bottom)).ok, true);
  assert.match((await page.snapshot()).text, /button "Bottom button" \[ref=\w+\] \[box=\d+,\d+,\d+,\d+\]/); // y is no longer thousands of pixels away
});

test('wait settles and reports nothing changed', async (t) => {
  const page = await open(t);
  const outcome = await act(page, 'wait');
  assert.deepEqual([outcome.ok, outcome.dom_changed, outcome.target, outcome.text], [true, false, null, null]);
});

test('press sends a key a person uses to a field or to whatever has focus, and nothing else', async (t) => {
  const page = await open(t, '/keys-and-tabs');
  const search = refOf((await page.snapshot()).text, /textbox "Search" \[ref=(\w+)\]/);
  await act(page, 'type', search, 'engineer');
  const pressed = await act(page, 'press', search, 'Enter');
  assert.deepEqual([pressed.ok, pressed.dom_changed], [true, true]);
  assert.match((await page.snapshot()).text, /Searched for engineer/);
  assert.equal((await act(page, 'press', null, 'Escape')).ok, true);
  assert.equal((await act(page, 'press', search, 'Tab')).ok, true);
  assert.match((await act(page, 'press', search, 'F5')).error ?? '', /^press needs one of the keys Enter, Escape, Tab/);
});

test('a link that opens a new tab takes the persona there; a slow response marks the click pending, not dead', async (t) => {
  const page = await open(t, '/keys-and-tabs');
  const { text } = await page.snapshot();
  const slow = await act(page, 'click', refOf(text, /button "Slow save" \[ref=(\w+)\]/));
  assert.deepEqual([slow.ok, slow.dom_changed, slow.pending], [true, false, true]);
  const tab = await act(page, 'click', refOf(text, /link "Open in a new tab" \[ref=(\w+)\]/));
  assert.deepEqual([tab.ok, tab.url_after, tab.pending], [true, `${origin}/next`, true]);
  assert.equal((await page.snapshot()).title, 'Next page');
  const plain = await act(page, 'wait');
  assert.equal(plain.pending, undefined, 'only a step that started something carries the flag');
});

test('the persona sees what the page shows a moment later: a debounced search, a slow GET, a menu on a timer, a slow save', async (t) => {
  const page = await open(t, '/late');
  const step = (action: Action, result: ActionOutcome) => ({ step_no: 1, action, target: result.target, result, snapshot_hash: '' });
  await act(page, 'type', refOf((await page.snapshot()).text, /textbox "Meeting point" \[ref=(\w+)\]/), 'Ath');
  assert.match((await page.snapshot()).text, /option "Athens Riviera"/);
  for (const [name, shown] of [['Choose a category', /option "Hiking"/], ['More actions', /menuitem "Duplicate"/]] as const) {
    const action: Action = { type: 'click', ref: refOf((await page.snapshot()).text, new RegExp(`button "${name}" \\[ref=(\\w+)\\]`)), text: null };
    const result = await page.act(action);
    assert.deepEqual([result.dom_changed, failedAction(step(action, result))], [true, null], name);
    assert.match((await page.snapshot()).text, shown, name);
  }
  const form = (await page.snapshot()).text;
  const publish: Action = { type: 'click', ref: refOf(form, /button "Publish" \[ref=(\w+)\]/), text: null };
  const saved = await page.act(publish);
  const after = (await page.snapshot()).text;
  assert.match(after, /alert[^\n]*: Please choose a category/);
  assert.equal(validationError(step(publish, saved), form, after)?.payload.message, 'Please choose a category');
  const dead: Action = { type: 'click', ref: refOf(after, /button "Dead button" \[ref=(\w+)\]/), text: null };
  const started = Date.now();
  const result = await page.act(dead);
  assert.equal(failedAction(step(dead, result))?.payload.error, 'no_effect');
  assert.ok(Date.now() - started < 1_500, `${Date.now() - started} ms`);
});

test('a click whose effect is a state change is a change, a dead button stays dead after typing and below the fold, a scroll says whether it moved', async (t) => {
  const page = await open(t, '/state');
  const click = async (line: RegExp) => {
    const action: Action = { type: 'click', ref: refOf((await page.snapshot()).text, line), text: null };
    const result = await page.act(action);
    return { result, failed: failedAction({ step_no: 1, action, target: result.target, result, snapshot_hash: '' })?.payload.error ?? null };
  };
  const field = /textbox "Event name" \[ref=(\w+)\]/;
  for (const line of [/checkbox "Free event" \[ref=(\w+)\]/, /radio "Easy" \[ref=(\w+)\]/, field, /combobox "Kind" \[ref=(\w+)\]/, /switch "Notify me" \[ref=(\w+)\]/]) {
    const { result, failed } = await click(line);
    assert.deepEqual([result.dom_changed, failed], [true, null], String(line));
  }
  const ticked = (await page.snapshot()).text;
  assert.match(ticked, /checkbox "Free event" \[checked\]/);
  assert.equal((await act(page, 'select', refOf(ticked, /combobox "Kind" \[ref=(\w+)\]/), 'B')).dom_changed, true);
  await act(page, 'type', refOf(ticked, field), 'Sunrise hike');
  const dead = await click(/button "Dead button" \[ref=(\w+)\]/);
  assert.deepEqual([dead.result.dom_changed, dead.failed], [false, 'no_effect'], 'the field\'s change on blur is not the button\'s doing');
  const download = await click(/link "Export attendees" \[ref=(\w+)\]/);
  assert.deepEqual([download.result.pending, download.failed], [true, null]);
  const list = refOf((await page.snapshot()).text, /list "Stops" \[ref=(\w+)\]/);
  assert.equal((await act(page, 'scroll', list, 'up')).dom_changed, false, 'a list already at its top');
  assert.equal((await act(page, 'scroll', list, 'down')).dom_changed, true, 'the list moved');
  assert.equal((await act(page, 'scroll', null, 'down')).dom_changed, true, 'the page moved');
  assert.equal((await click(/button "Dead low button" \[ref=(\w+)\]/)).failed, 'no_effect', 'scrolling it into view is not its doing');
});

test('a slow GET the click starts, such as a long poll, does not hide that the click changed nothing', async (t) => {
  const page = await open(t, '/keys-and-tabs');
  const action: Action = { type: 'click', ref: refOf((await page.snapshot()).text, /button "Poll" \[ref=(\w+)\]/), text: null };
  const result = await page.act(action);
  assert.deepEqual([result.ok, result.dom_changed, result.pending], [true, false, undefined]);
  assert.equal(failedAction({ step_no: 1, action, target: null, result, snapshot_hash: '' })?.payload.error, 'no_effect');
});

test('a click that can never succeed times out instead of hanging', async (t) => {
  const page = await open(t);
  const started = Date.now();
  const outcome = await act(page, 'click', refOf((await page.snapshot()).text, /button "Disabled" \[disabled\] \[ref=(\w+)\]/));
  assert.deepEqual([outcome.ok, outcome.error], [false, 'timeout']);
  assert.ok(Date.now() - started < 9_000);
});

test('a click on a control that is covered or has no size lands where it shows, as a person taps it', async (t) => {
  await Promise.all((['desktop', 'mobile'] as const).map(async (device) => {
    const page = await open(t, '/react-select', device);
    const { text } = await page.snapshot();
    for (const [line, option] of [[/generic \[ref=(\w+)\][^\n]*: Choose a category/, /option "Hiking"/], [/combobox "Size" \[ref=(\w+)\]/, /option "Large"/]] as const) {
      const outcome = await act(page, 'click', refOf(text, line));
      assert.deepEqual([outcome.ok, outcome.error, outcome.dom_changed], [true, null, true], `${device} ${line}`);
      assert.match((await page.snapshot()).text, option, device);
    }
  }));
});

test('hover shows a menu that opens on :hover without following its link', async (t) => {
  const page = await open(t, '/hover');
  const closed = (await page.snapshot()).text;
  assert.doesNotMatch(closed, /Create event/);
  const outcome = await act(page, 'hover', refOf(closed, /link "Events" \[ref=(\w+)\]/));
  assert.deepEqual([outcome.ok, outcome.url_after], [true, `${origin}/hover`]);
  const opened = (await page.snapshot()).text;
  assert.equal((await act(page, 'click', refOf(opened, /link "Create event" \[ref=(\w+)\]/))).url_after, `${origin}/long`);
});

test('a custom slider shows its value and is set with the arrow keys', async (t) => {
  const page = await open(t, '/slider');
  const before = (await page.snapshot()).text;
  assert.match(before, /slider "Group size" \[ref=\w+\] \[box=[\d,]+\] \[value=5\]/);
  assert.equal((await act(page, 'press', refOf(before, /slider "Group size" \[ref=(\w+)\]/), 'ArrowRight')).ok, true);
  assert.match((await page.snapshot()).text, /slider "Group size" [^\n]*\[value=6\]/);
});

test('on a phone a click is a tap, so a menu that listens for touch opens', async (t) => {
  const page = await open(t, '/touch', 'mobile');
  const outcome = await act(page, 'click', refOf((await page.snapshot()).text, /button "Menu" \[ref=(\w+)\]/));
  assert.deepEqual([outcome.ok, outcome.dom_changed], [true, true]);
  assert.match((await page.snapshot()).text, /Menu open/);
});

test('a click on a control under a banner, an overlay or a dialog, clipped or hidden since, says what is in the way and taps nothing', async (t) => {
  // The control, what is clicked first, the error, and the clicks that landed.
  const cases = [
    [/button "Publish" \[ref=(\w+)\]/, null, 'covered by div "Saving…"', 'clicks:'],
    [/button "Next" \[ref=(\w+)\]/, null, 'covered by button "Open chat"', 'clicks:'],
    [/button "Continue" \[ref=(\w+)\]/, null, 'covered by region "Cookies"', 'clicks:'],
    [/button "Save draft" \[ref=(\w+)\]/, /button "Delete event" \[ref=(\w+)\]/, 'covered by dialog "Delete this event?"', 'clicks: delete'],
    [/link "Privacy policy" \[ref=(\w+)\]/, null, 'not_visible', 'clicks:'],
    [/link "Log out" \[ref=(\w+)\]/, /button "Account" \[ref=(\w+)\]/, 'not_visible', 'clicks: account'], // the menu closes 200 ms after this click
  ] as const;
  // Each waits out Playwright's timeout first: side by side, on pages of their own.
  await Promise.all(cases.map(async ([line, first, error, clicks]) => {
    const page = await open(t, '/covers');
    const { text } = await page.snapshot();
    if (first) await act(page, 'click', refOf(text, first));
    const action: Action = { type: 'click', ref: refOf(text, line), text: null };
    const result = await page.act(action);
    assert.deepEqual([result.ok, result.error], [false, error], String(line));
    assert.equal((await page.snapshot()).title, clicks, `${line}: nothing in the way was clicked`);
    assert.equal(failedAction({ step_no: 1, action, target: result.target, result, snapshot_hash: '' }), null, String(line));
  }));
});

test('a checkbox or radio under a skin or beside its label ticks at once, and its label is the tap target measured', async (t) => {
  for (const device of ['desktop', 'mobile'] as const) {
    const page = await open(t, '/skins', device);
    for (const control of ['checkbox "Email notifications"', 'radio "Large"', 'checkbox "I agree to the terms"']) {
      const action: Action = { type: 'click', ref: refOf((await page.snapshot()).text, new RegExp(`${control} \\[ref=(\\w+)\\]`)), text: null };
      const started = Date.now();
      const result = await page.act(action);
      assert.ok(Date.now() - started < 1_500, `${device} ${control}: ${Date.now() - started} ms`);
      assert.deepEqual([result.ok, result.dom_changed], [true, true], `${device} ${control}`);
      assert.match((await page.snapshot()).text, new RegExp(`${control} \\[checked\\]`), `${device} ${control}`);
      assert.equal(smallTarget({ step_no: 1, action, target: result.target, result, snapshot_hash: '' }, device, DEFAULT_SIGNALS), null, `${device} ${control}: ${result.target?.box}`);
    }
  }
});

test('a page load slower than the action timeout is the click or the navigate going somewhere, not a timeout', async (t) => {
  const started = Date.now();
  const [click, navigate] = await Promise.all([
    open(t, '/slow-form').then(async (page) => act(page, 'click', refOf((await page.snapshot()).text, /button "Create event" \[ref=(\w+)\]/))),
    open(t).then((page) => act(page, 'navigate', null, '/delay/6000')),
  ]);
  assert.deepEqual([click.ok, click.error, click.url_after], [true, null, `${origin}/create`]);
  assert.deepEqual([navigate.ok, navigate.error, navigate.url_after], [true, null, `${origin}/delay/6000`]);
  assert.equal(posts, 1, 'the form was sent once');
  assert.ok(Date.now() - started < 9_000, `${Date.now() - started} ms`);
});

test('type into a native date or time field goes in key by key, in the order the field shows', async (t) => {
  for (const device of ['desktop', 'mobile'] as const) {
    const page = await open(t, '/dates', device);
    const { text } = await page.snapshot();
    const ref = (name: string) => refOf(text, new RegExp(`textbox "${name}" \\[ref=(\\w+)\\]`));
    // Day equals month so either locale order reads the same; a 24-hour field ignores the AM.
    if (device === 'mobile') await act(page, 'click', ref('When')); // a tap opens the picker first, as it did for personas
    for (const [name, typed] of [['Day', '05/05/2026'], ['Start time', '9:30 AM'], ['When', '5/5/2026, 9:30 AM'], ['When', '6/6/2026 10:15 AM']]) {
      const outcome = await act(page, 'type', ref(name), typed);
      assert.deepEqual([outcome.ok, outcome.error], [true, null], `${device} ${name} ${typed}`);
    }
    const after = (await page.snapshot()).text;
    assert.match(after, /textbox "Day" [^\n]*: 2026-05-05/, device);
    assert.match(after, /textbox "Start time" [^\n]*: 09:30/, device);
    assert.match(after, /textbox "When" [^\n]*: 2026-06-06T10:15/, device); // the second typing replaced the first and the old value
    if (device === 'mobile') continue;
    // Digits with no separators only keys can enter: they read as no date to the phone's picker fallback.
    await act(page, 'type', ref('Day'), '07072026');
    assert.match((await page.snapshot()).text, /textbox "Day" [^\n]*: 2026-07-07/);
  }
});

test('scroll up or down on a list that scrolls moves the list under the wheel, not the page', async (t) => {
  const page = await open(t, '/time-list');
  const y = async (line: RegExp) => Number(line.exec((await page.snapshot()).text)![1]);
  const heading = /heading "Pick a time".*?\[box=-?\d+,(-?\d+),/;
  const late = /option "11:00".*?\[box=-?\d+,(-?\d+),/;
  const [top, before] = [await y(heading), await y(late)];
  const list = refOf((await page.snapshot()).text, /listbox "Time" \[ref=(\w+)\]/);
  assert.equal((await act(page, 'scroll', list, 'down')).ok, true);
  assert.equal(await y(heading), top);
  assert.ok((await y(late)) < before - 50, `${before} -> ${await y(late)}`);
  await act(page, 'scroll', list, 'up');
  assert.equal(await y(late), before);
});

test('done and abandon never reach act', async (t) => {
  const page = await open(t);
  await assert.rejects(act(page, 'done', null, 'finished'), /programming error/);
  await assert.rejects(act(page, 'abandon', null, 'gave up'), /programming error/);
});

test('a long page is pruned: runs collapsed, text cut, size bounded', async (t) => {
  const page = await open(t, '/long');
  const { text } = await page.snapshot();
  assert.match(text, /- … \(×35 more\)/);
  assert.doesNotMatch(text, /Backend engineer 20/);
  assert.ok(text.split('\n').every((line) => line.length < 300));
  assert.match(text, /paragraph \[ref=\w+\] \[box=[\d,]+\]: Lorem ipsum.*…$/m);
  assert.ok(text.length < 3_000, `${text.length}`);
});

test('a mobile page is laid out at the phone width', async (t) => {
  const page = await open(t, '/', 'mobile');
  const { text } = await page.snapshot();
  assert.match(text, /navigation "Main" \[ref=\w+\] \[box=\d+,\d+,3\d\d,\d+\]/);
  assert.equal((await act(page, 'click', refOf(text, /button "Save" \[ref=(\w+)\]/))).dom_changed, true);
});

test('errors() drains console errors, uncaught exceptions and 4xx/5xx on allowed hosts, each once, never what containment blocked', async (t) => {
  const page = await open(t, '/errors');
  assert.deepEqual(page.errors(), []);
  await act(page, 'click', refOf((await page.snapshot()).text, /button "Break" \[ref=(\w+)\]/));
  assert.deepEqual(
    page.errors().sort((a, b) => a.kind.localeCompare(b.kind)),
    [
      { kind: 'console', status: null, message: 'boom from the app' },
      { kind: 'exception', status: null, message: 'kaboom' },
      { kind: 'http', status: 500, message: `GET ${origin}/status/500` },
    ],
  );
  assert.deepEqual(page.errors(), [], 'drained');
  await act(page, 'click', refOf((await page.snapshot()).text, /link "Broken link" \[ref=(\w+)\]/));
  assert.deepEqual(page.errors(), [{ kind: 'http', status: 404, message: `GET ${origin}/status/404` }], 'a broken link, without Chromium\'s duplicate console line');
});
