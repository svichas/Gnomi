import { useEffect, useState } from 'react';
import type { ProfileAttribute, Segment } from '@gnomi/simulation/types.ts';
import { AttributeRule } from './AttributeRule.tsx';
import { ATTRIBUTE_TYPES, choiceValues, defaultRule, PROFILE_GROUPS, setAttributeChoices, setSegmentRule } from './profile.ts';
import { Button, Check, Field, inputClass } from './ui.tsx';

function Flag({ label, text, checked, disabled = false, onChange }: { label: string; text?: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void }) {
  return <label className="flex items-center gap-2 text-sm text-stone-700"><input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="accent-indigo-600" />{text ?? label}</label>;
}

export function ProfileAttributeEditor({ attribute, custom, segments, onChange, onRemove }: { attribute: ProfileAttribute; custom: boolean; segments: Segment[]; onChange(next: ProfileAttribute): void; onRemove(): void }) {
  const [segment, setSegment] = useState('');
  const joined = attribute.choices?.join('\n');
  const [choices, setChoices] = useState(joined ?? '');
  useEffect(() => setChoices(joined ?? ''), [joined]);
  const set = <K extends keyof ProfileAttribute>(key: K, value: ProfileAttribute[K]) => onChange({ ...attribute, [key]: value });
  const selected = segments.find((item) => item.id === segment);
  const label = `${attribute.name} — ${selected?.name ?? 'Everyone'}`;
  const override = selected && attribute.sampling?.by_segment[selected.id];
  const rule = override || attribute.sampling?.default;
  return (
    <li className="profile-attribute space-y-3" data-included={attribute.enabled} aria-label={`${attribute.name} attribute`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Flag label={`Include ${attribute.name}`} text={attribute.name} checked={attribute.enabled} disabled={attribute.core} onChange={(value) => set('enabled', value)} />
        <span className="text-xs text-stone-500">{attribute.core ? 'Required' : custom ? 'Custom attribute' : 'Default attribute'}</span>
      </div>
      <p className="profile-attribute-description">{attribute.description}</p>
      <div className="profile-attribute-flags">
        <Flag label={`Show ${attribute.name} on cards`} text="Show on cards" checked={attribute.show_on_card} disabled={!attribute.enabled} onChange={(value) => set('show_on_card', value)} />
        <Flag label={`Use ${attribute.name} in prompts`} text="Use in prompts" checked={attribute.use_in_prompt} disabled={attribute.core || !attribute.enabled} onChange={(value) => set('use_in_prompt', value)} />
        <Flag label={`Use ${attribute.name} as a report dimension`} text="Report dimension" checked={attribute.report_dimension} disabled={!attribute.enabled} onChange={(value) => set('report_dimension', value)} />
      </div>
      <details>
        <summary className="cursor-pointer text-sm font-medium text-indigo-700">Configure {attribute.name}</summary>
        <div className="mt-3 space-y-4">
          {custom && <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`${attribute.name}: name`}><input value={attribute.name} onChange={(event) => set('name', event.target.value)} className={inputClass} /></Field>
            <Field label={`${attribute.name}: type`}><select value={attribute.type} onChange={(event) => {
              const type = event.target.value as ProfileAttribute['type'];
              onChange({ ...attribute, type, choices: type === 'choice' ? ['Option A', 'Option B'] : undefined, sampling: { default: defaultRule(type), by_segment: {} } });
            }} className={inputClass}>{Object.entries(ATTRIBUTE_TYPES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
            <Field label={`${attribute.name}: group`}><select value={attribute.group} onChange={(event) => set('group', event.target.value as ProfileAttribute['group'])} className={inputClass}>{Object.entries(PROFILE_GROUPS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
          </div>}
          <Field label={`${attribute.name}: description`} hint="Tell the persona writer what this trait means."><textarea rows={2} value={attribute.description} onChange={(event) => set('description', event.target.value)} className={inputClass} /></Field>
          {custom && attribute.type === 'choice' && <Field label={`${attribute.name}: choices`} hint="One choice per line."><textarea rows={3} value={choices} onChange={(event) => setChoices(event.target.value)} onBlur={() => onChange(setAttributeChoices(attribute, choiceValues(choices)))} className={inputClass} /></Field>}
          {attribute.sampling && rule ? <div className="space-y-3">
            {segments.length > 0 && <Field label={`Sampling for ${attribute.name}`}><select value={selected?.id ?? ''} onChange={(event) => setSegment(event.target.value)} className={inputClass}>
              <option value="">Everyone (default)</option>
              {segments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></Field>}
            {selected && <Check checked={!!override} onChange={(separate) => onChange(setSegmentRule(attribute, selected.id, separate ? attribute.sampling!.default : null))}>Use a separate rule for {selected.name}</Check>}
            {!selected || override ? <AttributeRule attribute={attribute} rule={rule} label={label} onChange={(next) => selected ? onChange(setSegmentRule(attribute, selected.id, next)) : set('sampling', { ...attribute.sampling!, default: next })} />
              : <p className="text-sm text-stone-500">This segment uses the default rule.</p>}
          </div> : <p className="text-sm text-stone-500">This value comes from the audience settings or the persona writer.</p>}
          {custom && <Button onClick={onRemove}>Remove {attribute.name}</Button>}
        </div>
      </details>
    </li>
  );
}
