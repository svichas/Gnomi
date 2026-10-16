import type { DesignPoi } from '@gnomi/engine/types.ts';
import { Note } from '../ui.tsx';
import type { PoiFormProps } from './index.ts';

// shortcut: a placeholder the static-design POI session replaces with frame import and ordering (import_asset).
export function DesignPoiForm(_props: PoiFormProps<DesignPoi>) {
  return <Note tone="info">Design points of interest are coming soon. A run will not start while this one is in the list.</Note>;
}
