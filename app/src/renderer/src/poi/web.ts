import type { SessionInfo, WebPoi } from '@gnomi/simulation/types.ts';
import type { PoiKind } from './index.ts';

// A web app's fields as the Project screen edits them, and the rules that turn them into a WebPoi. No React, so tests run it.

export interface WebDraft {
  id: string;
  type: 'web';
  name: string; // empty: named after the start page's host
  segments: string[] | null;
  mode: WebPoi['mode'];
  url: string;
  production: string; // production domains as typed, comma-separated
  reset: string;
  allowed: string[];
}

/** The hostname of a web address, or null when it is not an http(s) address. */
export function startHost(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null;
  } catch {
    return null;
  }
}

/** A hostname from what people paste: a bare host, a host with a port, or a whole address. */
export function hostOf(text: string): string | null {
  const host = text
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '');
  // shortcut: IPv6 literals are not accepted; allow them when a team asks to test against one
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) ? host : null;
}

function hostList(text: string): string[] | string {
  const hosts: string[] = [];
  for (const entry of text.split(',').filter((part) => part.trim())) {
    const host = hostOf(entry);
    if (host === null) return `"${entry.trim()}" is not a domain name. List domains such as acme.com, separated by commas.`;
    hosts.push(host);
  }
  return [...new Set(hosts)];
}

/** Hosts offered as checkboxes: those seen while recording, those already allowed or added by hand; never the start page's own. */
export function offeredHosts(sessions: SessionInfo[], allowed: string[], added: string[], start: string | null): string[] {
  const hosts = [...sessions.flatMap((session) => session.hosts), ...allowed, ...added].map((host) => host.toLowerCase());
  return [...new Set(hosts)].filter((host) => host !== start).sort();
}

export const web: PoiKind<WebDraft, WebPoi> = {
  label: 'Web app',
  blank: (id) => ({ id, type: 'web', name: '', segments: null, mode: 'full', url: '', production: '', reset: '', allowed: [] }),
  draft: (poi) => ({
    id: poi.id,
    type: 'web',
    // A name that is just the host follows the start page, as it did before POIs had names.
    name: poi.name === startHost(poi.start_url) ? '' : poi.name,
    segments: poi.segments,
    mode: poi.mode,
    url: poi.start_url,
    production: poi.production_domains.join(', '),
    reset: poi.reset_hook_url ?? '',
    allowed: poi.allowed_hosts,
  }),
  toPoi(draft) {
    const url = draft.url.trim();
    const reset = draft.reset.trim();
    const host = startHost(url);
    if (host === null) return 'The start page needs a full web address, such as https://staging.example.com.';
    const full = draft.mode === 'full';
    const production = hostList(draft.production);
    if (typeof production === 'string') return production;
    if (full && reset && startHost(reset) === null) return 'The reset hook needs a full web address, or leave it empty.';
    return {
      id: draft.id,
      type: 'web',
      name: draft.name.trim() || host,
      mode: draft.mode,
      segments: draft.segments,
      start_url: url,
      allowed_hosts: [...new Set(draft.allowed)].filter((allowed) => allowed !== host),
      production_domains: production,
      reset_hook_url: (full && reset) || null,
    };
  },
  title: (draft) => draft.name.trim() || startHost(draft.url) || '',
};
