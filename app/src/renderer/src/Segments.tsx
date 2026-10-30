import { useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Api } from '@gnomi/engine/protocol.ts';
import type { Audience, Segment, SessionInfo, UsageFrequency } from '@gnomi/simulation/types.ts';
import { segmentVar } from './audience.ts';
import { call } from './engine.ts';
import { Icon } from './Icon.tsx';
import { count } from './reportParts.tsx';
import { Button, Dialog, Field, inputClass, NumberInput, OutcomeNote, useAction, usd } from './ui.tsx';

const FREQUENCY: Record<UsageFrequency, string> = { daily: 'Every day', weekly: 'Every week', monthly: 'Every month', rarely: 'Rarely', never: 'Never before' };
const ENTRY: Record<Segment['entry'], string> = { direct: 'Opens the site directly', email_link: 'From a link in an email', shared_link: 'From a shared link' };
const ACCOUNT: Record<Segment['account_state'], string> = { empty: 'A new, empty account', populated: 'An account with data' };
// Absent is user (segments saved before M5). What each kind does by default is isEligible in simulation/src/poi/pois.ts.
const KIND: Record<NonNullable<Segment['kind']>, { label: string; hint: string }> = {
  user: { label: 'Users', hint: 'Try the product and describe their experience.' },
  buyer: { label: 'Buyers', hint: 'Review text and designs to decide whether they would buy.' },
};

function Pick<T extends string>(props: { label: string; value: T; options: Record<T, string>; onChange(value: T): void }) {
  return (
    <Field label={props.label}>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value as T)} className={inputClass}>
        {(Object.keys(props.options) as T[]).map((key) => (
          <option key={key} value={key}>
            {props.options[key]}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Range(props: { label: string; value: [number, number]; onChange(value: [number, number]): void }): ReactNode {
  const [low, high] = props.value;
  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-stone-700">{props.label}</span>
      <div className="flex items-center gap-2">
        <NumberInput label={`${props.label}, lowest`} value={low} onChange={(v) => props.onChange([v, high])} min={1} max={5} />
        <span className="text-sm text-stone-500">to</span>
        <NumberInput label={`${props.label}, highest`} value={high} onChange={(v) => props.onChange([low, v])} min={1} max={5} />
      </div>
    </div>
  );
}

const mixText = (mix: Record<string, number>) => Object.entries(mix).map(([key, share]) => `${key} ${share <= 1 ? Math.round(share * 100) : share}%`).join(', ');

/** Real data behind one segment. The engine reads each file once; only what comes out of it stays with the segment. */
function RealData({ audience, segment, onAudience, onChange }: { audience: Audience; segment: Segment; onAudience(audience: Audience): void; onChange(segment: Segment): void }) {
  const analyticsPicker = useRef<HTMLInputElement>(null);
  const sourcesPicker = useRef<HTMLInputElement>(null);
  const action = useAction();
  const [preview, setPreview] = useState<Api['analytics_preview']['result'] | null>(null);
  const [pending, setPending] = useState<{ paths: string[]; estimate: Api['estimate_sources']['result'] } | null>(null);
  const readAnalytics = (file: File | undefined) => action.run(async () => {
    if (analyticsPicker.current) analyticsPicker.current.value = '';
    if (file) setPreview(await call('analytics_preview', { path: window.gnomi.pathForFile(file), audience, segment_id: segment.id }));
    return null;
  });
  const readSources = (files: File[]) => action.run(async () => {
    if (sourcesPicker.current) sourcesPicker.current.value = '';
    const paths = files.map((file) => window.gnomi.pathForFile(file));
    if (paths.length) setPending({ paths, estimate: await call('estimate_sources', { paths }) });
    return null;
  });
  const extract = ({ paths, estimate }: NonNullable<typeof pending>) => {
    setPending(null);
    void action.run(async () => {
      const { grounding, dropped, cost_usd } = await call('ground_segment', { segment, paths, budget_usd: estimate.high_usd });
      onChange({ ...segment, grounding });
      return { ok: true, text: `Extracted ${count(grounding.facts.length, 'fact')} and ${count(grounding.remarks.length, 'remark')} (${usd(cost_usd)}).${dropped ? ` Dropped ${count(dropped, 'remark')} not found word for word or over the limit.` : ''} Generate personas to write them in.` };
    });
  };
  const { countries, languages, ...others } = segment;
  const { facts = [], remarks = [], sources = [] } = segment.grounding ?? {};
  const summary = [countries || languages ? 'Analytics' : '', facts.length || remarks.length ? `${count(facts.length, 'fact')}, ${count(remarks.length, 'remark')}` : ''].filter(Boolean).join(' · ');
  return (
    <details className="segment-options">
      <summary>Real data<span>{summary || 'None yet'}</span></summary>
      <div className="space-y-3 mt-4 min-w-0 text-sm text-stone-600">
        {(countries || languages) && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 break-words">From analytics: {[countries && mixText(countries), languages && mixText(languages)].filter(Boolean).join('; ')}</p>
            <Button small variant="quiet" aria-label={`Use the audience mix for ${segment.name}`} onClick={() => onChange(others)}>Use the audience mix</Button>
          </div>
        )}
        <p>Set shares, phone use, countries and languages from an analytics export. You see the changes first, and no model is called.</p>
        <input ref={analyticsPicker} type="file" accept=".csv" hidden aria-label={`Analytics export for ${segment.name}`} onChange={(e) => void readAnalytics(e.target.files?.[0])} />
        <Button small loading={action.busy} onClick={() => analyticsPicker.current?.click()}>Import analytics</Button>
        {(facts.length > 0 || remarks.length > 0) && (
          <div className="space-y-2">
            <p className="break-words">The persona writer reads this digest of {sources.map((source) => source.name).join(', ')}. Personas stay fictional.</p>
            <ul aria-label={`Research digest for ${segment.name}`} className="list-disc space-y-1 pl-4 break-words">
              {facts.map((fact) => <li key={fact}>{fact}</li>)}
              {remarks.map((remark) => <li key={remark}>“{remark}”</li>)}
            </ul>
            <Button small variant="quiet" aria-label={`Remove the research digest for ${segment.name}`} onClick={() => onChange({ ...segment, grounding: undefined })}>Remove digest</Button>
          </div>
        )}
        <p>Add interview notes or support tickets as .md or .txt. The persona writer reads a digest of them, and each persona carries a few real remarks. You see the most it can cost first.</p>
        <input ref={sourcesPicker} type="file" accept=".md,.txt" multiple hidden aria-label={`Research notes for ${segment.name}`} onChange={(e) => void readSources([...(e.target.files ?? [])])} />
        <Button small loading={action.busy} onClick={() => sourcesPicker.current?.click()}>Add research notes</Button>
        <OutcomeNote outcome={action.outcome} />
      </div>
      {preview && (
        <Dialog title="Import this analytics file?" onCancel={() => setPreview(null)} wide>
          {preview.changes.length > 0 ? <ul className="list-disc space-y-1 pl-4 text-sm break-words">{preview.changes.map((text) => <li key={text}>{text}</li>)}</ul> : <p className="text-sm">Nothing in this file changes the audience.</p>}
          {preview.skipped.length > 0 && <><h3 className="text-sm font-medium">Left out</h3><ul className="list-disc space-y-1 pl-4 text-sm text-stone-600 break-words">{preview.skipped.map((text) => <li key={text}>{text}</li>)}</ul></>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={!preview.changes.length} onClick={() => { onAudience(preview.audience); setPreview(null); }}>Apply changes</Button>
            <Button onClick={() => setPreview(null)}>Cancel</Button>
          </div>
        </Dialog>
      )}
      {pending && (
        <Dialog title="Send these notes to your model?" onCancel={() => setPending(null)} wide>
          <p className="text-sm break-words">{pending.estimate.files.join(', ')}: {count(pending.estimate.emails, 'email')} and {count(pending.estimate.phones, 'phone number')} found.</p>
          <p className="text-sm">{pending.estimate.notice}</p>
          <p className="text-sm font-medium">This will cost at most {usd(pending.estimate.high_usd)}.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => extract(pending)}>Send and extract</Button>
            <Button onClick={() => setPending(null)}>Cancel</Button>
          </div>
        </Dialog>
      )}
    </details>
  );
}

/** One segment of the audience (idea.md §8.1): who they are, what they do, and their share of the population. */
export function SegmentCard(props: {
  segment: Segment;
  audience: Audience;
  index: number; // picks the segment's colour
  sessions: SessionInfo[];
  several: boolean; // a lone segment is everyone: it can neither be removed nor have its share changed
  onChange(segment: Segment): void;
  onAudience(audience: Audience): void;
  onShare(share: number): void;
  onRemove(): void;
}) {
  const { segment, audience, index, sessions, several, onChange, onAudience, onShare, onRemove } = props;
  const set = <K extends keyof Segment>(key: K, value: Segment[K]) => onChange({ ...segment, [key]: value });
  const roles = sessions.map((session) => session.role);
  const nameId = useId();
  return (
    <li className="segment-card" style={{ '--segment-color': segmentVar(index) } as CSSProperties}>
      <div className="segment-head">
        <span className="segment-dot" aria-hidden="true" />
        <label htmlFor={nameId} className="sr-only">Segment name</label>
        <input id={nameId} value={segment.name} onChange={(e) => set('name', e.target.value)} placeholder="Name this group" className="segment-name" />
        <div className="segment-share">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={segment.share}
            aria-label={`Share of ${segment.name}`}
            onChange={(e) => onShare(Number(e.target.value))}
            disabled={!several}
          />
          <span aria-hidden="true">{segment.share}%</span>
        </div>
        <button type="button" onClick={onRemove} disabled={!several} aria-label={`Remove segment ${segment.name}`} title="Remove segment" className="icon-button">
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="segment-body">
        <div role="group" aria-label={`Kind of segment for ${segment.name}`} className="segment-kind-picker">
          {(Object.keys(KIND) as (keyof typeof KIND)[]).map((kind) => (
            <Button key={kind} small className="segment-kind-choice" aria-label={KIND[kind].label} aria-pressed={(segment.kind ?? 'user') === kind} onClick={() => set('kind', kind)}>
              <span className="segment-kind-mark" aria-hidden="true">{(segment.kind ?? 'user') === kind && <Icon name="check" size={14} />}</span><span><strong>{KIND[kind].label}</strong><small>{KIND[kind].hint}</small></span>
            </Button>
          ))}
        </div>
        <Field label="Who they are">
          <textarea value={segment.description} onChange={(e) => set('description', e.target.value)} rows={2} placeholder="A sentence or two. The persona writer reads it." className={inputClass} />
        </Field>
        <Field label="Employers" hint="Optional, one per line.">
          <textarea value={(segment.employers ?? []).join('\n')} onChange={(e) => set('employers', e.target.value.split('\n'))} rows={2} aria-label={`Employers for ${segment.name}`} className={inputClass} />
        </Field>
      </div>

      <details className="segment-options"><summary>Habits, devices & scenarios<span>{Math.round(segment.mobile_share * 100)}% phone · {segment.role || 'Logged out'} · {FREQUENCY[segment.usage_frequency]}</span></summary><div className="space-y-4 mt-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Login">
          <select value={segment.role ?? ''} onChange={(e) => set('role', e.target.value || null)} className={inputClass}>
            <option value="">Logged out</option>
            {segment.role !== null && !roles.includes(segment.role) && <option value={segment.role}>{segment.role} (no login recorded)</option>}
            {roles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </Field>
        <Pick label="How often they use it" value={segment.usage_frequency} options={FREQUENCY} onChange={(v) => set('usage_frequency', v)} />
        <Pick label="Their account" value={segment.account_state} options={ACCOUNT} onChange={(v) => set('account_state', v)} />
        <Pick label="How they arrive" value={segment.entry} options={ENTRY} onChange={(v) => set('entry', v)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="On a phone (%)">
          <NumberInput label={`On a phone (%) for ${segment.name}`} value={Math.round(segment.mobile_share * 100)} onChange={(v) => set('mobile_share', Math.max(0, Math.min(100, v)) / 100)} min={0} max={100} />
        </Field>
        <Range label="Patience (1-5)" value={segment.patience} onChange={(v) => set('patience', v)} />
        <Range label="Tech skill (1-5)" value={segment.tech_skill} onChange={(v) => set('tech_skill', v)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What they usually come to do" hint="One thing per line.">
          <textarea value={segment.typical_goals.join('\n')} onChange={(e) => set('typical_goals', e.target.value.split('\n'))} rows={3} className={inputClass} />
        </Field>
        <Field label="Scenario for this segment" hint="Replaces the project's goal for this segment. Leave empty to use the goal.">
          <textarea value={segment.goal_override ?? ''} onChange={(e) => set('goal_override', e.target.value || null)} rows={3} className={inputClass} />
        </Field>
      </div>
      </div></details>
      <RealData audience={audience} segment={segment} onAudience={onAudience} onChange={onChange} />
    </li>
  );
}
