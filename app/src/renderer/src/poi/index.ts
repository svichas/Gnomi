import type { DesignPoi, Poi, PoiType, SessionInfo, TextPoi } from '@gnomi/simulation/types.ts';
import { design } from './design.ts';
import { text } from './text.ts';
import { web, type WebDraft } from './web.ts';

// The Project screen's side of the POI registry (docs/pois.md): per type, an editable draft and the rules that make it a POI.
// No React here; each type's form component is in its own <Type>PoiForm.tsx, mapped in PoiList.tsx.

export interface PoiKind<D extends { id: string; type: PoiType; name: string; segments: string[] | null }, P extends Poi> {
  label: string; // shown on the add button and the POI's badge
  blank(id: string): D;
  draft(poi: P): D;
  /** The POI, or what is wrong with the draft as a sentence. */
  toPoi(draft: D): P | string;
  /** The name to show for the draft while it is edited, or '' to fall back to a numbered label. */
  title(draft: D): string;
}

export type PoiDraft = WebDraft | TextPoi | DesignPoi;

export const POI_KINDS = { web, text, design } as const;
const kindOf = <D extends PoiDraft>(draft: D) => POI_KINDS[draft.type] as unknown as PoiKind<D, Poi>;

export const draftOf = (poi: Poi): PoiDraft => (POI_KINDS[poi.type] as unknown as PoiKind<PoiDraft, Poi>).draft(poi);
export const poiOf = (draft: PoiDraft): Poi | string => kindOf(draft).toPoi(draft);
export const poiTitle = (draft: PoiDraft, index: number): string => kindOf(draft).title(draft) || `${POI_KINDS[draft.type].label} ${index + 1}`;

/** The items with the one at `index` moved `by` places (−1 earlier, +1 later). */
export function move<T>(items: T[], index: number, by: number): T[] {
  const next = [...items];
  [next[index], next[index + by]] = [next[index + by], next[index]];
  return next;
}

/** An id no draft has yet: poi-1, poi-2, … */
export const nextPoiId = (drafts: PoiDraft[]): string => `poi-${Math.max(0, ...drafts.map((d) => Number(/^poi-(\d+)$/.exec(d.id)?.[1] ?? 0))) + 1}`;

/** What PoiList hands each type's form component: its draft, a way to change it, and the project's recorded logins. */
export interface PoiFormProps<D extends PoiDraft> {
  draft: D;
  onChange(update: (draft: D) => D): void;
  sessions: SessionInfo[];
}
