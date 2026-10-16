import type { TextPoi } from '@gnomi/engine/types.ts';
import type { PoiKind } from './index.ts';

// shortcut: a placeholder the text POI session replaces with its own draft and checks; the draft is the POI as saved.
export const text: PoiKind<TextPoi, TextPoi> = {
  label: 'Text',
  blank: (id) => ({ id, type: 'text', name: '', segments: null, asset: '' }),
  draft: (poi) => poi,
  toPoi: (draft) => ({ ...draft, name: draft.name.trim() || 'Text' }),
  title: (draft) => draft.name.trim(),
};
