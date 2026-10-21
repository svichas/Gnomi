import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { devices, errors } from 'playwright-core';
import type { Browser, BrowserContext, BrowserContextOptions, Page, Request } from 'playwright-core';
import type { PageDriver, PageError, StorageState } from '../seams.ts';
import type { Action, ActionOutcome, ActionTarget, Device, PageSnapshot } from '../types.ts';
import type { ActionRefusal, Containment, HostRule } from './contain.ts';
import { personaEnvironment, type LocaleEnvironment } from '../audience/locations.ts';
import { inspect } from './inspect.ts';
import { pruneSnapshot, snapshotTargets, type PasswordState } from './prune.ts';

const ACTION_MS = 5_000;
const SETTLE_MS = 3_000; // cap on waiting for the page to go quiet after an action
const QUIET_MS = 250; // no DOM mutation for this long counts as settled
const WAIT_MS = 1_000;
const READ_CHARS = 2_000;
const MAX_ERRORS = 20;
const ERROR_RESOURCES = new Set(['document', 'xhr', 'fetch']);
// Remember recognised password inputs even after a reveal toggle changes their type.
const PASSWORD = 'input[type="password" i], input[autocomplete*="password" i]';
const SECRET = `${PASSWORD}, input[data-gnomi-password]`;
// Model-supplied: reject anything that is not a ref before it reaches Playwright's selector engine.
const REF = /^(?:f\d+)?e\d+$/;

/** An error's first line, at most 200 characters: what the log keeps of it. */
export const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200);

// Runs in the page: return only presence, never the existing password itself.
function passwordState(el: Element, selector: string): 'empty' | 'filled' | null {
  const control = el.matches(selector) ? el : el.closest('label')?.control;
  return control?.matches(selector) ? ((control as HTMLInputElement).value ? 'filled' : 'empty') : null;
}

// Runs in the page: opacity 0 hides content from people but not from the accessibility tree (a closed custom drop-down
// would read as open), so it is made visibility: hidden for the snapshot, which Playwright does honour, then put back.
// A form field is left alone: a native checkbox or <select> under a custom skin is often transparent on purpose.
function hideTransparent(hide: boolean) {
  const FIELD = 'input:not([type="hidden" i]), select, textarea';
  if (!hide) {
    for (const el of document.querySelectorAll<HTMLElement>('[data-gnomi-visibility]')) {
      const [value, priority] = JSON.parse(el.dataset.gnomiVisibility!);
      el.style.setProperty('visibility', value, priority);
      if (!el.getAttribute('style')) el.removeAttribute('style');
      delete el.dataset.gnomiVisibility;
    }
    return;
  }
  for (const el of document.querySelectorAll<HTMLElement>('body *')) {
    if (getComputedStyle(el).opacity !== '0' || el.matches(FIELD) || el.querySelector(FIELD)) continue;
    el.dataset.gnomiVisibility = JSON.stringify([el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
    el.style.setProperty('visibility', 'hidden', 'important');
  }
}

// Runs in every frame before page scripts: counts DOM mutations so act() can tell whether anything changed.
// Playwright ships both this and passwordState to the page with toString(), so they must stay self-contained.
// shortcut: every mutation counts, so a page that animates always reads as changed and burns the full settle cap, upgrade by ignoring style-only churn if real apps do this.
function countMutations() {
  const state = { id: Math.random().toString(36).slice(2), n: 0 };
  (window as unknown as { __gnomi: typeof state }).__gnomi = state;
  new MutationObserver((records) => {
    state.n += records.length;
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
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
  return context.newPage();
}

// One string per frame (document id + mutation count): differs after any DOM change or navigation.
const domVersion = async (page: Page) =>
  (
    await Promise.all(
      page.frames().map((frame) =>
        frame
          .evaluate(() => {
            const state = (window as unknown as { __gnomi?: { id: string; n: number } }).__gnomi;
            return state ? `${state.id}:${state.n}` : '';
          })
          .catch(() => ''),
      ),
    )
  ).join('|');

export async function settle(page: Page): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  await page.waitForLoadState('load', { timeout: SETTLE_MS }).catch(() => {});
  // A response slower than QUIET_MS can read as "nothing happened"; act() flags the step as pending instead.
  let last = await domVersion(page);
  while (Date.now() < deadline) {
    await sleep(QUIET_MS);
    const now = await domVersion(page);
    if (now === last) return;
    last = now;
  }
}

/** `refusals` drains containment's observe-only refusals (contain.ts), so an action that ran into one fails with it. */
export async function newPageDriver(context: BrowserContext, allows: HostRule, refusals: () => ActionRefusal[] = () => []): Promise<PageDriver> {
  const page = await openPage(context);
  let targets = new Map<string, ActionTarget>();
  let shown = ''; // the snapshot text the persona was last given
  let failedNavigation: string | null = null; // the last main-frame page load that did not complete
  let popup: Page | null = null; // a tab the current action opened
  let formClick = false; // the current action clicked something inside a form
  const inflight = new Set<Request>(); // page loads and script writes the current action started that have not finished
  page.on('popup', (opened) => {
    popup = opened;
  });
  page.on('request', (request) => {
    // A script's GET (analytics, a long poll) is the page's own traffic and would hide a dead click; a write or a load is the action's.
    if (request.resourceType() === 'document' || (request.method() !== 'GET' && ERROR_RESOURCES.has(request.resourceType()))) inflight.add(request);
  });
  page.on('requestfinished', (request) => inflight.delete(request));
  const rememberPasswords = () => Promise.all(page.frames().map((frame) => frame.locator(PASSWORD).evaluateAll((inputs) => {
    for (const input of inputs) if (!input.hasAttribute('data-gnomi-password')) input.setAttribute('data-gnomi-password', '');
  })));
  page.on('requestfailed', (request) => {
    inflight.delete(request);
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) failedNavigation = request.url();
  });

  const hostOf = (url: string) => URL.parse(url)?.hostname ?? '';

  // What went wrong in the page since errors() was last drained (tech.md §8.1), each distinct error once.
  // shortcut: at most MAX_ERRORS per step, so a page that throws on every frame cannot flood the log, upgrade to counts if a report needs them.
  let pageErrors: PageError[] = [];
  const capture = (error: PageError) => {
    const message = firstLine(error.message);
    if (pageErrors.length < MAX_ERRORS && !pageErrors.some((e) => e.kind === error.kind && e.status === error.status && e.message === message)) pageErrors.push({ ...error, message });
  };
  page.on('console', (msg) => {
    // Chromium also logs every failed load as a console error: 4xx/5xx come from 'response' below, and containment's refusals are not the product's.
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource:')) capture({ kind: 'console', status: null, message: msg.text() });
  });
  page.on('pageerror', (error) => capture({ kind: 'exception', status: null, message: error.message }));
  page.on('response', (response) => {
    const request = response.request();
    if (response.status() < 400 || !ERROR_RESOURCES.has(request.resourceType())) return;
    const url = new URL(response.url());
    // The containment proxy answers unlisted hosts with a 403 of its own, so only allowed hosts count.
    if (allows(url.hostname)) capture({ kind: 'http', status: response.status(), message: `${request.method()} ${url.origin}${url.pathname}` }); // no query string: it can carry tokens
  });
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
    if ((await locator.count().catch(() => 0)) === 0) throw new Error('ref_not_found');
    return locator;
  }

  /** Performs the action; resolves to the text of a `read`, else null. Model mistakes throw an Error whose message is the code. */
  async function perform(action: Action, ref: string | null): Promise<string | null> {
    const timeout = ACTION_MS;
    switch (action.type) {
      case 'click': {
        const target = await locate(ref);
        formClick = await target.evaluate((el) => el.closest('form') !== null, null, { timeout }).catch(() => false);
        await target.click({ timeout });
        return null;
      }
      case 'press':
        // Enter submits a search box with no button; Escape closes a dialog. With no ref, the key goes to whatever has focus.
        if (action.text !== 'Enter' && action.text !== 'Escape') throw new Error("press needs text 'Enter' or 'Escape'");
        if (ref) await (await locate(ref)).press(action.text, { timeout });
        else await page.keyboard.press(action.text);
        return null;
      case 'type': {
        const input = await locate(ref);
        if (action.text === null) throw new Error('type needs text');
        if (!(await input.isEditable({ timeout }).catch(() => false))) throw new Error('not_editable'); // false when disabled/readonly, throws on non-form elements
        await input.fill(action.text, { timeout }).catch((e) => {
          throw /cannot be filled|not an <input>/.test(String(e)) ? new Error('not_editable') : e;
        });
        return null;
      }
      case 'select': {
        const select = await locate(ref);
        if (action.text === null) throw new Error('select needs text');
        await select.selectOption({ label: action.text }, { timeout }).catch((e) => {
          if (e instanceof errors.TimeoutError) throw new Error('option_not_found');
          throw /not a <select>/.test(String(e)) ? new Error('not_a_select') : e;
        });
        return null;
      }
      case 'scroll': {
        if (ref) {
          await (await locate(ref)).scrollIntoViewIfNeeded({ timeout });
        } else if (action.text === 'up' || action.text === 'down') {
          // The wheel, like a person: it scrolls whichever container is under the pointer.
          const { width, height } = page.viewportSize()!;
          await page.mouse.move(width / 2, height / 2);
          await page.mouse.wheel(0, (action.text === 'down' ? 1 : -1) * height * 0.8);
        } else {
          throw new Error("scroll needs a ref, or text 'up' or 'down'");
        }
        return null;
      }
      case 'back':
        await page.goBack({ timeout, waitUntil: 'domcontentloaded' });
        return null;
      case 'navigate': {
        if (!action.text) throw new Error('navigate needs a url');
        let url: URL;
        try {
          url = new URL(action.text, page.url());
        } catch {
          throw new Error('invalid url');
        }
        if (!allows(url.hostname)) throw new Error('host_not_allowed');
        await page.goto(url.href, { timeout, waitUntil: 'domcontentloaded' });
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
      const transparent = (hide: boolean) => Promise.all(page.frames().map((frame) => frame.evaluate(hideTransparent, hide).catch(() => {})));
      await transparent(true);
      const raw = await page.ariaSnapshot({ mode: 'ai', boxes: true, timeout: 10_000 }).finally(() => transparent(false));
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
      const viewportHeight = await page.evaluate(() => window.innerHeight);
      const text = pruneSnapshot(raw, { passwordFields, viewportHeight });
      shown = text;
      return { url: page.url(), title: await page.title(), text, hash: createHash('sha1').update(text).digest('hex') };
    },

    async screenshot() {
      await rememberPasswords();
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
      const before = await domVersion(page);
      let text: string | null = null;
      let error: string | null = null;
      failedNavigation = null;
      popup = null;
      formClick = false;
      inflight.clear();
      refusals(); // what the page ran into before this action is not its doing
      try {
        text = await perform(action, ref);
      } catch (e) {
        error = e instanceof errors.TimeoutError ? 'timeout' : firstLine(e);
      }
      await settle(page);
      const opened = popup as Page | null; // set by the popup listener while the action ran
      if (opened) {
        // The persona follows a tab the action opened in the one tab Gnomi drives; containment checks the load as any other.
        await opened.waitForLoadState('domcontentloaded', { timeout: ACTION_MS }).catch(() => {});
        const url = opened.url();
        await opened.close().catch(() => {});
        if (/^https?:/.test(url)) {
          await page.goto(url, { timeout: ACTION_MS, waitUntil: 'domcontentloaded' }).catch(() => {});
          await settle(page);
        }
      }
      const pending = opened !== null || inflight.size > 0;
      const outside = refusedByContainment();
      // Observe-only: a page load or form post, or a page robots.txt disallows, stopped before the network. A script's write
      // counts only after a click inside a form: otherwise it is the page's own background traffic (analytics), not the persona's.
      const observed = refusals().map((r) => (r !== 'write_blocked' ? r : formClick ? 'submit_blocked' : null)).find((r) => r !== null) ?? null;
      if (outside || (observed && page.url().startsWith('chrome-error://'))) {
        // The persona should hear "that leads outside the product" and still be on the page it was on, not on a browser error page.
        await page.goBack({ timeout: ACTION_MS, waitUntil: 'domcontentloaded' }).catch(() => null);
        await settle(page);
      }
      if (outside) error = 'host_not_allowed';
      else if (observed) error = observed;
      const dom_changed = (await domVersion(page)) !== before;
      return { ok: error === null, url_before, url_after: page.url(), dom_changed, error, ...(pending && { pending }), target: (ref && targets.get(ref)) || null, text };
    },

    inspect: () => inspect(page),

    errors() {
      const drained = pageErrors;
      pageErrors = [];
      return drained;
    },

    close: () => context.close(),
  };
}
