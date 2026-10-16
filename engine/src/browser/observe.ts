import { setTimeout as sleep } from 'node:timers/promises';
import type { PageOptions } from '../seams.ts';
import { wwwTwin } from '../safety.ts';
import type { WebPoi } from '../types.ts';

// Observe-only browsing (tech.md §7 "Competitor site", §9.3): the pacing and the robots.txt rules containment enforces.

/** One page load per two seconds per browser context (tech.md §7). */
export const OBSERVE_INTERVAL_MS = 2_000;

/** The product token a robots.txt group can name; without such a group the `*` group applies. */
export const ROBOTS_AGENT = 'gnomi';

/** Spaces calls `interval` ms apart in call order: each resolves when its turn comes. */
export function rateLimiter(interval: number, now: () => number = Date.now, wait: (ms: number) => Promise<unknown> = sleep): () => Promise<void> {
  let next = -Infinity;
  return async () => {
    const t = now();
    const at = Math.max(t, next);
    next = at + interval;
    if (at > t) await wait(at - t);
  };
}

export type RobotsRule = { allow: boolean; pattern: string };

/** The rules for Gnomi in a robots.txt (RFC 9309 §2.1–2.2): every group naming gnomi, else every group for `*`, else none. */
export function parseRobots(text: string, agent = ROBOTS_AGENT): RobotsRule[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let open = false; // the current group still takes user-agent lines
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!open) groups.push({ agents: [], rules: [] });
      groups.at(-1)!.agents.push(value.split('/')[0].trim().toLowerCase());
      open = true;
      continue;
    }
    open = false;
    // An empty disallow allows everything, so it adds no rule.
    if ((key === 'allow' || key === 'disallow') && value && groups.length) groups.at(-1)!.rules.push({ allow: key === 'allow', pattern: value });
  }
  const named = groups.filter((g) => g.agents.includes(agent));
  return (named.length ? named : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
}

// `*` matches any run of characters and a final `$` anchors the end (RFC 9309 §2.2.3).
// shortcut: patterns and paths are compared as written, without percent-encoding normalisation; add it if a site's rules use raw UTF-8.
const matcher = (pattern: string) =>
  new RegExp(`^${pattern.replace(/\$$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}${pattern.endsWith('$') ? '$' : ''}`);

/** Whether a path (with its query) may be fetched: the longest matching rule decides, allow winning a tie; no match allows it. */
export function robotsAllows(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!matcher(rule.pattern).test(path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best?.allow ?? true;
}

const KEEP_OUT: RobotsRule[] = [{ allow: false, pattern: '/' }];

/**
 * The start host's robots.txt as a navigation rule (RFC 9309 §2.3): a 2xx is parsed, a 4xx means no rules, and a 5xx or no answer
 * keeps Gnomi off the whole origin. Other hosts the POI allows are not checked.
 */
export async function fetchRobots(startUrl: string, signal?: AbortSignal): Promise<NonNullable<PageOptions['observe']>['robots']> {
  const start = new URL(startUrl);
  let rules = KEEP_OUT;
  try {
    const timeout = AbortSignal.timeout(10_000);
    const res = await fetch(new URL('/robots.txt', start), { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (res.ok) rules = parseRobots((await res.text()).slice(0, 500_000)); // RFC 9309 §2.5: at least 500 KiB is read
    else if (res.status >= 400 && res.status < 500) rules = [];
    else await res.body?.cancel();
  } catch {
    signal?.throwIfAborted();
  }
  // robots.txt is per origin (§2.3); the www twin shares it, since fetch() followed any redirect between the two.
  const origins = [start.origin, ...wwwTwin(start.hostname).map((host) => start.origin.replace(start.hostname, host))];
  return (url) => !origins.includes(url.origin) || robotsAllows(rules, url.pathname + url.search);
}

/** Per run: an observe-only POI's containment options, robots.txt fetched once per POI; undefined for a POI in full mode. */
export function observeOptions(signal: AbortSignal): (poi: WebPoi) => Promise<PageOptions['observe']> {
  const robots = new Map<string, ReturnType<typeof fetchRobots>>();
  return async (poi) => {
    if (poi.mode !== 'observe_only') return undefined;
    if (!robots.has(poi.id)) robots.set(poi.id, fetchRobots(poi.start_url, signal));
    return { robots: await robots.get(poi.id)! };
  };
}
