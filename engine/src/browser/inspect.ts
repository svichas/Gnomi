import type { Page } from 'playwright-core';
import type { PageFlags } from '../types.ts';

const LOGIN_PATH = /(log-?in|sign-?in|sso|auth|oauth)/i;
// First match wins. Cloudflare's interstitial is also recognised by its title.
// shortcut: reCAPTCHA's invisible badge and an invisible-mode `.g-recaptcha` button match too, upgrade to a visible challenge frame if a staging app trips it.
const CHALLENGES: [label: string, selector: string][] = [
  ['recaptcha', '.g-recaptcha, iframe[src*="recaptcha"]'],
  ['hcaptcha', '.h-captcha, iframe[src*="hcaptcha"]'],
  ['turnstile', '.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'],
  ['cloudflare', '#challenge-form'],
];
const CLOUDFLARE_TITLES = ['Just a moment...', 'Attention Required! | Cloudflare'];
// shortcut: Stripe only, and only keys written into the page's own HTML (not external bundles); add providers when a team needs them.
const LIVE_KEYS = ['pk_live_', 'sk_live_', 'rk_live_'];
const SCAN_CHARS = 2_000_000;

/** Login-page, bot-challenge and live-key checks on the page as it is now (tech.md §9.1, §9.3). */
export async function inspect(page: Page): Promise<PageFlags> {
  const [passwordFields, found] = await Promise.all([
    Promise.all(page.frames().map((frame) => frame.locator('input[type="password" i]:visible').count().catch(() => 0))),
    // Scanned in the page, so megabytes of HTML never cross the wire. Only the prefix is returned, never the key.
    page.evaluate(
      ({ challenges, titles, keys, cap }) => {
        const html = (document.documentElement?.outerHTML ?? '').slice(0, cap);
        return {
          challenge: challenges.find(([, selector]) => document.querySelector(selector))?.[0] ?? (titles.includes(document.title.trim()) ? 'cloudflare' : null),
          live_key: keys.find((key) => html.includes(key)) ?? null,
        };
      },
      { challenges: CHALLENGES, titles: CLOUDFLARE_TITLES, keys: LIVE_KEYS, cap: SCAN_CHARS },
    ),
  ]);
  return { login: LOGIN_PATH.test(new URL(page.url()).pathname) || passwordFields.some((count) => count > 0), ...found };
}
