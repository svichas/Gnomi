import type { AttributeSamplingRule, ProfileAttribute } from '@gnomi/simulation/types.ts';
import { defaultRule } from './profile.ts';
import { Check, Field, inputClass, NumberInput } from './ui.tsx';

/** A typed sampling rule; choice weights are relative, with the implied percentage shown alongside. */
export function AttributeRule({ attribute, rule, label, onChange }: { attribute: ProfileAttribute; rule: AttributeSamplingRule; label: string; onChange(rule: AttributeSamplingRule): void }) {
  const { type } = attribute;
  const options = type === 'boolean' ? [true, false] : attribute.choices ?? [];
  const weighted = type === 'choice' || type === 'boolean';
  const allowed = type === 'number' ? ['fixed', 'range'] : weighted ? ['fixed', 'choices'] : ['fixed'];
  const fixedValue = () => type === 'number' ? 1 : type === 'boolean' ? true : type === 'choice' ? options[0] ?? '' : type === 'list' ? [] : '';
  const total = rule.kind === 'choices' ? rule.choices.reduce((sum, entry) => sum + entry.weight, 0) : 0;
  return (
    <fieldset className="space-y-3 rounded-lg border border-stone-200 p-3">
      <legend className="px-1 text-sm font-medium text-stone-800">{label}</legend>
      {allowed.length > 1 && <Field label={`${label}: sampling`}>
        <select value={rule.kind} className={inputClass} onChange={(event) => onChange(event.target.value === 'fixed' ? { kind: 'fixed', value: fixedValue() } : defaultRule(type, attribute.choices))}>
          <option value="fixed">Same value for everyone</option>
          {type === 'number' ? <option value="range">Sample from a range</option> : <option value="choices">Sample by choice weight</option>}
        </select>
      </Field>}
      {rule.kind === 'fixed' && <Field label={`${label}: value`}>
        {type === 'number' ? <NumberInput label={`${label}: value`} value={Number(rule.value)} onChange={(value) => onChange({ kind: 'fixed', value })} />
          : weighted ? <select className={inputClass} value={String(rule.value)} onChange={(event) => onChange({ kind: 'fixed', value: type === 'boolean' ? event.target.value === 'true' : event.target.value })}>
            {options.map((value) => <option key={String(value)} value={String(value)}>{typeof value === 'boolean' ? value ? 'Yes' : 'No' : value}</option>)}
          </select>
          : type === 'list' ? <textarea className={inputClass} rows={3} value={Array.isArray(rule.value) ? rule.value.join('\n') : ''} onChange={(event) => onChange({ kind: 'fixed', value: event.target.value.split('\n') })} placeholder="One item per line" />
          : <input className={inputClass} value={String(rule.value)} onChange={(event) => onChange({ kind: 'fixed', value: event.target.value })} />}
      </Field>}
      {rule.kind === 'range' && <>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`${label}: minimum`}><NumberInput label={`${label}: minimum`} value={rule.min} onChange={(min) => onChange({ ...rule, min })} /></Field>
          <Field label={`${label}: maximum`}><NumberInput label={`${label}: maximum`} value={rule.max} onChange={(max) => onChange({ ...rule, max })} /></Field>
        </div>
        <Check checked={rule.integer} onChange={(integer) => onChange({ ...rule, integer })}>Whole numbers only</Check>
      </>}
      {rule.kind === 'choices' && <div className="space-y-2">
        <p className="text-xs text-stone-500">Weights set the relative chance of each choice. Zero excludes a choice.</p>
        {rule.choices.map((entry, index) => {
          const choice = typeof entry.value === 'boolean' ? entry.value ? 'Yes' : 'No' : entry.value;
          return <div key={String(entry.value)} className="grid grid-cols-[minmax(0,1fr)_6rem_3rem] items-center gap-2">
            <span className="text-sm text-stone-700">{choice}</span>
            <NumberInput label={`${label}: ${choice} weight`} value={entry.weight} min={0} onChange={(weight) => onChange({ ...rule, choices: rule.choices.map((item, at) => at === index ? { ...item, weight } : item) })} />
            <span className="text-right text-xs text-stone-500">{total > 0 && Number.isFinite(total) ? `${Math.round(entry.weight / total * 100)}%` : '—'}</span>
          </div>;
        })}
      </div>}
    </fieldset>
  );
}
