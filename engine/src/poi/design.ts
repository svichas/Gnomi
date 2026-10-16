import type { DesignPoi } from '../types.ts';
import type { PoiRunner } from './index.ts';

// shortcut: a registered stub that refuses to run; the static-design POI session replaces this file (docs/pois.md).
export const design: PoiRunner<DesignPoi> = {
  budget: (patienceBudget, poi) => Math.min(patienceBudget, 2 * Math.max(1, poi.frames.length)),
  preflight: (poi) => `"${poi.name}" is a design, and design points of interest are not available yet. Remove it to run.`,
  episode: () => Promise.reject(new Error('Design points of interest are not available yet.')),
};
