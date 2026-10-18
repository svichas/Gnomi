import type { TextPoi } from '@gnomi/simulation/types.ts';
import type { PoiKind } from './index.ts';

// The draft is the POI as saved: its text is already an asset once pasted or chosen (TextPoiForm.tsx).
export const text: PoiKind<TextPoi, TextPoi> = {
  label: 'Text',
  blank: (id) => ({ id, type: 'text', name: '', segments: null, asset: '' }),
  draft: (poi) => poi,
  toPoi: (draft) => (draft.asset ? { ...draft, name: draft.name.trim() || 'Text' } : 'Paste the text, or choose a .md or .txt file.'),
  title: (draft) => draft.name.trim(),
};
