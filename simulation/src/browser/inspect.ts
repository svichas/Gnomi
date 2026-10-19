import type { Page } from 'playwright-core';
import type { PageFlags } from '../types.ts';

// Whole path segments only, so /authors or /blog/signing-tips are not login pages.
const LOGIN_PATH = /(?:^|\/)(?:log[-_]?in|sign[-_]?in|sso|auth|oauth2?)(?:[/.]|$)/i;
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
  const [loginForms, found] = await Promise.all([
    // A lone password field that is not for a new password: two side by side, or new-password, set or change one.
    Promise.all(page.frames().map((frame) => frame.locator('input[type="password" i]:visible').evaluateAll((inputs) => inputs.length === 1 && !/\bnew-password\b/i.test(inputs[0].getAttribute('autocomplete') ?? '')).catch(() => false))),
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
  return { login: LOGIN_PATH.test(new URL(page.url()).pathname) || loginForms.some(Boolean), ...found };
}
