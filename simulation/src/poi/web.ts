import { runEpisode } from '../agent/loop.ts';
import { checkTarget } from '../safety.ts';
import type { WebPoi } from '../types.ts';
import type { PoiRunner } from './index.ts';

/**
 * A web app browsed in a contained browser (tech.md §6.2, §6.3): the patience budget as it is, and never against production.
 * An observe-only POI (a competitor's site) is browsed logged out, so a login page there is just a page, not an expired session.
 */
export const web: PoiRunner<WebPoi> = {
  budget: (patienceBudget) => patienceBudget,
  preflight: (poi) => checkTarget(poi),
  episode: (poi, deps) => runEpisode(poi, poi.mode === 'full' ? deps : { ...deps, session: null }),
};
