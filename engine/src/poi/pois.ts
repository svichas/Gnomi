import type { Poi, ProjectConfig, Segment, WebPoi } from '../types.ts';

// Pure (no Node imports): the renderer uses these for the Project screen and to read old runs.

type LegacyWebPoi = Omit<WebPoi, 'mode' | 'segments' | 'allowed_hosts' | 'production_domains' | 'not_production' | 'reset_hook_url'> &
  Partial<WebPoi>;

type Saved = { pois?: Poi[]; poi?: LegacyWebPoi };
/** A project as saved by any version: one `poi` before M5, before M1 without the containment fields. */
export type SavedProject = Omit<ProjectConfig, 'pois'> & Saved;

/** Reads a project or run snapshot of any version as one with `pois`: the old single POI becomes the only one, in full mode, for every segment. */
export function withPois<T extends Saved>(project: T): Omit<T, 'poi' | 'pois'> & Pick<ProjectConfig, 'pois'> {
  const { poi, pois, ...rest } = project;
  const migrated: Poi[] = pois ?? (poi ? [{
    ...poi,
    mode: poi.mode ?? 'full',
    segments: poi.segments ?? null,
    allowed_hosts: poi.allowed_hosts ?? [],
    production_domains: poi.production_domains ?? [],
    not_production: poi.not_production ?? false,
    reset_hook_url: poi.reset_hook_url ?? null,
  }] : []);
  return { ...rest, pois: migrated };
}

/**
 * Whether a segment's personas engage with this POI (tech.md §7). An explicit list wins; otherwise users see every POI and
 * buyers, who only perceive, see text and designs but not web apps. The built-in persona of a project without an audience sees all.
 */
export function isEligible(poi: Poi, segment: Segment | null): boolean {
  if (segment === null) return true;
  if (poi.segments !== null) return poi.segments.includes(segment.id);
  return (segment.kind ?? 'user') === 'user' || poi.type !== 'web';
}

/** The POIs a segment's personas use, in the project's order. */
export const poisFor = (pois: Poi[], segment: Segment | null): Poi[] => pois.filter((poi) => isEligible(poi, segment));

export const webPois = (pois: Poi[]): WebPoi[] => pois.filter((poi): poi is WebPoi => poi.type === 'web');

/** Whether a segment's personas open a browser at all: texts and designs are read from their files, never browsed. */
export const browses = (pois: Poi[], segment: Segment | null): boolean => webPois(poisFor(pois, segment)).length > 0;

/** Whether a segment's personas need their login: only a web POI in full mode loads a recorded session. */
export const logsIn = (pois: Poi[], segment: Segment | null): boolean => webPois(poisFor(pois, segment)).some((poi) => poi.mode === 'full');

/** The web POI a login is recorded on and whose start page a recorded session replaces: the first one in full mode. */
export const loginPoi = (pois: Poi[]): WebPoi | null => webPois(pois).find((poi) => poi.mode === 'full') ?? null;
