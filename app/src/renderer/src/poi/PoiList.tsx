import { useState } from 'react';
import type { ComponentType } from 'react';
import { isEligible } from '@gnomi/engine/poi/pois.ts';
import type { Poi, PoiType, Segment, SessionInfo } from '@gnomi/engine/types.ts';
import { Button, Card, Check, Field, inputClass } from '../ui.tsx';
import { DesignPoiForm } from './DesignPoiForm.tsx';
import { FigmaImportDialog, type FigmaDesign } from './FigmaImportDialog.tsx';
import { draftOf, nextPoiId, POI_KINDS, poiTitle, type PoiDraft, type PoiFormProps } from './index.ts';
import { TextPoiForm } from './TextPoiForm.tsx';
import { WebPoiForm } from './WebPoiForm.tsx';

const FORMS = { web: WebPoiForm, text: TextPoiForm, design: DesignPoiForm } as { [T in PoiType]: ComponentType<PoiFormProps<Extract<PoiDraft, { type: T }>>> };

function Segments({ draft, segments, onChange }: { draft: PoiDraft; segments: Segment[]; onChange(segments: string[] | null): void }) {
  const byDefault = segments.filter((segment) => isEligible({ type: draft.type, segments: null } as Poi, segment)).map((segment) => segment.id);
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium text-stone-700">Who uses it</legend>
      <Check checked={draft.segments === null} onChange={(on) => onChange(on ? null : byDefault)}>
        Every segment it suits: users try everything, buyers read text and look at designs
      </Check>
      {draft.segments !== null && (
        <ul className="space-y-2 pl-6">
          {segments.map((segment) => (
            <li key={segment.id}>
              <Check checked={draft.segments!.includes(segment.id)} onChange={(on) => onChange(on ? [...draft.segments!, segment.id] : draft.segments!.filter((id) => id !== segment.id))}>
                {segment.name || 'Unnamed segment'}
              </Check>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/** The project's points of interest, in the order personas use them: add, rename, reorder, remove, and choose who uses each. */
export function PoiList(props: { pois: PoiDraft[]; onChange(pois: PoiDraft[]): void; segments: Segment[]; sessions: SessionInfo[] }) {
  const { pois, onChange, segments, sessions } = props;
  const [figma, setFigma] = useState(false);
  const update = (index: number, change: (draft: PoiDraft) => PoiDraft) => onChange(pois.map((draft, i) => (i === index ? change(draft) : draft)));
  const move = (index: number, by: number) => {
    const next = [...pois];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    onChange(next);
  };
  return (
    <Card title="Points of interest">
      <div className="space-y-4">
        <p className="text-sm text-stone-600">What personas try, in this order. Each persona uses the ones its segment is chosen for, one after another.</p>
        <ol className="space-y-4" aria-label="Points of interest">
          {pois.map((draft, index) => {
            const title = poiTitle(draft, index);
            const Form = FORMS[draft.type] as ComponentType<PoiFormProps<PoiDraft>>;
            return (
              <li key={draft.id} aria-label={title} className="space-y-4 rounded-lg border border-stone-200 p-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-48 flex-1">
                    <Field label={`${POI_KINDS[draft.type].label} name`}>
                      <input value={draft.name} onChange={(e) => update(index, (was) => ({ ...was, name: e.target.value }))} placeholder={title} className={inputClass} />
                    </Field>
                  </div>
                  <Button small variant="quiet" aria-label={`Move ${title} up`} disabled={index === 0} onClick={() => move(index, -1)}>Up</Button>
                  <Button small variant="quiet" aria-label={`Move ${title} down`} disabled={index === pois.length - 1} onClick={() => move(index, 1)}>Down</Button>
                  <Button small variant="quiet" aria-label={`Remove ${title}`} onClick={() => onChange(pois.filter((_, i) => i !== index))}>Remove</Button>
                </div>
                {segments.length > 0 && <Segments draft={draft} segments={segments} onChange={(chosen) => update(index, (was) => ({ ...was, segments: chosen }))} />}
                <Form draft={draft} onChange={(change) => update(index, change as (draft: PoiDraft) => PoiDraft)} sessions={sessions} />
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap gap-3">
          {(Object.keys(POI_KINDS) as PoiType[]).map((type) => (
            <Button key={type} small onClick={() => onChange([...pois, POI_KINDS[type].blank(nextPoiId(pois))])}>
              Add {POI_KINDS[type].label.toLowerCase()}
            </Button>
          ))}
          <Button small onClick={() => setFigma(true)}>Add from Figma</Button>
        </div>
        {figma && (
          <FigmaImportDialog
            onClose={() => setFigma(false)}
            onAdd={({ name, frames }: FigmaDesign) => {
              onChange([...pois, draftOf({ id: nextPoiId(pois), type: 'design', name, segments: null, frames })]);
              setFigma(false);
            }}
          />
        )}
      </div>
    </Card>
  );
}
