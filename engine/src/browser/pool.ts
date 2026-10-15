import { chromium, devices } from 'playwright-core';
import type { Browser } from 'playwright-core';
import type { BrowserPool } from '../seams.ts';
import { newPageDriver } from './page.ts';

// Playwright's own Chromium first (undefined channel): a Chrome under an enterprise policy that disables DevTools
// launches fine, then gets killed seconds later. When no Chromium is installed this falls through to Chrome, then Edge.
const CHANNELS = [undefined, 'chrome', 'msedge'];

async function launch(headless: boolean): Promise<Browser> {
  let cause: unknown;
  for (const channel of CHANNELS) {
    try {
      return await chromium.launch({ headless, channel });
    } catch (e) {
      cause = e;
    }
  }
  throw new Error('Gnomi needs Google Chrome (or Microsoft Edge) to browse. Install Google Chrome and try again.', { cause });
}

export async function launchBrowserPool(opts: { headless?: boolean } = {}): Promise<BrowserPool> {
  const browser = await launch(opts.headless ?? true);
  return {
    async newPage({ device, origin }) {
      const context = await browser.newContext({
        ...(device === 'mobile' ? devices['iPhone 15'] : { viewport: { width: 1280, height: 800 } }),
        serviceWorkers: 'block', // they would otherwise bypass request routing (tech.md §9.3)
      });
      return newPageDriver(context, origin);
    },
    close: () => browser.close(),
  };
}
