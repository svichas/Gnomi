import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, LaunchOptions } from 'playwright-core';
import type { BrowserPool } from '../seams.ts';
import { startContainment } from './contain.ts';
import { newContext, newPageDriver } from './page.ts';
import { checkSession, recordLogin } from './session.ts';

// Playwright's own Chromium first (undefined channel): a Chrome under an enterprise policy that disables DevTools
// launches fine, then gets killed seconds later. When no Chromium is installed this falls through to Chrome, then Edge.
const CHANNELS = [undefined, 'chrome', 'msedge'];

async function launch(headless: boolean, proxy?: LaunchOptions['proxy']): Promise<Browser> {
  let cause: unknown;
  for (const channel of CHANNELS) {
    try {
      // WebRTC's UDP would go around the containment proxy; this flag sends it through the proxy, which refuses it.
      const args = proxy ? ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : [];
      return await chromium.launch({ headless, channel, proxy, args });
    } catch (e) {
      cause = e;
    }
  }
  throw new Error('Gnomi needs Google Chrome (or Microsoft Edge) to browse. Install Google Chrome and try again.', { cause });
}

export async function launchBrowserPool(opts: { headless?: boolean } = {}): Promise<BrowserPool> {
  // The placeholder proxy tells Playwright every context brings its own (containment), as the docs ask.
  const browser = await launch(opts.headless ?? true, { server: 'http://per-context' });
  return {
    async newPage({ device, locale, timezone, languages, allowedHosts, blockedDomains, storageState, onBlockedRequest, observe }) {
      const containment = await startContainment(allowedHosts, blockedDomains, onBlockedRequest, observe);
      let context: BrowserContext | undefined;
      try {
        context = await newContext(browser, device, storageState, containment.proxy, { locale, timezone, languages });
        await containment.install(context);
        return await newPageDriver(context, containment.allows, containment.refusals);
      } catch (e) {
        containment.close();
        await context?.close().catch(() => {});
        throw e;
      }
    },
    // A browser of its own and no proxy: IdP hosts must be reachable while the person logs in, and their window is not part of any run.
    async record(url, { headless = false } = {}) {
      return recordLogin(await launch(headless), url);
    },
    checkSession: (opts) => checkSession(browser, opts),
    close: () => browser.close(),
  };
}
