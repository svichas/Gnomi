import type { ReactNode } from 'react';
import type { Segment, SessionInfo, UsageFrequency } from '@gnomi/engine/types.ts';
import { Field, inputClass, NumberInput, secondaryButton } from './ui.tsx';

const FREQUENCY: Record<UsageFrequency, string> = { daily: 'Every day', weekly: 'Every week', monthly: 'Every month', rarely: 'Rarely', never: 'Never before' };
const ENTRY: Record<Segment['entry'], string> = { direct: 'Opens the site directly', email_link: 'From a link in an email', shared_link: 'From a shared link' };
const ACCOUNT: Record<Segment['account_state'], string> = { empty: 'A new, empty account', populated: 'An account with data' };

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

/** One segment of the audience (idea.md §8.1): who they are, what they do, and their share of the population. */
export function SegmentCard(props: {
  segment: Segment;
  sessions: SessionInfo[];
  several: boolean; // a lone segment is everyone: it can neither be removed nor have its share changed
  onChange(segment: Segment): void;
  onShare(share: number): void;
  onRemove(): void;
}) {
  const { segment, sessions, several, onChange, onShare, onRemove } = props;
  const set = <K extends keyof Segment>(key: K, value: Segment[K]) => onChange({ ...segment, [key]: value });
  const roles = sessions.map((session) => session.role);
  return (
    <li className="space-y-4 rounded-lg border border-stone-200 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <Field label="Segment name">
            <input value={segment.name} onChange={(e) => set('name', e.target.value)} className={inputClass} />
          </Field>
        </div>
        <button type="button" onClick={onRemove} disabled={!several} aria-label={`Remove segment ${segment.name}`} className={secondaryButton}>
          Remove segment
        </button>
      </div>

      <label className="block">
        <span className="mb-1 flex justify-between text-sm font-medium text-stone-700">
          <span>Share of the audience</span>
          <span>{segment.share}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={segment.share}
          aria-label={`Share of ${segment.name}`}
          onChange={(e) => onShare(Number(e.target.value))}
          disabled={!several}
          className="w-full accent-indigo-600"
        />
      </label>

      <Field label="Who they are" hint="A sentence or two. The persona writer reads it.">
        <textarea value={segment.description} onChange={(e) => set('description', e.target.value)} rows={2} className={inputClass} />
      </Field>
      <Field label={`Employers for ${segment.name}`} hint="Optional, one employer per line. Personas are sampled across these employers.">
        <textarea value={(segment.employers ?? []).join('\n')} onChange={(e) => set('employers', e.target.value.split('\n'))} rows={2} className={inputClass} />
      </Field>

      <details className="segment-options"><summary>Habits, devices & scenarios</summary><div className="space-y-4 mt-4">
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
    </li>
  );
}
