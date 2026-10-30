import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { devices, errors } from 'playwright-core';
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page, Request } from 'playwright-core';
import type { PageDriver, PageError, StorageState } from '../seams.ts';
import { PRESS_KEYS, type Action, type ActionOutcome, type ActionTarget, type Device, type PageSnapshot, type Viewport } from '../types.ts';
import type { ActionRefusal, Containment, HostRule } from './contain.ts';
import { personaEnvironment, type LocaleEnvironment } from '../audience/locations.ts';
import { pickedValue } from './dates.ts';
import { inspect } from './inspect.ts';
import { pruneSnapshot, snapshotTargets, type PasswordState } from './prune.ts';
import { sampleFile } from './upload.ts';

const ACTION_MS = 5_000;
const SETTLE_MS = 3_000; // cap on waiting for the page to go quiet after an action
const QUIET_MS = 250; // no DOM mutation for this long counts as settled
const GLANCE_MS = 800; // how long a person keeps looking when a click or keys showed nothing yet: a debounced search, a menu on a timer
const FONTS_MS = 2_000; // how long a screenshot waits for web fonts: a person sees the page as it renders meanwhile

// Playwright waits for every web font before a screenshot, with no cap of its own: a 1.5 MB icon font still downloading
// (Material Symbols on nextadventure.gr) timed screenshots out and stopped runs. screenshot() waits FONTS_MS itself instead.
// shortcut: PW_TEST_SCREENSHOT_NO_FONTS_READY is Playwright's internal switch, read at each screenshot, upgrade if a release drops it (the never-loading font test then fails).
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
const POLL_MS = 100; // how often that look checks for a change
const WAIT_MS = 1_000;
const READ_CHARS = 2_000;
const MAX_ERRORS = 20;
const ERROR_RESOURCES = new Set(['document', 'xhr', 'fetch']);
// Remember recognised password inputs even after a reveal toggle changes their type.
const PASSWORD = 'input[type="password" i], input[autocomplete*="password" i]';
const SECRET = `${PASSWORD}, input[data-gnomi-password]`;
// Model-supplied: reject anything that is not a ref before it reaches Playwright's selector engine.
const REF = /^(?:f\d+)?e\d+$/;
// Roles whose value lives in aria-valuetext or aria-valuenow, which the aria snapshot leaves out (a custom slider or stepper).
const RANGES = new Set(['slider', 'spinbutton', 'progressbar']);
// Native inputs Chromium edits segment by segment (day, month, year, hour…).
const SEGMENTED = new Set(['date', 'time', 'datetime-local', 'month', 'week']);
// How each takes its value from the persona: typed, as Chromium's own calendar and clock never stay open for it (act() shuts them).
const TYPED_AS: Record<string, string> = { date: 'type the date as YYYY-MM-DD', time: 'type the time as HH:MM', 'datetime-local': 'type the date and time as YYYY-MM-DD HH:MM', month: 'type the month as YYYY-MM', week: 'type the week as YYYY-Www' };
// Fields typed key by key. Not contenteditable: rich editors read a cleared selection late, and fill() replaces cleanly in each.
const KEYED = new Set(['text', 'email', 'number', 'password', 'search', 'tel', 'url', 'textarea']);

// Runs in the page: what typing meets at el, or at the field its label holds: the input's type, 'select', 'textarea' or
// 'editable'; 'disabled' or 'readonly' when it takes no typing; 'pressable' for what a person presses or ticks, or a toolbar
// or card holding such a control, which a click at its centre could press; null for what holds no text (a custom select's div).
function fieldKind(el: Element): string | null {
  const control = el.matches('input, select, textarea') ? el : (el.closest('label')?.control ?? el);
  const PRESSABLE = 'a[href], button, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab]';
  const kind = control instanceof HTMLSelectElement ? 'select'
    : control instanceof HTMLTextAreaElement ? 'textarea'
    : control instanceof HTMLInputElement ? (/^(?:checkbox|radio|button|submit|reset|image)$/.test(control.type) ? 'pressable' : control.type)
    : (control as HTMLElement).isContentEditable ? 'editable'
    : control.matches(`${PRESSABLE}, option, [role^=menuitem], [role=option]`) || control.querySelector(PRESSABLE) ? 'pressable' : null;
  if (kind === 'pressable') return kind;
  if (control.matches(':disabled') || control.closest('[aria-disabled="true"]')) return 'disabled';
  return (control as HTMLInputElement).readOnly || control.getAttribute('aria-readonly') === 'true' ? 'readonly' : kind;
}

/** Lower case, spacing and width folded, a leading emoji or flag dropped: how a person reads '🇬🇷 Greece' as Greece. */
const plain = (text: string) => text.normalize('NFKC').replace(/^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\s]|\u200d|\ufe0f)+/u, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The option a persona means by `text`: its exact label, else the only one that reads the same, else the only one that contains it. */
function matchLabel(labels: string[], text: string): string | null {
  if (labels.includes(text)) return text;
  const want = plain(text);
  for (const same of [(label: string) => plain(label) === want, (label: string) => want !== '' && plain(label).includes(want)]) {
    const found = [...new Set(labels.filter(same))];
    if (found.length === 1) return found[0];
  }
  return null;
}

const hasSize = async (locator: Locator) => {
  const box = await locator.boundingBox({ timeout: 1_000 }).catch(() => null);
  return box !== null && box.width >= 1 && box.height >= 1;
};

/** An error's first line, at most 200 characters: what the log keeps of it. */
export const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200);

// Runs in the page: return only presence, never the existing password itself.
function passwordState(el: Element, selector: string): 'empty' | 'filled' | null {
  const control = el.matches(selector) ? el : el.closest('label')?.control;
  return control?.matches(selector) ? ((control as HTMLInputElement).value ? 'filled' : 'empty') : null;
}

// Runs in the page: why a person's tap at the centre of `spot` (el, or the sized ancestor it shows in) would not reach el, or
// null when it would: on el, in spot, or through see-through layers of el's own (a custom select's search box over its
// placeholder). An ancestor that clips spot makes it not_visible; an overlay, a fixed bar or a modal on top covers it.
// With no spot, el is a checkbox or radio that does not show where it sits (sr-only, transparent under a skin, under its
// label): it is tapped through its largest label. 'plain' when el is anything else, or shows itself. A fixed or sticky bar over
// it is scrolled clear first, as Playwright does for a target it can click itself.
// shortcut: light-DOM ancestors only, so a layer across a shadow boundary goes unseen, upgrade if a target app nests them.
function reach(el: Element, spot: Element | null): string | null {
  const root = el.getRootNode() as Document | ShadowRoot;
  const centre = (e: Element) => {
    (e as Element & { scrollIntoViewIfNeeded(): void }).scrollIntoViewIfNeeded(); // Chromium's own, as Playwright scrolls: only when out of view
    const r = e.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2] as const;
  };
  if (!spot) {
    if (!(el instanceof HTMLInputElement) || !/^(?:checkbox|radio)$/i.test(el.type) || el.disabled || root.elementFromPoint(...centre(el)) === el) return 'plain';
    const area = (e: Element) => e.getBoundingClientRect().width * e.getBoundingClientRect().height;
    spot = [el, ...(el.labels ?? [])].reduce((a, b) => (area(b) > area(a) ? b : a));
  }
  const at = spot;
  // Why a tap at the centre of `at` misses el, and whether what is over it is a bar fixed to the screen; null when it reaches.
  const blocked = (): { why: string; bar: boolean } | null => {
    const [x, y] = centre(at);
    for (let a = at.parentElement; a && a !== document.body; a = a.parentElement) {
      const r = a.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(getComputedStyle(a).overflow) && !(x > r.left && x < r.right && y > r.top && y < r.bottom)) return { why: 'not_visible', bar: false }; // a collapsed panel has no inside at all
    }
    const hit = root.elementFromPoint(x, y);
    if (!hit) return { why: 'not_visible', bar: false };
    if (at.contains(hit) || el.contains(hit)) return null;
    let over: Element | null = hit;
    while (over && !over.matches(':modal') && !/fixed|sticky/.test(getComputedStyle(over).position)) over = over.parentElement;
    if (over?.contains(el)) over = null; // el's own layer, such as a fixed sheet it sits in
    const bar = over !== null && !over.matches(':modal');
    for (let e: Element | null = hit; !over && e && !e.contains(el); e = e.parentElement) {
      const style = getComputedStyle(e);
      if (style.opacity !== '0' && (!/^transparent$|, 0\)$/.test(style.backgroundColor) || style.backgroundImage !== 'none')) over = e;
    }
    if (!over) return null;
    const name = over.getAttribute('aria-label') ?? (over as HTMLElement).innerText?.trim().split('\n')[0] ?? '';
    return { why: `covered by ${over.getAttribute('role') ?? over.localName}${name && ` "${name.slice(0, 40).replaceAll('"', "'")}"`}`, bar }; // an unnamed backdrop by its kind alone
  };
  let found = blocked();
  // A header or a form's bottom bar fixed to the screen covers only what has scrolled under it: a person scrolls it into the clear.
  if (found?.bar) {
    at.scrollIntoView({ block: 'center', inline: 'nearest' });
    found = blocked();
  }
  return found?.why ?? null;
}

// Runs in the page: the largest box of el and its labels, where a person taps a checkbox or radio.
function labelBox(el: Element): [number, number, number, number] {
  const r = [el, ...((el as HTMLInputElement).labels ?? [])].map((e) => e.getBoundingClientRect()).reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
}

// Runs in the page: what a person's scroll up or down moves. Around el: el if it scrolls, else the nearest element around
// it that does, across shadow roots and slots and short of the page (the paper a menu's list sits in), else the first one
// inside it (a drawer's body). With no el: the topmost open modal's, else the page when it scrolls, else the largest
// scroller on screen (an app shell's main column). Null when nothing does.
function scroller(el: Element | null): Element | null {
  const wheel = (window as unknown as { __gnomi?: { wheel: WeakSet<EventTarget> } }).__gnomi?.wheel;
  // overflow: hidden scrolls too when a script moves it on the wheel (perfect-scrollbar, a virtual list).
  const scrolls = (e: Element) => {
    const y = getComputedStyle(e).overflowY;
    return (/auto|scroll/.test(y) || (y === 'hidden' && !!wheel?.has(e))) && e.scrollHeight > e.clientHeight;
  };
  const page = document.scrollingElement ?? document.documentElement;
  if (el) {
    for (let e: Element | null = el; e && e !== page; e = e.assignedSlot ?? e.parentElement ?? (e.parentNode as ShadowRoot | null)?.host ?? null) if (scrolls(e)) return e;
    return [...el.querySelectorAll('*')].find(scrolls) ?? null;
  }
  // A page locked behind a modal (overflow: hidden) takes no scroll from a person, though scrollBy would still move it.
  const pageScrolls = page.scrollHeight > page.clientHeight && ![document.documentElement, document.body].some((e) => /hidden|clip/.test(getComputedStyle(e).overflowY));
  const modal = [...document.querySelectorAll('[aria-modal="true"], :modal')].filter((m) => m.checkVisibility()).at(-1);
  if (modal) return scroller(modal) ?? (pageScrolls ? page : null);
  if (pageScrolls) return page;
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    return Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  };
  return [...document.querySelectorAll('body *')].filter(scrolls).reduce<Element | null>((best, e) => (shown(e) > (best ? shown(best) : 0) ? e : best), null);
}

// Runs in the page: what people cannot see but the accessibility tree keeps is made visibility: hidden for the snapshot,
// which Playwright does honour, then put back: content at opacity 0 (a closed custom drop-down would read as open), CSS
// text inside display: none (a hidden tooltip's ::before), and what an overflow: hidden ancestor clips away entirely (a
// collapsed accordion, a carousel's other slides) unless a script scrolls that ancestor on the wheel. A form field at
// opacity 0 stays: a native checkbox or <select> under a custom skin, or a file input over its button, is transparent on
// purpose, unless what holds it takes no pointer events (a closed menu with a search box). What the tree misreads gets a
// role for the snapshot: an editable root without one (Quill) is a textbox, and a label whose checkbox or radio is
// display: none (a CSS-only switch) is that control, with its state.
// shortcut: light DOM only, and a fixed element inside a transformed ancestor counts as unclipped, upgrade if a target app needs either.
function hideTransparent(hide: boolean) {
  const FIELD = 'input:not([type="hidden" i]), select, textarea';
  if (!hide) {
    for (const el of document.querySelectorAll<HTMLElement>('[data-gnomi-visibility]')) {
      const [value, priority] = JSON.parse(el.dataset.gnomiVisibility!);
      el.style.setProperty('visibility', value, priority);
      if (!el.getAttribute('style')) el.removeAttribute('style');
      delete el.dataset.gnomiVisibility;
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-gnomi-role]')) {
      for (const [name, value] of Object.entries(JSON.parse(el.dataset.gnomiRole!) as Record<string, string | null>)) {
        if (value === null) el.removeAttribute(name);
        else el.setAttribute(name, value);
      }
      delete el.dataset.gnomiRole;
    }
    return;
  }
  type Clip = { el: Element; box: DOMRect; x: boolean; y: boolean };
  const wheel = (window as unknown as { __gnomi?: { wheel: WeakSet<EventTarget> } }).__gnomi?.wheel;
  const clips = new Map<Element, Clip[]>(); // by element, the ancestors whose overflow clips what it holds, and on which axes
  const hidden: HTMLElement[] = [];
  const roles: [HTMLElement, Record<string, string>][] = [];
  // Read everything first, then write: a style written between reads would make the browser lay the page out again each time.
  for (const el of document.querySelectorAll<HTMLElement>('body *')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || (style.opacity === '0' && !el.matches(FIELD) && !(el.querySelector(FIELD) && style.pointerEvents !== 'none'))) {
      hidden.push(el);
      continue;
    }
    // A fixed element escapes every clip, an absolute one those outside its containing block.
    const around = clips.get(el.parentElement!) ?? [];
    const cb = style.position === 'absolute' ? el.offsetParent : null;
    const outer = style.position === 'fixed' ? [] : style.position === 'absolute' ? around.filter((c) => cb && c.el.contains(cb)) : around;
    const wheels = style.overflowY === 'hidden' && !!wheel?.has(el); // perfect-scrollbar, a virtual list: what it holds is scrolled to as in a list that scrolls
    const [cx, cy] = [/hidden|clip/.test(style.overflowX), /hidden|clip/.test(style.overflowY) && !wheels];
    const r = outer.length || cx || cy ? el.getBoundingClientRect() : null; // a box is read only where a clip is in play
    // What is 1 px or less stays: a visually hidden control (react-select's dummy input, an sr-only checkbox) is its widget's handle.
    if (r && (r.width > 1 || r.height > 1) && outer.some(({ box, x, y }) => (x && (r.right <= box.left || r.left >= box.right)) || (y && (r.bottom <= box.top || r.top >= box.bottom)))) {
      hidden.push(el);
      continue;
    }
    // What el holds can be scrolled to on an axis el scrolls, so clips around el stop there; one that hides clips it.
    const [sx, sy] = [/auto|scroll/.test(style.overflowX), wheels || /auto|scroll/.test(style.overflowY)];
    let inner = sx || sy ? outer.map((c) => ({ ...c, x: c.x && !sx, y: c.y && !sy })).filter((c) => c.x || c.y) : outer;
    // So does what a visually hidden (sr-only, 1×1 px) box clips: its text names a control.
    if (r && (cx || cy) && (r.width > 1 || r.height > 1)) inner = [...inner, { el, box: r, x: cx, y: cy }];
    if (inner.length) clips.set(el, inner);
    if (el.isContentEditable && !el.parentElement!.isContentEditable && !el.hasAttribute('role')) {
      const box = r ?? el.getBoundingClientRect();
      if (box.width > 1 && box.height > 1) roles.push([el, { role: 'textbox' }]); // not Quill 1's 0×1 clipboard off to the left
    }
    const control = el instanceof HTMLLabelElement ? el.control : null;
    if (control instanceof HTMLInputElement && /^(?:checkbox|radio)$/.test(control.type) && !el.hasAttribute('role') && getComputedStyle(control).display === 'none') {
      roles.push([el, { role: control.type, 'aria-checked': String(control.checked) }]);
    }
  }
  for (const el of hidden) {
    el.dataset.gnomiVisibility = JSON.stringify([el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
    el.style.setProperty('visibility', 'hidden', 'important');
  }
  for (const [el, attributes] of roles) {
    el.dataset.gnomiRole = JSON.stringify(Object.fromEntries(Object.keys(attributes).map((name) => [name, el.getAttribute(name)])));
    for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  }
}

// Runs in the page: what the snapshot leaves out of el's value: a custom slider's or stepper's aria-valuetext or aria-valuenow,
// or an editable root's text, which Playwright drops from a textbox unless it sits in child blocks (Quill's paragraphs).
function shownValue(el: Element): string | null {
  if (!(el as HTMLElement).isContentEditable) return el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow');
  const blocks = [...el.childNodes].every((n) => (n instanceof Element ? getComputedStyle(n).display !== 'inline' : !n.textContent?.trim()));
  return blocks ? null : (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim() || null;
}

// Runs in every frame before page scripts: counts DOM mutations (n) and scrolls (s) so act() can tell whether anything changed.
// Playwright ships both this and passwordState to the page with toString(), so they must stay self-contained.
// shortcut: every mutation and input event counts, so a page that animates or fires synthetic input events on a timer always reads as changed (masking a dead click), upgrade by ignoring style-only churn if real apps do this.
function countMutations() {
  const state = { id: Math.random().toString(36).slice(2), n: 0, s: 0, wheel: new WeakSet<EventTarget>() };
  (window as unknown as { __gnomi: typeof state }).__gnomi = state;
  const observer = new MutationObserver((records) => {
    state.n += records.length;
  });
  const observe = (root: Node) => observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  observe(document);
  // A shadow root's changes never reach the document's observer: observe each one as it is attached, and hand it back unchanged.
  // shortcut: declarative shadow roots and scrolls inside a shadow root go uncounted, upgrade if a target app relies on them.
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = attachShadow.call(this, init);
    observe(root);
    return root;
  };
  // A box ticked, an option chosen or the caret landing in a field changes no node. Not 'change': a field fires it on blur,
  // which would hide a dead button clicked right after typing.
  const FIELD = 'input:not([type=button i], [type=submit i], [type=reset i], [type=checkbox i], [type=radio i]), textarea, select, [contenteditable]';
  document.addEventListener('input', () => state.n++, true);
  document.addEventListener('focusin', (e) => (e.composedPath()[0] as Element).matches?.(FIELD) && state.n++, true);
  // Counted apart: Playwright scrolls a target into view before clicking it, which would hide a dead button below the fold.
  document.addEventListener('scroll', () => state.s++, true);
  // What listens for the wheel itself: a list a script scrolls (perfect-scrollbar, a virtual list) is overflow: hidden, which
  // the snapshot would clip and a scroll would pass by.
  const listen = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, ...args: Parameters<EventTarget['addEventListener']>) {
    if (/wheel|mousescroll/i.test(args[0])) state.wheel.add(this);
    return listen.apply(this, args);
  };
}

// Runs in every frame before page scripts: the first field the browser refused since act() last cleared it, and the browser's
// own message ("Please fill out this field."), which shows only as a bubble that no snapshot holds.
function recordInvalid() {
  const page = window as unknown as { __gnomiInvalid: string | null };
  page.__gnomiInvalid = null;
  document.addEventListener('invalid', (e) => {
    const field = e.target as HTMLInputElement;
    const label = (field.labels?.[0]?.innerText || field.getAttribute('aria-label') || field.name || '').replace(/\s+/g, ' ').trim();
    page.__gnomiInvalid ??= `${label && `${label}: `}${field.validationMessage}`.replace(/\s+/g, ' ');
  }, true);
}

/** An isolated context for a persona or a session check: desktop or phone, service workers blocked, behind its containment proxy, optionally logged in. */
export async function newContext(browser: Browser, device: Device, storageState: StorageState | null, proxy: Containment['proxy'], environment: Partial<LocaleEnvironment> = {}): Promise<BrowserContext> {
  const { locale, timezone, languages } = personaEnvironment({ language: environment.locale ?? 'en-US', timezone: environment.timezone, languages: environment.languages });
  const context = await browser.newContext({
    ...(device === 'mobile' ? devices['iPhone 15'] : { viewport: { width: 1280, height: 800 } }),
    locale,
    timezoneId: timezone,
    extraHTTPHeaders: { 'Accept-Language': languages.map((tag, i) => i === 0 ? tag : `${tag};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`).join(',') },
    serviceWorkers: 'block', // they would otherwise bypass request routing (tech.md §9.3)
    storageState: (storageState ?? undefined) as BrowserContextOptions['storageState'],
    proxy,
  });
  try {
    // Playwright's locale controls Intl and navigator.language; its public API has no language-list option.
    // Install the same ordered preferences before application scripts, including in new frames.
    await context.addInitScript((tags) => {
      const preferences = Object.freeze([...tags]);
      Object.defineProperty(Navigator.prototype, 'languages', { configurable: true, get: () => preferences });
    }, languages);
    return context;
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

export async function openPage(context: BrowserContext): Promise<Page> {
  await context.addInitScript(countMutations);
  await context.addInitScript(recordInvalid);
  return context.newPage();
}

// One string per frame (document id + mutation or scroll count): differs after any DOM change (or scroll) or navigation.
const domVersion = async (page: Page, count: 'n' | 's' = 'n') =>
  (
    await Promise.all(
      page.frames().map((frame) =>
        frame
          .evaluate((key) => {
            const state = (window as unknown as { __gnomi?: { id: string; n: number; s: number } }).__gnomi;
            return state ? `${state.id}:${state[key]}` : '';
          }, count)
          .catch(() => ''),
      ),
    )
  ).join('|');

/** Waits, at most SETTLE_MS, for the page to load, for the `started` requests to finish, then for QUIET_MS without a DOM change. */
export async function settle(page: Page, started: ReadonlySet<Request> = new Set()): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  await page.waitForLoadState('load', { timeout: SETTLE_MS }).catch(() => {});
  // A response slower than the cap can read as "nothing happened"; act() flags a write or a load still open as pending instead.
  let last: string | null = null;
  while (Date.now() < deadline) {
    const now = started.size > 0 ? null : await domVersion(page); // an open request is never quiet: its answer is what a person waits for
    if (now !== null && now === last) return;
    last = now;
    await sleep(QUIET_MS);
  }
}

/** `refusals` drains containment's observe-only refusals (contain.ts), so an action that ran into one fails with it. */
export async function newPageDriver(context: BrowserContext, allows: HostRule, refusals: () => ActionRefusal[] = () => [], device: Device = 'desktop'): Promise<PageDriver> {
  let page = await openPage(context); // the tab the persona is on: the first one, or a tab it followed
  // A phone is tapped: touch handlers (a menu on touchend) never hear a mouse click.
  const tap = (locator: Locator, options: { force?: boolean; timeout: number }) => (device === 'mobile' ? locator.tap(options) : locator.click(options));
  let targets = new Map<string, ActionTarget>();
  let shown = ''; // the snapshot text the persona was last given
  let seen = ''; // the raw snapshot behind it, without what moves on every look (refs, boxes, focus): a change only CSS makes shows against it
  let failedNavigation: string | null = null; // the last main-frame page load that did not complete
  let popup: Page | null = null; // a tab the current action opened
  let downloaded = false; // the current action started a download
  let formClick = false; // the current action clicked something inside a form
  let chosen: Promise<string | null> | null = null; // the file the current action chose in a file chooser
  let submitting = false; // the last action was a click or a key, which can submit a form the browser then refuses
  const inflight = new Set<Request>(); // page loads and script writes the current action started that have not finished
  // Every load, fetch and XHR the current action started that has not finished: settle waits for them.
  // shortcut: a page's own GETs meanwhile (analytics, polling) hold settle too, up to SETTLE_MS, upgrade by ignoring repeated URLs if real apps hit the cap.
  const started = new Set<Request>();
  const openers = new WeakMap<Page, Page>(); // a tab the persona followed, and the tab that opened it
  const rememberPasswords = () => Promise.all(page.frames().map((frame) => frame.locator(PASSWORD).evaluateAll((inputs) => {
    for (const input of inputs) if (!input.hasAttribute('data-gnomi-password')) input.setAttribute('data-gnomi-password', '');
  })));

  const hostOf = (url: string) => URL.parse(url)?.hostname ?? '';
  // A page load slower than ACTION_MS is the action going somewhere, not a timeout: pending and the next snapshot tell where.
  const loading = (from: string) => page.url() !== from || [...inflight].some((r) => r.isNavigationRequest() && r.frame() === page.mainFrame());

  // What went wrong in the page since errors() was last drained (tech.md §8.1), each distinct error once.
  // shortcut: at most MAX_ERRORS per step, so a page that throws on every frame cannot flood the log, upgrade to counts if a report needs them.
  let pageErrors: PageError[] = [];
  const capture = (error: PageError) => {
    const message = firstLine(error.message);
    if (pageErrors.length < MAX_ERRORS && !pageErrors.some((e) => e.kind === error.kind && e.status === error.status && e.message === message)) pageErrors.push({ ...error, message });
  };

  // Context-wide, so a new tab's first load counts too: it happens before the tab is handed over. Only the current tab's
  // requests are the action's; every tab's errors are the product's. That first load is issued before its frame exists.
  const frameOf = (request: Request) => {
    try {
      return request.frame();
    } catch {
      return null;
    }
  };
  context.on('request', (request) => {
    if (!ERROR_RESOURCES.has(request.resourceType()) || frameOf(request)?.page() !== page) return;
    started.add(request);
    // A script's GET (analytics, a long poll) is the page's own traffic and would hide a dead click; a write or a load is the action's.
    if (request.resourceType() === 'document' || request.method() !== 'GET') inflight.add(request);
  });
  context.on('requestfinished', (request) => {
    inflight.delete(request);
    started.delete(request);
  });
  context.on('requestfailed', (request) => {
    inflight.delete(request);
    started.delete(request);
    if (request.isNavigationRequest() && !frameOf(request)?.parentFrame()) failedNavigation = request.url();
  });
  context.on('console', (msg) => {
    // Chromium also logs every failed load as a console error: 4xx/5xx come from 'response' below, and containment's refusals are not the product's.
    // A logged object with nothing to read ("Event", "[object Object]") says nothing a persona or the report could use.
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource:') && !/^(?:\w*Event|\[object \w+\])$/.test(msg.text())) capture({ kind: 'console', status: null, message: msg.text() });
  });
  context.on('weberror', (error) => capture({ kind: 'exception', status: null, message: error.error().message }));
  context.on('response', (response) => {
    const request = response.request();
    if (response.status() < 400 || !ERROR_RESOURCES.has(request.resourceType())) return;
    const url = new URL(response.url());
    // The containment proxy answers unlisted hosts with a 403 of its own, so only allowed hosts count.
    if (allows(url.hostname)) capture({ kind: 'http', status: response.status(), message: `${request.method()} ${url.origin}${url.pathname}` }); // no query string: it can carry tokens
  });
  // Every tab the persona has open reports the tabs it opens and its downloads.
  function drive(tab: Page, opener: Page | null) {
    tab.on('popup', (opened) => {
      popup = opened;
      drive(opened, tab);
    });
    tab.on('download', () => {
      downloaded = true;
    });
    // Headless Chromium cancels a file chooser nobody answers: the persona picks a file of the kind the field asks for, as a
    // person picks one from their device.
    tab.on('filechooser', (chooser) => {
      const pick = chooser.element().getAttribute('accept').catch(() => '').then((accept) => {
        const file = sampleFile(accept ?? ''); // unsupported_file, which act() reports, for a kind none can be made of
        return chooser.setFiles(file).then(() => file.name, () => null);
      });
      pick.catch(() => {}); // handled, in case act() has stopped looking: an unhandled rejection would end the run
      chosen = pick;
    });
    if (!opener) return;
    openers.set(tab, opener);
    // A tab that closes, by back or by its own script (a preview's Close button), leaves the persona on the tab it came from.
    tab.once('close', () => {
      if (page === tab) page = opener;
    });
  }
  drive(page, null);

  /** The raw snapshot of what a person sees, as hideTransparent leaves it; `still` drops what moves on every look. */
  async function look() {
    const transparent = (hide: boolean) => Promise.all(page.frames().map((frame) => frame.evaluate(hideTransparent, hide).catch(() => {})));
    await transparent(true);
    return page.ariaSnapshot({ mode: 'ai', boxes: true, timeout: 10_000 }).finally(() => transparent(false));
  }
  const still = (raw: string) => raw.replace(/ \[(?:ref|box|cursor)=[^\]]*\]| \[active\]/g, '');

  /** Back, as a person goes back: a followed tab with no page before it closes, which returns the persona to the tab that opened it. */
  async function back(timeout: number) {
    const opener = openers.get(page);
    if (opener && !(await page.evaluate(() => navigation.canGoBack).catch(() => false))) {
      await page.close();
      page = opener;
      return;
    }
    await page.goBack({ timeout, waitUntil: 'domcontentloaded' });
  }

  /** True when the page load that just happened was refused by containment (a failed load or a refusal page on an unlisted host). */
  const refusedByContainment = () => {
    const url = page.url();
    if (url.startsWith('chrome-error://')) return failedNavigation !== null && !allows(hostOf(failedNavigation)); // a dead listed host is the product's fault, not ours
    return /^https?:/.test(url) && !allows(hostOf(url));
  };

  async function locate(ref: string | null) {
    if (!ref) throw new Error('missing ref');
    // Playwright still resolves refs the pruned snapshot left out, so a guessed one would tap something the persona never saw.
    if (!REF.test(ref) || !shown.includes(`[ref=${ref}]`)) throw new Error('ref_not_found');
    const locator = page.getByRef(ref);
    if ((await locator.count().catch(() => 0)) > 0) return locator;
    // Re-rendered since the snapshot (a polled list, an htmx swap): the one element with the role and name the persona saw.
    // shortcut: main-frame refs only, as getByRole does not reach into frames, upgrade if a target app re-renders inside one.
    const { role, name } = targets.get(ref) ?? { role: '', name: '' };
    const same = page.getByRole(role as Parameters<Page['getByRole']>[0], { name, exact: true });
    if (name && !ref.startsWith('f') && (await same.count().catch(() => 0)) === 1) return same;
    throw new Error('ref_not_found');
  }

  /**
   * Sets a native date or time field to what the persona typed, read in the persona's order and words (ISO as the snapshot
   * shows it reads too). Not by keys: the segments they fill follow the region of the machine running Gnomi, so the same keys
   * would set another date there, and a phone's field takes none. Nor the raw text: a value Chromium cannot read clears it.
   */
  async function typeDate(input: Locator, type: string, text: string, timeout: number) {
    const locale = await input.evaluate(() => navigator.language, null, { timeout });
    const order = new Intl.DateTimeFormat(locale).formatToParts(new Date(2000, 0, 2)).map((part) => part.type);
    const value = text.trim() === '' ? '' : pickedValue(type, text, order.indexOf('day') < order.indexOf('month'), locale);
    // The persona hears it, rather than "text entered" over a field left as it was.
    if (value === null) throw new Error('unreadable_date');
    await input.fill(value, { timeout }).catch((e) => {
      throw /Malformed value/.test(String(e)) ? new Error('unreadable_date') : e; // a week 53 the year does not have
    });
  }

  /**
   * Types `text` key by key. Playwright's US layout has no key for Greek, é or €, and inserts them with no keydown or keyup,
   * which a keyup handler never hears: each goes to Chromium as one key of its own, as a person's own layout sends it.
   */
  async function typeKeys(text: string) {
    if (/^[ -~\r\n\t]*$/.test(text)) return page.keyboard.type(text); // all on the US layout
    const cdp = await page.context().newCDPSession(page);
    try {
      for (const run of text.match(/[ -~\r\n\t]+|[^ -~\r\n\t]/gu) ?? []) {
        if (/^[ -~\r\n\t]/.test(run)) await page.keyboard.type(run);
        else {
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: run, text: run, unmodifiedText: run });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: run });
        }
      }
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  /** The option called `name` of a custom list: in the list, in the one it controls or owns, else in the one listbox open. */
  async function customOption(list: Locator, name: string, timeout: number): Promise<Locator | null> {
    const frame = (await (await list.elementHandle({ timeout })).ownerFrame()) ?? page.mainFrame();
    const ids = [await list.getAttribute('aria-controls', { timeout }), await list.getAttribute('aria-owns', { timeout })].flatMap((names) => names?.split(/\s+/).filter(Boolean) ?? []);
    const open = frame.getByRole('listbox');
    const scopes = [list, ...ids.map((id) => frame.locator(`id=${id}`)), ...((await open.count()) === 1 ? [open] : [])];
    const literal = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const anyCase = new RegExp(`^${literal}$`, 'i');
    for (const scope of scopes) {
      for (const named of [{ name, exact: true }, { name: anyCase }]) {
        const option = scope.getByRole('option', named);
        if ((await option.count()) === 1) return option;
      }
    }
    return null;
  }

  /** Performs the action; resolves to the text of a `read` or the file an upload chose, else null. Model mistakes throw an Error whose message is the code. */
  async function perform(action: Action, ref: string | null): Promise<string | null> {
    const timeout = ACTION_MS;
    switch (action.type) {
      case 'click': {
        const target = await locate(ref);
        const from = page.url();
        formClick = await target.evaluate((el) => el.closest('form') !== null, null, { timeout }).catch(() => false);
        // A skinned checkbox or radio is ticked through its label at once, as a person taps it, not after Playwright's timeout.
        const label = await target.evaluate(reach, null, { timeout }).catch(() => 'plain');
        if (label !== 'plain') {
          if (label) throw new Error(label);
          await target.evaluate((el) => (el as HTMLElement).click(), null, { timeout });
          return null;
        }
        await tap(target, { timeout }).catch(async (e) => {
          if (e instanceof errors.TimeoutError && loading(from)) return;
          // A person taps where the control shows: through a see-through layer of its own (a custom select's search box over its
          // placeholder), or on its nearest sized ancestor when it has no size (a custom select's 0×0 input), never on what
          // covers it or on what no longer shows. A disabled one stays a timeout.
          if (!(e instanceof errors.TimeoutError) || !(await target.isEnabled({ timeout }).catch(() => false))) throw e;
          if (!(await target.evaluate((el) => el.checkVisibility(), null, { timeout }))) throw new Error('not_visible');
          let spot = target;
          for (let up = 0; up < 3 && !(await hasSize(spot)); up++) spot = spot.locator('xpath=..');
          if (!(await hasSize(spot))) throw e;
          const covered = await target.evaluate(reach, await spot.elementHandle({ timeout }), { timeout });
          if (covered) throw new Error(covered);
          await tap(spot, { force: true, timeout });
        });
        return null;
      }
      case 'hover':
        await (await locate(ref)).hover({ timeout });
        return null;
      case 'press':
        // Enter submits a search box with no button; Escape closes a dialog. With no ref, the key goes to whatever has focus.
        if (!PRESS_KEYS.includes(action.text ?? '')) throw new Error(`press needs one of the keys ${PRESS_KEYS.join(', ')}`);
        if (ref) await (await locate(ref)).press(action.text!, { timeout });
        else await page.keyboard.press(action.text!);
        return null;
      case 'type': {
        let input = await locate(ref);
        if (action.text === null) throw new Error('type needs text');
        let kind = await input.evaluate(fieldKind, null, { timeout });
        if (kind === 'disabled') throw new Error('not_editable');
        if (kind === 'pressable') throw new Error('not_a_field'); // typing must never press it
        if (kind === null || kind === 'readonly') {
          // A person clicks where a picker or a custom select shows, then types into what took the caret: its own search box.
          const frame = (await (await input.elementHandle({ timeout })).ownerFrame()) ?? page.mainFrame();
          await perform({ type: 'click', ref, text: null }, ref);
          const focused = frame.locator('*:focus').last();
          const next = await focused.evaluate(fieldKind, null, { timeout: 1_000 }).catch(() => null);
          if (next === null || next === 'pressable' || next === 'readonly' || next === 'disabled') throw new Error(kind ?? 'not_a_field');
          [input, kind] = [focused, next];
        }
        if (kind === 'select') {
          // A focused <select> jumps to the option that starts with the letters typed, as a person's typeahead does.
          await input.evaluate((el) => ((el.matches('select') ? el : el.closest('label')!.control) as HTMLElement).focus(), null, { timeout });
          await page.keyboard.type(action.text);
          return null;
        }
        if (SEGMENTED.has(kind)) {
          await typeDate(input, kind, action.text, timeout);
          return null;
        }
        if (kind === 'file') {
          // What a person picks from their device, named after what the persona typed: a bare file input does not show it.
          const accept = await input.evaluate((el) => ((el.matches('input') ? el : (el.closest('label')?.control ?? el)) as HTMLInputElement).accept ?? '', null, { timeout });
          const file = sampleFile(accept, action.text);
          await input.setInputFiles(file, { timeout });
          return `File chosen: ${file.name}`;
        }
        if (KEYED.has(kind)) {
          // Key by key, as a person types: masks, keyup handlers, split code boxes and a number field's own parsing see every key.
          // fill('') focuses the field a label's descendant points at. One line takes no Enter: it would submit the form.
          await input.fill('', { timeout });
          await typeKeys(kind === 'textarea' ? action.text : action.text.replace(/\r?\n/g, ' '));
          return null;
        }
        // Rich text, colour and range take the value at once.
        await input.fill(action.text, { timeout }).catch((e) => {
          if (/Malformed value/.test(String(e))) throw new Error('invalid_value');
          throw /cannot be filled|not an <input>/.test(String(e)) ? new Error('not_editable') : e;
        });
        return null;
      }
      case 'select': {
        const list = await locate(ref);
        if (action.text === null) throw new Error('select needs text');
        // A native <select>, or the one its label holds: the options a person can choose, and which are chosen.
        const native = await list.evaluate((el) => {
          const select = el.matches('select') ? el : el.closest('label')?.control;
          if (!(select instanceof HTMLSelectElement)) return null;
          return { multiple: select.multiple, options: [...select.options].filter((o) => !o.disabled).map((o) => ({ label: o.label, selected: o.selected })) };
        }, null, { timeout });
        if (!native) {
          // A custom list: the option is clicked, as a person clicks it in the open list. Playwright scrolls to it.
          // shortcut: a long list costs no scrolling steps, where a person flicks through it in a second anyway, upgrade if a report needs that cost.
          const option = await customOption(list, action.text, timeout);
          if (!option) throw new Error('not_a_select');
          await tap(option, { timeout });
          return null;
        }
        const label = matchLabel(native.options.map((o) => o.label), action.text);
        if (label === null) throw new Error('option_not_found');
        // A list that takes several adds the option, or drops one already chosen, as a person's Ctrl-click does.
        const selected = native.options.filter((o) => o.selected).map((o) => o.label);
        const labels = !native.multiple ? [label] : selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label];
        await list.selectOption(labels.map((l) => ({ label: l })), { timeout });
        return null;
      }
      case 'scroll': {
        const direction = action.text === 'down' ? 1 : action.text === 'up' ? -1 : 0;
        const { width, height } = page.viewportSize()!;
        if (ref) {
          const target = await locate(ref);
          // Up or down in a list or panel: the wheel over the part of what scrolls there that shows, as a person scrolls a
          // time list or a menu. Otherwise, or when nothing scrolls there, the ref is brought into view.
          const list = direction ? (await target.evaluateHandle(scroller, null, { timeout })).asElement() : null;
          const shown = async () => {
            const box = await list?.boundingBox();
            if (!box) return null;
            const [x, y] = [Math.max(box.x, 0), Math.max(box.y, 0)];
            const [w, h] = [Math.min(box.x + box.width, width) - x, Math.min(box.y + box.height, height) - y];
            return w > 0 && h > 0 ? { x, y, w, h } : null;
          };
          let box = await shown();
          if (list && !box) {
            await list.scrollIntoViewIfNeeded({ timeout }); // a list below the fold: the page first
            box = await shown();
          }
          if (!box) await target.scrollIntoViewIfNeeded({ timeout });
          else {
            await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
            await page.mouse.wheel(0, direction * box.h * 0.8);
          }
          await list?.dispose();
        } else if (direction) {
          // The page as a person's scroll moves it, not the wheel at the centre, which whatever sits there takes: a map zooms, a
          // focused number field steps. A page that scrolls nothing (a full-screen section slider) gets the wheel.
          const moved = (await page.evaluateHandle(scroller, null)).asElement();
          if (moved) await moved.evaluate((el, dy) => el.scrollBy({ top: dy * el.clientHeight * 0.8, behavior: 'instant' }), direction);
          else {
            await page.mouse.move(width / 2, height / 2);
            await page.mouse.wheel(0, direction * height * 0.8);
          }
          await moved?.dispose();
        } else {
          throw new Error("scroll needs a ref, or text 'up' or 'down'");
        }
        return null;
      }
      case 'back': {
        const from = page.url();
        await back(timeout).catch((e) => {
          if (!(e instanceof errors.TimeoutError && loading(from))) throw e;
        });
        return null;
      }
      case 'navigate': {
        if (!action.text) throw new Error('navigate needs a url');
        let url: URL;
        try {
          url = new URL(action.text, page.url());
        } catch {
          throw new Error('invalid url');
        }
        if (!allows(url.hostname)) throw new Error('host_not_allowed');
        const from = page.url();
        await page.goto(url.href, { timeout, waitUntil: 'domcontentloaded' }).catch((e) => {
          if (!(e instanceof errors.TimeoutError && loading(from))) throw e;
        });
        return null;
      }
      case 'read': {
        const text = await (await locate(ref)).innerText({ timeout });
        return text.length > READ_CHARS ? `${text.slice(0, READ_CHARS)}…` : text;
      }
      case 'wait':
        await sleep(WAIT_MS);
        return null;
      default:
        throw new Error(`unsupported action ${action.type}`);
    }
  }

  return {
    async goto(url) {
      refusals();
      await page.goto(url, { timeout: 30_000, waitUntil: 'domcontentloaded' }).catch((e) => {
        if (!refusals().includes('robots_disallowed')) throw e;
        const { host, pathname } = new URL(url);
        throw new Error(`The robots.txt of ${host} does not let automated visitors open ${pathname} (or could not be read), so Gnomi does not browse it. Choose a start page it allows.`);
      });
      await settle(page);
    },

    async snapshot(): Promise<PageSnapshot> {
      await rememberPasswords();
      const raw = await look();
      seen = still(raw);
      targets = snapshotTargets(raw);
      // Fail closed: a textbox whose type cannot be read is treated as a password.
      const textboxes = [...targets].filter(([, target]) => target.role === 'textbox').map(([ref]) => ref);
      const states = await Promise.all(
        textboxes.map((ref) =>
          page
            .getByRef(ref)
            .evaluate(passwordState, SECRET, { timeout: 1_000 })
            .catch(() => 'hidden' as const),
        ),
      );
      const passwordFields = new Map<string, PasswordState>();
      states.forEach((state, i) => { if (state !== null) passwordFields.set(textboxes[i], state); });
      const ranges = [...targets].filter(([, target]) => RANGES.has(target.role) || target.role === 'textbox').map(([ref]) => ref);
      const read = await Promise.all(ranges.map((ref) => page.getByRef(ref).evaluate(shownValue, null, { timeout: 1_000 }).catch(() => null)));
      const values = new Map(ranges.flatMap((ref, i) => (read[i] === null ? [] : [[ref, read[i]] as const])));
      const kinds = await Promise.all(textboxes.map((ref) => page.getByRef(ref).evaluate(fieldKind, null, { timeout: 1_000 }).catch(() => null)));
      const notes = new Map(textboxes.flatMap((ref, i) => (kinds[i] && TYPED_AS[kinds[i]] ? [[ref, TYPED_AS[kinds[i]]] as const] : [])));
      const { innerHeight: viewportHeight, innerWidth: viewportWidth, viewport } = await page.evaluate(() => {
        const { offsetLeft, offsetTop, width, height } = visualViewport!;
        return { innerHeight, innerWidth, viewport: [offsetLeft, offsetTop, width, height] as Viewport };
      });
      // The browser's bubble over a field it refused, as the persona reads it on the screenshot. Not after a check of the
      // page's own (checkValidity() on typing): only a click or a key can submit.
      const refused = submitting ? (await Promise.all(page.frames().map((frame) => frame.evaluate(() => (window as unknown as { __gnomiInvalid?: string | null }).__gnomiInvalid ?? null).catch(() => null)))).find(Boolean) : null;
      const text = pruneSnapshot(raw, { passwordFields, values, notes, viewportHeight, viewportWidth }) + (refused ? `\n- alert [invalid]: ${refused.slice(0, 200)}` : '');
      shown = text;
      return { url: page.url(), title: await page.title(), text, hash: createHash('sha1').update(text).digest('hex'), viewport };
    },

    async screenshot() {
      await rememberPasswords();
      await page.evaluate((ms) => Promise.race([document.fonts.ready.then(() => true), new Promise((done) => setTimeout(() => done(false), ms))]), FONTS_MS).catch(() => {});
      return page.screenshot({
        type: 'jpeg',
        quality: 70,
        scale: 'css', // one pixel per CSS pixel: a 3x phone would otherwise send nine times the pixels
        mask: page.frames().map((frame) => frame.locator(SECRET)),
        timeout: 10_000,
      });
    },

    async act(action): Promise<ActionOutcome> {
      if (action.type === 'done' || action.type === 'abandon') throw new Error(`programming error: ${action.type} never reaches the page`);
      const ref = action.ref?.trim() || null;
      const url_before = page.url();
      let target = (ref && targets.get(ref)) || null;
      // A person taps a checkbox's label, not its 13 px box or the hidden input under a skin: that is what small_target measures.
      if (target && action.type === 'click' && /^(?:checkbox|radio|switch)$/.test(target.role)) {
        const box = await page.getByRef(ref!).evaluate(labelBox, null, { timeout: 1_000 }).catch(() => null);
        if (box) target = { ...target, box };
      }
      const before = await domVersion(page);
      const looked = seen; // the look the persona acts on: one from before an earlier action is stale
      seen = '';
      const scrolled = action.type === 'scroll' ? await domVersion(page, 's') : '';
      let text: string | null = null;
      let error: string | null = null;
      failedNavigation = null;
      popup = null;
      downloaded = false;
      formClick = false;
      chosen = null;
      inflight.clear();
      started.clear();
      refusals(); // what the page ran into before this action is not its doing
      submitting = action.type === 'click' || action.type === 'press';
      await Promise.all(page.frames().map((frame) => frame.evaluate(() => { (window as unknown as { __gnomiInvalid: string | null }).__gnomiInvalid = null; }).catch(() => {})));
      try {
        text = await perform(action, ref);
      } catch (e) {
        error = e instanceof errors.TimeoutError ? 'timeout' : firstLine(e);
      }
      // Typing's own input events are its echo, not the page reacting to it.
      const echo = action.type === 'type' ? await domVersion(page) : before;
      await settle(page, started);
      // Chromium draws its own calendar, clock or colour panel for a native field: on the screenshot, never in the page, so no tap
      // reaches it, and nothing the page or the driver cancels stops it opening. Escape shuts it, unheard by the page (a dialog
      // around the field stays open); the field's [type the date as …] note says to type the value instead.
      const pickers = await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.querySelector('input:open') !== null).catch(() => false)));
      if (pickers.some(Boolean)) await page.keyboard.press('Escape');
      // A file chooser opens just after the click that opened it returns: its file, and what the page makes of it, are the action's.
      const picked = await (chosen as Promise<string | null> | null)?.catch((e: unknown) => { // set by the filechooser listener while the action ran
        error ??= firstLine(e);
        return null;
      });
      if (picked) {
        text = `File chosen: ${picked}`;
        await settle(page, started);
      }
      const opened = popup as Page | null; // set by the popup listener while the action ran
      // Nothing shown, loading or opened yet: a person keeps looking a moment, for a debounced search or a menu on a timer.
      const unseen = error === null && !opened && ['click', 'hover', 'type', 'press'].includes(action.type) && started.size === 0 && page.url() === url_before;
      if (unseen && (await domVersion(page)) === echo) {
        for (let waited = 0; waited < GLANCE_MS; waited += POLL_MS) {
          await sleep(POLL_MS);
          if ((await domVersion(page)) === echo) continue;
          await settle(page, started);
          break;
        }
      }
      if (opened) {
        // The persona follows a tab the action opened, and the tab it came from stays as it was behind it, form and all, as
        // window.opener expects. Containment checks the load as any other.
        await opened.waitForLoadState('domcontentloaded', { timeout: ACTION_MS }).catch(() => {});
        if (!opened.isClosed()) {
          page = opened;
          await settle(page, started);
        }
      }
      const pending = opened !== null || downloaded || inflight.size > 0;
      const outside = refusedByContainment();
      // Observe-only: a page load or form post, or a page robots.txt disallows, stopped before the network. A script's write
      // counts only after a click inside a form: otherwise it is the page's own background traffic (analytics), not the persona's.
      const observed = refusals().map((r) => (r !== 'write_blocked' ? r : formClick ? 'submit_blocked' : null)).find((r) => r !== null) ?? null;
      if (outside || (observed && page.url().startsWith('chrome-error://'))) {
        // The persona should hear "that leads outside the product" and still be on the page it was on, not on a browser error page.
        await back(ACTION_MS).catch(() => null);
        await settle(page, started);
      }
      if (outside) error = 'host_not_allowed';
      else if (observed) error = observed;
      // A scroll changes no node: whether the page or the list moved is what the persona needs to hear.
      let dom_changed = (await domVersion(page)) !== before || (action.type === 'scroll' && (await domVersion(page, 's')) !== scrolled);
      // Nor does a menu that opens on :hover or :focus-within: a fresh look tells. Last, as hiding for it changes nodes.
      // shortcut: compared with the look before the persona chose, so a CSS-only animation meanwhile (a keyframe carousel) reads as the action's change, upgrade by looking again as act() starts if a target app does this.
      if (!dom_changed && unseen && looked && action.type !== 'type') dom_changed = still(await look().catch(() => looked)) !== looked;
      return { ok: error === null, url_before, url_after: page.url(), dom_changed, error, ...(pending && { pending }), target, text };
    },

    inspect: () => inspect(page),

    errors() {
      const drained = pageErrors;
      pageErrors = [];
      return drained;
    },

    storageState: () => context.storageState({ indexedDB: true }), // as a recorded login: some apps keep their tokens there
    close: () => context.close(),
  };
}
