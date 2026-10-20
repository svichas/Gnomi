import type { WebPoi } from './types.ts';

// Pure (no Node imports): the engine, the CLI and the tests share these rules.

const bare = (hostname: string) => hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

/** The production domain this host is, or is a subdomain of, if any. */
export function productionDomain(hostname: string, domains: string[]): string | null {
  const host = bare(hostname);
  return domains.map((d) => bare(d).replace(/^\*?\./, '')).find((d) => d && (host === d || host.endsWith(`.${d}`))) ?? null;
}

/**
 * Why a run must not start against this POI, or null when it may: the production-domain guard of tech.md §9.3. An observe-only
 * POI (a competitor's site) may be production, since containment lets nothing but reads through, but it never gets a reset hook.
 */
export function checkTarget(poi: WebPoi): string | null {
  const start = URL.parse(poi.start_url);
  if (!start || !/^https?:$/.test(start.protocol)) return `The start page "${poi.start_url}" is not a web address Gnomi can open. Use one that starts with http:// or https://.`;
  const production = productionDomain(start.hostname, poi.production_domains);
  if (production) return `${start.hostname} is on ${production}, which this project lists as production. Gnomi never runs against production: point the project at your staging site.`;
  if (poi.mode === 'observe_only') return poi.reset_hook_url === null ? null : `"${poi.name}" is observed only, so Gnomi never calls a reset hook on it. Remove its reset hook.`;
  if (poi.reset_hook_url !== null) {
    const hook = URL.parse(poi.reset_hook_url);
    const hosts = allowedHosts(poi);
    if (!hook || !/^https?:$/.test(hook.protocol) || !hosts.includes(hook.hostname) || productionDomain(hook.hostname, poi.production_domains))
      return `The reset hook "${poi.reset_hook_url}" must be an http(s) address on one of this project's allowed hosts (${hosts.join(', ')}).`;
  }
  return null;
}

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$/; // a dotted name, never an IP address or localhost

/** acme.com for www.acme.com and the other way round: sites redirect between the two, so a start page on one needs the other. */
export function wwwTwin(hostname: string): string[] {
  const twin = hostname.startsWith('www.') ? hostname.slice(4) : `www.${hostname}`;
  return DOMAIN.test(hostname) && DOMAIN.test(twin) ? [twin] : [];
}

/** start_url's host and its www twin first, then the POI's allowed hosts, lower-cased and de-duplicated. */
export function allowedHosts(poi: WebPoi): string[] {
  const start = URL.parse(poi.start_url)?.hostname;
  return [...new Set([...(start ? [start, ...wwwTwin(start)] : []), ...poi.allowed_hosts.map((h) => h.trim().toLowerCase()).filter(Boolean)])];
}
