import type { Browser, BrowserContext } from 'playwright-core';
import type { BrowserPool, LoginRecording } from '../seams.ts';
import { startContainment } from './contain.ts';
import type { Containment } from './contain.ts';
import { inspect } from './inspect.ts';
import { newContext, openPage, settle } from './page.ts';

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200);

/**
 * A browser on `url` for a human to log in (tech.md §9.1). Nothing here reads a form field, a request body or a
 * cookie value: only the hostnames of requests, and cookie expiry times, are looked at.
 */
export async function recordLogin(browser: Browser, url: string): Promise<LoginRecording> {
  // No containment: SSO hops through hosts nobody has listed yet, and the hosts seen are what the allowlist is picked from.
  const context = await browser.newContext({ viewport: null }); // the page follows the window the person resizes
  const hosts = new Set<string>();
  // shortcut: WebSocket hosts are not collected, they show up as blocked requests on the first run.
  context.on('request', (request) => {
    const host = new URL(request.url()).hostname;
    if (host) hosts.add(host);
  });
  const page = await context.newPage();
  // Closing the window ends the recording; without this a window-less browser can linger (macOS keeps Chrome running).
  page.on('close', () => void browser.close().catch(() => {}));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await browser.close();
    throw e;
  }
  return {
    page,
    async finish() {
      try {
        if (page.isClosed() || !browser.isConnected()) throw new Error('The login window was closed before the login was saved. Record it again and keep the window open until you save.');
        const storageState = await context.storageState({ indexedDB: true }); // some apps keep their tokens there
        const expiries = storageState.cookies.map((cookie) => cookie.expires).filter((expires) => expires > 0); // -1 marks a session cookie
        return {
          storageState,
          start_url: page.url(),
          hosts: [...hosts].sort(),
          expires_at: expiries.length ? Math.round(Math.min(...expiries) * 1000) : null,
        };
      } finally {
        await browser.close().catch(() => {});
      }
    },
    cancel: () => browser.close(),
  };
}

export async function checkSession(browser: Browser, opts: Parameters<BrowserPool['checkSession']>[0]): ReturnType<BrowserPool['checkSession']> {
  let context: BrowserContext | undefined;
  let containment: Containment | undefined;
  try {
    containment = await startContainment(opts.allowedHosts, opts.blockedDomains, () => {}); // refused quietly: this is a probe, not a run
    context = await newContext(browser, 'desktop', opts.storageState, containment.proxy);
    await containment.install(context);
    const page = await openPage(context);
    const response = await page.goto(opts.startUrl, { timeout: 30_000, waitUntil: 'domcontentloaded' });
    await settle(page);
    const url = page.url();
    if (response?.status() === 401) return { ok: false, url, reason: 'the start page answered 401' };
    if ((await inspect(page)).login) return { ok: false, url, reason: 'landed on a login page' };
    return { ok: true, url, reason: null };
  } catch (e) {
    return { ok: false, url: opts.startUrl, reason: firstLine(e) };
  } finally {
    containment?.close();
    await context?.close().catch(() => {});
  }
}
