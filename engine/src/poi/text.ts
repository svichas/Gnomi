import type { TextPoi } from '../types.ts';
import type { PoiRunner } from './index.ts';

// shortcut: a registered stub that refuses to run; the text POI session replaces this file (docs/pois.md).
export const text: PoiRunner<TextPoi> = {
  budget: (patienceBudget) => Math.ceil(patienceBudget / 10),
  preflight: (poi) => `"${poi.name}" is a text, and text points of interest are not available yet. Remove it to run.`,
  episode: () => Promise.reject(new Error('Text points of interest are not available yet.')),
};
