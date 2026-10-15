import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { devices, errors } from 'playwright-core';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright-core';
import type { PageDriver, StorageState } from '../seams.ts';
import type { Action, ActionOutcome, ActionTarget, Device, PageSnapshot } from '../types.ts';
import type { Containment, HostRule } from './contain.ts';
import { personaEnvironment, type LocaleEnvironment } from '../audience/locations.ts';
import { inspect } from './inspect.ts';
import { pruneSnapshot, snapshotTargets } from './prune.ts';

const ACTION_MS = 5_000;
const SETTLE_MS = 3_000; // cap on waiting for the page to go quiet after an action
const QUIET_MS = 250; // no DOM mutation for this long counts as settled
const WAIT_MS = 1_000;
const READ_CHARS = 2_000;
// Password inputs, including one a "show password" toggle turned into type=text.
const SECRET = 'input[type="password" i], input[autocomplete*="password" i]';
// Model-supplied: reject anything that is not a ref before it reaches Playwright's selector engine.
const REF = /^(?:f\d+)?e\d+$/;

// Runs in the page. fill() also fills the control of an enclosing <label>, so that control counts too.
const isSecret = (el: Element, selector: string) => el.matches(selector) || !!el.closest('label')?.control?.matches(selector);

// Runs in every frame before page scripts: counts DOM mutations so act() can tell whether anything changed.
// Playwright ships both this and isSecret to the page with toString(), so they must stay self-contained.
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
  // shortcut: a tab a click opens (target=_blank) is ignored, upgrade when a persona has to follow one.
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
  // shortcut: a response slower than QUIET_MS reads as "nothing happened", upgrade to wait on in-flight requests if that fakes dead-click signals.
  let last = await domVersion(page);
  while (Date.now() < deadline) {
    await sleep(QUIET_MS);
    const now = await domVersion(page);
    if (now === last) return;
    last = now;
  }
}

export async function newPageDriver(context: BrowserContext, allows: HostRule): Promise<PageDriver> {
  const page = await openPage(context);
  let targets = new Map<string, ActionTarget>();
  let failedNavigation: string | null = null; // the last main-frame page load that did not complete
  page.on('requestfailed', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) failedNavigation = request.url();
  });

  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  };
  /** True when the page load that just happened was refused by containment (a failed load or a refusal page on an unlisted host). */
  const refusedByContainment = () => {
    const url = page.url();
    if (url.startsWith('chrome-error://')) return failedNavigation !== null && !allows(hostOf(failedNavigation)); // a dead listed host is the product's fault, not ours
    return /^https?:/.test(url) && !allows(hostOf(url));
  };

  async function locate(ref: string | null) {
    if (!ref) throw new Error('missing ref');
    const locator = page.getByRef(ref);
    if (!REF.test(ref) || (await locator.count().catch(() => 0)) === 0) throw new Error('ref_not_found');
    return locator;
  }

  /** Performs the action; resolves to the text of a `read`, else null. Model mistakes throw an Error whose message is the code. */
  async function perform(action: Action, ref: string | null): Promise<string | null> {
    const timeout = ACTION_MS;
    switch (action.type) {
      case 'click':
        await (await locate(ref)).click({ timeout });
        return null;
      case 'type': {
        const input = await locate(ref);
        if (action.text === null) throw new Error('type needs text');
        if (await input.evaluate(isSecret, SECRET, { timeout }).catch(() => true)) throw new Error('password_field');
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
          throw e instanceof errors.TimeoutError ? new Error('option_not_found') : e;
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
      await page.goto(url, { timeout: 30_000, waitUntil: 'domcontentloaded' });
      await settle(page);
    },

    async snapshot(): Promise<PageSnapshot> {
      const raw = await page.ariaSnapshot({ mode: 'ai', boxes: true, timeout: 10_000 });
      targets = snapshotTargets(raw);
      // Fail closed: a textbox whose type cannot be read is treated as a password.
      const textboxes = [...targets].filter(([, target]) => target.role === 'textbox').map(([ref]) => ref);
      const secret = await Promise.all(
        textboxes.map((ref) =>
          page
            .getByRef(ref)
            .evaluate(isSecret, SECRET, { timeout: 1_000 })
            .catch(() => true),
        ),
      );
      const viewportHeight = await page.evaluate(() => window.innerHeight);
      const text = pruneSnapshot(raw, { passwordRefs: new Set(textboxes.filter((_, i) => secret[i])), viewportHeight });
      return { url: page.url(), title: await page.title(), text, hash: createHash('sha1').update(text).digest('hex') };
    },

    screenshot() {
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
      try {
        text = await perform(action, ref);
      } catch (e) {
        error = e instanceof errors.TimeoutError ? 'timeout' : (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200);
      }
      await settle(page);
      if (refusedByContainment()) {
        // The persona should hear "that leads outside the product" and still be on the page it was on, not on a browser error page.
        await page.goBack({ timeout: ACTION_MS, waitUntil: 'domcontentloaded' }).catch(() => null);
        await settle(page);
        error = 'host_not_allowed';
      }
      const dom_changed = (await domVersion(page)) !== before;
      return { ok: error === null, url_before, url_after: page.url(), dom_changed, error, target: (ref && targets.get(ref)) || null, text };
    },

    inspect: () => inspect(page),

    close: () => context.close(),
  };
}
