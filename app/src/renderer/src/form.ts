import { looksLikeStaging } from '@gnomi/engine/safety.ts';
import type { ProjectConfig, SessionInfo } from '@gnomi/engine/types.ts';

// The Project screen's form and its rules, kept free of React so they can be tested on their own.

export interface Form {
  name: string;
  description: string;
  url: string;
  goal: string;
  /** The host the user confirmed is not production; the confirmation lapses when the start page's host changes. */
  confirmedHost: string | null;
  production: string; // production domains as typed, comma-separated
  reset: string;
  allowed: string[];
  role: string | null; // null browses logged out
}

export function initialForm(project: ProjectConfig | null | undefined): Form {
  const poi = project?.poi;
  // Projects saved before M1 lack the newer fields.
  return {
    name: project?.name ?? '',
    description: project?.description ?? '',
    url: poi?.start_url ?? '',
    goal: project?.goal ?? '',
    confirmedHost: poi?.not_production ? startHost(poi.start_url) : null,
    production: (poi?.production_domains ?? []).join(', '),
    reset: poi?.reset_hook_url ?? '',
    allowed: poi?.allowed_hosts ?? [],
    role: project?.role ?? null,
  };
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

/** The start page's host when it has no staging marker, so the user has to confirm it is not production. */
export function hostToConfirm(url: string): string | null {
  const host = startHost(url);
  return host !== null && !looksLikeStaging(host) ? host : null;
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

/** The project as the form describes it, or the sentence telling what is missing. */
export function toConfig(form: Form): ProjectConfig | string {
  const name = form.name.trim();
  const goal = form.goal.trim();
  const url = form.url.trim();
  const reset = form.reset.trim();
  if (!name) return 'Give the project a name.';
  const host = startHost(url);
  if (host === null) return 'The start page needs a full web address, such as https://staging.example.com.';
  const confirm = hostToConfirm(url);
  if (confirm !== null && form.confirmedHost !== confirm) return 'Confirm that this is not a production site.';
  if (!goal) return 'Say what the persona should try to do.';
  const production = hostList(form.production);
  if (typeof production === 'string') return production;
  if (reset && startHost(reset) === null) return 'The reset hook needs a full web address, or leave it empty.';
  // shortcut: one web POI with a fixed id; add a POI list when a project needs several
  return {
    name,
    description: form.description.trim(),
    goal,
    role: form.role,
    poi: {
      id: 'poi-1',
      type: 'web',
      name: host,
      start_url: url,
      allowed_hosts: [...new Set(form.allowed)].filter((allowed) => allowed !== host),
      production_domains: production,
      not_production: confirm !== null,
      reset_hook_url: reset || null,
    },
  };
}

/** Hosts offered as checkboxes: those seen while recording, those already allowed or added by hand; never the start page's own. */
export function offeredHosts(sessions: SessionInfo[], allowed: string[], added: string[], start: string | null): string[] {
  const hosts = [...sessions.flatMap((session) => session.hosts), ...allowed, ...added].map((host) => host.toLowerCase());
  return [...new Set(hosts)].filter((host) => host !== start).sort();
}
