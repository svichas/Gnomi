import { looksLikeStaging } from '@gnomi/engine/safety.ts';
import { DEFAULT_SETTINGS } from '@gnomi/engine/settings.ts';
import type { Audience, LlmRole, ProjectConfig, RunSettings, SessionInfo } from '@gnomi/engine/types.ts';
import { audienceProblem, cleanAudience } from './audience.ts';

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

/** What the Project, Settings and Audience tabs edit together: one project, saved as a whole. */
export interface Draft {
  form: Form;
  settings: RunSettings;
  audience: Audience | null; // null runs the single built-in persona
}

export function initialDraft(project: ProjectConfig | null | undefined): Draft {
  // Projects saved before M2 have no settings or audience.
  return { form: initialForm(project), settings: project?.settings ?? DEFAULT_SETTINGS, audience: project?.audience ?? null };
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

export const ROLES: LlmRole[] = ['navigator', 'socialiser', 'persona_writer', 'judge', 'author'];

/** What is wrong with the run settings, as a sentence, or null. */
export function settingsProblem(settings: RunSettings): string | null {
  const { routing, local_base_url, concurrency, cost_budget_usd, wall_clock_budget_min } = settings;
  const endpoint = local_base_url?.trim() ?? '';
  for (const role of ROLES) {
    if (!routing[role].model.trim()) return `Settings: name a model for the ${role.replace('_', ' ')}.`;
    if (routing[role].provider === 'openai_compatible' && !endpoint) return `Settings: the ${role.replace('_', ' ')} uses the local endpoint, so give its address.`;
  }
  if (endpoint && startHost(endpoint) === null) return 'Settings: the local endpoint needs a full web address, such as http://localhost:11434/v1.';
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) return 'Settings: concurrency must be a whole number from 1 to 32.';
  if (!(cost_budget_usd > 0)) return 'Settings: the cost budget must be more than zero.';
  if (!(wall_clock_budget_min > 0)) return 'Settings: the time budget must be more than zero minutes.';
  return null;
}

/** The project as the tabs describe it, or the sentence telling what is missing. */
export function toConfig({ form, settings, audience }: Draft): ProjectConfig | string {
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
  const problem = settingsProblem(settings) ?? (audience && audienceProblem(audience));
  if (problem) return problem;
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
    audience: audience && cleanAudience(audience),
    settings: {
      ...settings,
      local_base_url: settings.local_base_url?.trim() || null,
      routing: Object.fromEntries(ROLES.map((role) => [role, { ...settings.routing[role], model: settings.routing[role].model.trim() }])) as RunSettings['routing'],
    },
  };
}

/** The logins a run needs: each segment's role, or the built-in persona's role when there is no audience. */
export function rolesInUse(config: ProjectConfig): string[] {
  const roles = config.audience ? config.audience.segments.filter((segment) => segment.share > 0).map((segment) => segment.role) : [config.role];
  return [...new Set(roles.filter((role): role is string => role !== null))];
}

/** A problem from `toConfig`, worded for the tab it is shown on: problems from another tab say where to fix them. */
export function problemFor(problem: string, tab: 'project' | 'settings' | 'audience'): string {
  const own = problem.startsWith('Settings: ') ? 'settings' : problem.startsWith('Audience: ') ? 'audience' : 'project';
  if (own === tab) return problem.replace(/^(Settings|Audience): /, '');
  return own === 'project' ? `On the Project tab: ${problem}` : problem;
}

/** Hosts offered as checkboxes: those seen while recording, those already allowed or added by hand; never the start page's own. */
export function offeredHosts(sessions: SessionInfo[], allowed: string[], added: string[], start: string | null): string[] {
  const hosts = [...sessions.flatMap((session) => session.hosts), ...allowed, ...added].map((host) => host.toLowerCase());
  return [...new Set(hosts)].filter((host) => host !== start).sort();
}
