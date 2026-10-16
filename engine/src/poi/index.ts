import { stepBudget, type EpisodeDeps, type EpisodeEnd } from '../agent/loop.ts';
import type { Persona, Poi, PoiType, ProjectConfig } from '../types.ts';
import { design } from './design.ts';
import { poisFor } from './pois.ts';
import { text } from './text.ts';
import { web } from './web.ts';

// One runner per POI type behind one interface (docs/pois.md). The scheduler (run.ts) only ever talks to a POI through it.

export interface PoiRunner<P extends Poi = Poi> {
  /** This POI's step budget from the persona's patience budget (tech.md §6.4): text and static designs need far fewer steps. */
  budget(patienceBudget: number, poi: P): number;
  /** Why a run with this POI must not start, as a sentence for the user (e.g. "needs a vision-capable navigator"), or null. */
  preflight(poi: P, project: ProjectConfig, hasAsset: (id: string) => boolean): string | null;
  /** One persona's episode on this POI; its events carry the POI's id. */
  episode(poi: P, deps: EpisodeDeps): Promise<EpisodeEnd>;
}

export const RUNNERS: { [T in PoiType]: PoiRunner<Extract<Poi, { type: T }>> } = { web, text, design };

export const runnerFor = <P extends Poi>(poi: P): PoiRunner<P> => RUNNERS[poi.type] as unknown as PoiRunner<P>;

/** The step budget of one persona on one POI, at least one step. */
export const poiBudget = (persona: Persona, poi: Poi): number => Math.max(1, Math.round(runnerFor(poi).budget(stepBudget(persona), poi)));

/**
 * Why the project cannot run as it is, or null: no POI, a segment with nothing to look at, or a runner's own refusal.
 * `hasAsset` says whether an asset id is in the project's assets/ folder; without it, missing assets surface when the run reads them.
 */
export function preflight(project: ProjectConfig, hasAsset: (id: string) => boolean = () => true): string | null {
  if (project.pois.length === 0) return 'Add a point of interest for the personas to try.';
  const idle = project.audience?.segments.find((segment) => segment.share > 0 && poisFor(project.pois, segment).length === 0);
  if (idle) return `No point of interest is open to the "${idle.name}" segment. Choose one for it, or give the segment no share.`;
  for (const poi of project.pois) {
    const refusal = runnerFor(poi).preflight(poi, project, hasAsset);
    if (refusal) return refusal;
  }
  return null;
}
