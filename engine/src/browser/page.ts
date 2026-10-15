import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { errors } from 'playwright-core';
import type { BrowserContext } from 'playwright-core';
import type { PageDriver } from '../seams.ts';
import type { Action, ActionOutcome, ActionTarget, PageSnapshot } from '../types.ts';
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

export async function newPageDriver(context: BrowserContext, origin: string): Promise<PageDriver> {
  const allowed = new URL(origin).origin;
  await context.addInitScript(countMutations);
  const page = await context.newPage();
  // shortcut: a tab a click opens (target=_blank) is ignored, upgrade when a persona has to follow one.
  let targets = new Map<string, ActionTarget>();

  // One string per frame (document id + mutation count): differs after any DOM change or navigation.
  const domVersion = async () =>
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

  async function settle() {
    const deadline = Date.now() + SETTLE_MS;
    await page.waitForLoadState('load', { timeout: SETTLE_MS }).catch(() => {});
    // shortcut: a response slower than QUIET_MS reads as "nothing happened", upgrade to wait on in-flight requests if that fakes dead-click signals.
    let last = await domVersion();
    while (Date.now() < deadline) {
      await sleep(QUIET_MS);
      const now = await domVersion();
      if (now === last) return;
      last = now;
    }
  }

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
          url = new URL(action.text, allowed);
        } catch {
          throw new Error('invalid url');
        }
        if (url.origin !== allowed) throw new Error('host_not_allowed');
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
      await settle();
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
      const before = await domVersion();
      let text: string | null = null;
      let error: string | null = null;
      try {
        text = await perform(action, ref);
      } catch (e) {
        error = e instanceof errors.TimeoutError ? 'timeout' : (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200);
      }
      await settle();
      const dom_changed = (await domVersion()) !== before;
      return { ok: error === null, url_before, url_after: page.url(), dom_changed, error, target: (ref && targets.get(ref)) || null, text };
    },

    close: () => context.close(),
  };
}
