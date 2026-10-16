import type { DesignPoi } from '@gnomi/engine/types.ts';
import type { PoiKind } from './index.ts';

// shortcut: a placeholder the static-design POI session replaces with its own draft and checks; the draft is the POI as saved.
export const design: PoiKind<DesignPoi, DesignPoi> = {
  label: 'Design',
  blank: (id) => ({ id, type: 'design', name: '', segments: null, frames: [] }),
  draft: (poi) => poi,
  toPoi: (draft) => ({ ...draft, name: draft.name.trim() || 'Design' }),
  title: (draft) => draft.name.trim(),
};
