import type { DesignPoi } from '@gnomi/simulation/types.ts';
import type { PoiKind } from './index.ts';

/** File types a frame can be, as import_asset takes them (simulation/src/assets.ts). */
export const FRAME_TYPES = '.png,.jpg,.jpeg,.webp';

// The draft is the POI as saved: frames in order, each an asset id and an optional step name.
export const design: PoiKind<DesignPoi, DesignPoi> = {
  label: 'Design',
  blank: (id) => ({ id, type: 'design', name: '', segments: null, frames: [] }),
  draft: (poi) => poi,
  toPoi: (draft) =>
    draft.frames.length === 0
      ? 'Add at least one frame to the design.'
      : { ...draft, name: draft.name.trim() || 'Design', frames: draft.frames.map(({ asset, name }) => ({ asset, name: name?.trim() || null })) },
  title: (draft) => draft.name.trim(),
};
