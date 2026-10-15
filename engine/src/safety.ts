import type { WebPoi } from './types.ts';

// Pure (no Node imports): the renderer imports looksLikeStaging for the Project screen's warning.

const MARKERS = new Set(['staging', 'stage', 'test', 'dev', 'qa', 'sandbox', 'preview', 'local', 'localhost']);

const bare = (hostname: string) => hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

function isPrivateAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (v4.slice(1).some((octet) => Number(octet) > 255)) return false;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  // IPv6 loopback, unique-local fc00::/7 and link-local fe80::/10.
  return host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}

/** True when the hostname carries a staging marker or is a loopback or private address (tech.md §9.3). */
export function looksLikeStaging(hostname: string): boolean {
  const host = bare(hostname);
  // Whole tokens only, so devtools.com or latest.io are not mistaken for staging.
  return isPrivateAddress(host) || host.split(/[.-]/).some((token) => MARKERS.has(token));
}

/** The production domain this host is, or is a subdomain of, if any. */
export function productionDomain(hostname: string, domains: string[]): string | null {
  const host = bare(hostname);
  return domains.map((d) => bare(d).replace(/^\*?\./, '')).find((d) => d && (host === d || host.endsWith(`.${d}`))) ?? null;
}

/** Why a run must not start against this POI, or null when it may: the production guard of tech.md §9.3. */
export function checkTarget(poi: WebPoi): string | null {
  const start = URL.parse(poi.start_url);
  if (!start || !/^https?:$/.test(start.protocol)) return `The start page "${poi.start_url}" is not a web address Gnomi can open. Use one that starts with http:// or https://.`;
  const production = productionDomain(start.hostname, poi.production_domains);
  if (production) return `${start.hostname} is on ${production}, which this project lists as production. Gnomi never runs against production: point the project at your staging site.`;
  if (!looksLikeStaging(start.hostname) && !poi.not_production)
    return `${start.hostname} does not look like a staging or test address. If it is not production, confirm "This is not production" in the project settings; otherwise point the project at your staging site.`;
  if (poi.reset_hook_url !== null) {
    const hook = URL.parse(poi.reset_hook_url);
    const hosts = allowedHosts(poi);
    if (!hook || !/^https?:$/.test(hook.protocol) || !hosts.includes(hook.hostname) || productionDomain(hook.hostname, poi.production_domains))
      return `The reset hook "${poi.reset_hook_url}" must be an http(s) address on one of this project's allowed hosts (${hosts.join(', ')}).`;
  }
  return null;
}

/** start_url's host first, then the POI's allowed hosts, lower-cased and de-duplicated. */
export function allowedHosts(poi: WebPoi): string[] {
  const start = URL.parse(poi.start_url)?.hostname;
  return [...new Set([...(start ? [start] : []), ...poi.allowed_hosts.map((h) => h.trim().toLowerCase()).filter(Boolean)])];
}
