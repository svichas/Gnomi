import { useEffect, useId, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { isEligible } from '@gnomi/simulation/poi/pois.ts';
import type { Poi, PoiType, Segment, SessionInfo } from '@gnomi/simulation/types.ts';
import { Button, Check, Field, inputClass } from '../ui.tsx';
import { Icon } from '../Icon.tsx';
import { DesignPoiForm } from './DesignPoiForm.tsx';
import { FigmaImportDialog, type FigmaDesign } from './FigmaImportDialog.tsx';
import { draftOf, nextPoiId, POI_KINDS, poiOf, poiTitle, type PoiDraft, type PoiFormProps } from './index.ts';
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

const FORMATS = {
  web: { icon: 'globe', title: 'Add web app', description: 'Let personas explore and try a task.', example: 'Your staging site or a competitor' },
  text: { icon: 'report', title: 'Add text', description: 'See what reads clearly and what needs work.', example: 'Emails, pricing, or onboarding copy' },
  design: { icon: 'image', title: 'Add design', description: 'See how people interpret your screens.', example: 'Upload PNG, JPEG, or WebP images' },
} as const;

function PoiEditor({ draft, index, count, expanded, focusName, segments, sessions, comparison, onToggle, onChange, onMove, onRemove }: {
  draft: PoiDraft; index: number; count: number; expanded: boolean; focusName: boolean;
  segments: Segment[]; sessions: SessionInfo[]; onToggle(): void;
  comparison?: boolean;
  onChange(change: (draft: PoiDraft) => PoiDraft): void; onMove(by: number): void; onRemove(): void;
}) {
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Run after a closing Figma dialog restores its invoker, so the new item receives focus.
    if (focusName) name.current?.focus();
  }, [focusName]);
  const title = poiTitle(draft, index);
  const Form = FORMS[draft.type] as ComponentType<PoiFormProps<PoiDraft>>;
  const incomplete = typeof poiOf(draft) === 'string';
  const detail = draft.type === 'web' ? draft.mode === 'observe_only' ? comparison ? 'Public evidence, read only' : 'Competitor, observed only' : draft.url.trim() || 'Add a start page'
    : draft.type === 'text' ? draft.asset ? 'Text added' : 'Paste text or choose a file'
    : draft.frames.length ? `${draft.frames.length} ${draft.frames.length === 1 ? 'screen' : 'screens'}` : 'Add your first screen';
  return (
    <li aria-label={title} className="poi-item" data-expanded={expanded}>
      <div className="poi-item-header">
        <span className="poi-order" aria-label={`Step ${index + 1}`}>{index + 1}</span>
        <h3>
          <button ref={toggle} type="button" className="poi-toggle" aria-label={`Edit ${title}`} aria-expanded={expanded} aria-controls={id} onClick={onToggle}>
            <span className="poi-item-icon"><Icon name={FORMATS[draft.type].icon} size={18} /></span>
            <span className="poi-item-copy"><strong>{title}</strong><span>{POI_KINDS[draft.type].label} · <span>{detail}</span></span></span>
            <span className="poi-chevron"><Icon name="chevron" size={16} /></span>
          </button>
        </h3>
        <div className="poi-item-actions">
          <button type="button" className="icon-button" aria-label={`Move ${title} up`} title="Move earlier" disabled={index === 0} onClick={() => onMove(-1)}><Icon name="up" size={16} /></button>
          <button type="button" className="icon-button" aria-label={`Move ${title} down`} title="Move later" disabled={index === count - 1} onClick={() => onMove(1)}><Icon name="down" size={16} /></button>
          <button type="button" className="icon-button poi-remove" aria-label={`Remove ${title}`} title="Remove point of interest" onClick={onRemove}><Icon name="trash" size={16} /></button>
        </div>
      </div>
      {/* Keep editors mounted so collapsing never discards pasted text or an import in progress. */}
      <div id={id} hidden={!expanded} className="poi-editor">
        <Field label={`${POI_KINDS[draft.type].label} name`} hint="Optional. Give it a name you’ll recognize in the report.">
          <input ref={name} value={draft.name} onChange={(e) => onChange((was) => ({ ...was, name: e.target.value }))} placeholder={draft.type === 'web' ? 'e.g. Our hiring app' : draft.type === 'text' ? 'e.g. Welcome email' : 'e.g. Onboarding screens'} className={inputClass} />
        </Field>
        <Form draft={draft} onChange={onChange} sessions={sessions} comparison={comparison} />
        {segments.length > 0 && <details className="disclosure poi-audience">
          <summary><Icon name="people" size={18} />Who tries this?<span>{draft.segments === null ? 'Automatic selection' : `${draft.segments.length} selected`}</span></summary>
          <div className="disclosure-body"><Segments draft={draft} segments={segments} onChange={(chosen) => onChange((was) => ({ ...was, segments: chosen }))} /></div>
        </details>}
        <div className="poi-editor-footer">
          <span><Icon name={incomplete ? 'plus' : 'check'} size={14} />{incomplete ? 'Add the details above to get started.' : 'Details added. Save your project when you’re ready.'}</span>
          <Button small variant="quiet" onClick={() => { onToggle(); toggle.current?.focus(); }}>Collapse details<Icon name="up" size={14} /></Button>
        </div>
      </div>
    </li>
  );
}

/** The project's points of interest, in the order personas use them. */
export function PoiList(props: { pois: PoiDraft[]; onChange(update: (pois: PoiDraft[]) => PoiDraft[]): void; segments: Segment[]; sessions: SessionInfo[]; comparison?: boolean }) {
  const { pois, onChange, segments, sessions, comparison } = props;
  const [figma, setFigma] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(pois[0]?.id ?? null);
  const [added, setAdded] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const heading = useId();
  // Apply async imports to the current sequence by id, even if another item was added or moved meanwhile.
  const update = (id: string, change: (draft: PoiDraft) => PoiDraft) => onChange((current) => current.map((draft) => draft.id === id ? change(draft) : draft));
  const move = (index: number, by: number) => {
    const next = [...pois];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    onChange(() => next);
  };
  const add = (draft: PoiDraft) => {
    setAdded(draft.id);
    setExpanded(draft.id);
    onChange((current) => [...current, draft]);
  };
  const remove = (index: number) => {
    const next = pois.filter((_, i) => i !== index);
    if (expanded === pois[index].id) setExpanded(next[Math.min(index, next.length - 1)]?.id ?? null);
    onChange(() => next);
    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('.poi-toggle, .poi-choice')?.focus());
  };
  return (
    <section ref={root} className="content-panel poi-section" aria-labelledby={heading}>
      <div className="poi-section-heading"><h2 id={heading}>Points of interest</h2><span className="poi-count">{pois.length} {pois.length === 1 ? 'item' : 'items'}</span></div>
      <p className="poi-intro">{comparison ? 'Add the websites and materials to evaluate. Assign each source to a tool in the comparison below.' : 'Give your personas something to explore. Mix websites, words, and designs in one test.'}</p>
      {pois.length > 0 ? <p className="poi-sequence-label"><Icon name="play" size={14} />{comparison ? 'Comparison sources' : 'Your test sequence'}<span>{comparison ? 'Each tool faces the same requirements' : 'Personas try these in order'}</span></p>
        : <div className="poi-empty"><span className="poi-item-icon"><Icon name="spark" size={22} /></span><div><h3>Start with one thing to try.</h3><p>Choose a format below. You can add more whenever you need.</p></div></div>}
      <ol className="poi-list" aria-label="Points of interest">
        {pois.map((draft, index) => <PoiEditor key={draft.id} draft={draft} index={index} count={pois.length} expanded={expanded === draft.id} focusName={added === draft.id}
          segments={segments} sessions={sessions} comparison={comparison} onToggle={() => setExpanded(expanded === draft.id ? null : draft.id)}
          onChange={(change) => update(draft.id, change)} onMove={(by) => move(index, by)} onRemove={() => remove(index)} />)}
      </ol>
      <div className="poi-add">
        <h3>{pois.length ? 'Add another point of interest' : 'What would you like to test?'}</h3>
        <div className="poi-choices">
          {(Object.keys(FORMATS) as PoiType[]).map((type) => <button type="button" key={type} className="poi-choice" aria-label={`Add ${POI_KINDS[type].label.toLowerCase()}`} aria-describedby={`${heading}-${type}`} onClick={() => add(POI_KINDS[type].blank(nextPoiId(pois)))}>
            <span className="poi-choice-icon"><Icon name={FORMATS[type].icon} /></span>
            <span className="poi-choice-copy"><strong>{comparison && type === 'web' ? 'Add website' : FORMATS[type].title}</strong><span id={`${heading}-${type}`}>{comparison ? { web: 'Review a public site or a permitted test workflow.', text: 'Compare supplied documentation and product facts.', design: 'Evaluate supplied screens as prototype evidence.' }[type] : FORMATS[type].description}</span><small>{comparison ? { web: 'Marketing, pricing, or documentation', text: 'Product documents or pricing terms', design: 'Upload PNG, JPEG, or WebP images' }[type] : FORMATS[type].example}</small></span>
            <Icon name="plus" size={16} />
          </button>)}
          <button type="button" className="poi-choice" aria-label="Add from Figma" aria-describedby={`${heading}-figma`} onClick={() => setFigma(true)}>
            <span className="poi-choice-icon"><Icon name="figma" /></span><span className="poi-choice-copy"><strong>Add from Figma</strong><span id={`${heading}-figma`}>Bring in the frames you want feedback on.</span><small>Paste a link and choose your frames</small></span><Icon name="plus" size={16} />
          </button>
        </div>
      </div>
      {figma && <FigmaImportDialog onClose={() => setFigma(false)} onAdd={({ name, frames }: FigmaDesign) => {
        add(draftOf({ id: nextPoiId(pois), type: 'design', name, segments: null, frames }));
        setFigma(false);
      }} />}
    </section>
  );
}
