import type { TextPoi } from '@gnomi/engine/types.ts';
import { Note } from '../ui.tsx';
import type { PoiFormProps } from './index.ts';

// shortcut: a placeholder the text POI session replaces with paste and .md/.txt import (import_asset).
export function TextPoiForm(_props: PoiFormProps<TextPoi>) {
  return <Note tone="info">Text points of interest are coming soon. A run will not start while this one is in the list.</Note>;
}
