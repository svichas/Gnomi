import { emptyDecisionContext } from '@gnomi/simulation/comparison/config.ts';
import type { ComparisonDecisionContext } from '@gnomi/simulation/comparison/types.ts';
import { Field, inputClass } from './ui.tsx';

/** One company brief; the same facts apply to every tool and stakeholder. */
export function DecisionBrief({ value, onChange }: { value?: ComparisonDecisionContext; onChange(value: ComparisonDecisionContext): void }) {
  const brief = value ?? emptyDecisionContext();
  const set = <K extends keyof ComparisonDecisionContext>(key: K, value: ComparisonDecisionContext[K]) => onChange({ ...brief, [key]: value });
  const lines = (text: string) => text.split('\n');
  return <fieldset className="space-y-4">
    <legend className="mb-2 text-sm font-medium text-stone-900">Your company and requirements</legend>
    <p className="text-sm text-stone-600">Use one company for every tool. Leave unknowns blank; they stay open questions. Each requirement or integration becomes its own comparison row.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Company size and seats"><input className={inputClass} maxLength={400} value={brief.company_size} onChange={(e) => set('company_size', e.target.value)} placeholder="120 employees, 4 recruiter seats" /></Field>
      <Field label="Hiring volume (if relevant)"><input className={inputClass} maxLength={400} value={brief.hiring_volume} onChange={(e) => set('hiring_volume', e.target.value)} placeholder="30 hires per year" /></Field>
    </div>
    <Field label="Budget and billing constraints"><input className={inputClass} maxLength={400} value={brief.budget} onChange={(e) => set('budget', e.target.value)} placeholder="Up to EUR 500/month; annual billing allowed" /></Field>
    <Field label="Required capabilities, one per line" hint="Write one independently checkable requirement on each line."><textarea className={inputClass} rows={3} value={brief.requirements.join('\n')} onChange={(e) => set('requirements', lines(e.target.value))} placeholder={'Structured interview scorecards\nExport all candidate data'} /></Field>
    <Field label="Required integrations, one per line"><textarea className={inputClass} rows={2} value={brief.required_integrations.join('\n')} onChange={(e) => set('required_integrations', lines(e.target.value))} placeholder={'Slack\nGoogle Workspace'} /></Field>
    <Field label="Switching and migration constraints"><input className={inputClass} maxLength={400} value={brief.switching_constraints} onChange={(e) => set('switching_constraints', e.target.value)} placeholder="Import 2,000 existing candidate records from CSV" /></Field>
  </fieldset>;
}
