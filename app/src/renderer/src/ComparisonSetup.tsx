import { useState } from 'react';
import { draftComparison } from '@gnomi/simulation/comparison/config.ts';
import type { ComparisonAccess, ComparisonStudy } from '@gnomi/simulation/comparison/types.ts';
import type { Poi, SessionInfo } from '@gnomi/simulation/types.ts';
import { toConfig, type Draft } from './form.ts';
import { poiOf } from './poi/index.ts';
import { RecordingPanel, type Recorder } from './Recorder.tsx';
import { Button, Card, Check, Field, inputClass, Note } from './ui.tsx';

const lines = (value: string) => value.split('\n');
const nextId = (prefix: string, items: { id: string }[]) => {
  let n = 1;
  while (items.some((item) => item.id === `${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
};
const scopes: Record<ComparisonAccess, string> = {
  public_site: 'Public website', documentation: 'Documentation', prototype: 'Prototype or supplied material', authenticated_workflow: 'Workflow with a recorded login',
};

/** A comparison is an explicit study: editing a project goal never silently changes its frozen task. */
export function ComparisonSetup({ draft, onChange, sessions, sessionsPersist, recorder, saveFirst }: {
  draft: Draft;
  onChange(study: ComparisonStudy | null): void;
  sessions: SessionInfo[];
  sessionsPersist: boolean;
  recorder: Recorder;
  saveFirst(): Promise<string | null>;
}) {
  const study = draft.form.comparison;
  const [problem, setProblem] = useState<string | null>(null);
  const pois = draft.form.pois.map(poiOf).filter((poi): poi is Poi => typeof poi !== 'string');
  const enable = (enabled: boolean) => {
    setProblem(null);
    if (!enabled) return onChange(null);
    const config = toConfig({ ...draft, form: { ...draft.form, comparison: null } });
    if (typeof config === 'string') return setProblem(config);
    if (config.pois.length < 2) return setProblem('Add at least two tools or materials above before creating a comparison.');
    onChange(draftComparison(config));
  };
  const update = (patch: Partial<ComparisonStudy>) => study && onChange({ ...study, ...patch });

  return <Card title="Compare tools">
    <div className="space-y-4">
      <Check checked={!!study} onChange={enable}>Evaluate tools against shared tasks and requirements</Check>
      <p className="text-sm text-stone-600">Get a side-by-side comparison with evidence, tradeoffs and next steps. Choose what matters before the personas begin.</p>
      {problem && <Note tone="error">{problem}</Note>}
      {study && <>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="What is this comparison for?">
            <select className={inputClass} value={study.purpose} onChange={(e) => update({ purpose: e.target.value as ComparisonStudy['purpose'], focal_target_id: e.target.value === 'choose_tool' ? null : study.focal_target_id })}>
              <option value="choose_tool">Choose a tool</option><option value="improve_own_product">Improve my own product</option>
            </select>
          </Field>
          {study.purpose === 'improve_own_product' && <Field label="Your product">
            <select className={inputClass} value={study.focal_target_id ?? ''} onChange={(e) => update({ focal_target_id: e.target.value || null })}>
              <option value="">Choose your product</option>{study.targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
            </select>
          </Field>}
          <Field label="How should personas compare?">
            <select className={inputClass} value={study.execution.mode} onChange={(e) => update({ execution: { ...study.execution, mode: e.target.value as ComparisonStudy['execution']['mode'], carryover: e.target.value === 'independent' ? 'none' : 'prior_observations' } })}>
              <option value="independent">Try each tool independently</option><option value="buyer_journey">Remember tools while choosing</option>
            </select>
          </Field>
        </div>
        <Field label="Decision to make"><textarea className={inputClass} rows={2} value={study.question} onChange={(e) => update({ question: e.target.value })} /></Field>
        <p className="text-xs text-stone-600">Every persona gets the same task for each tool. Tool order is balanced; shared social feeds are off for comparisons.</p>
        <section aria-labelledby="comparison-brief-title" className="space-y-2 rounded-lg bg-stone-50 p-3 text-sm">
          <h3 id="comparison-brief-title" className="font-medium text-stone-900">The comparison you will run</h3>
          <p className="text-stone-700">{study.targets.length} tools · {study.tasks.length} shared {study.tasks.length === 1 ? 'task' : 'tasks'} · {study.scenarios.length} {study.scenarios.length === 1 ? 'scenario' : 'scenarios'} · {study.criteria.length} decision criteria</p>
          <ul className="space-y-1 text-xs text-stone-600">{study.targets.map((target) => <li key={target.id}>{target.name}: {scopes[target.access_scope]}</li>)}</ul>
          <ol className="list-decimal space-y-2 pl-5 text-stone-700">{study.tasks.slice(0, 3).map((task) => <li key={task.id}>{task.instruction || 'Task instructions still need to be supplied.'}</li>)}</ol>
          {study.tasks.length > 3 && <p className="text-xs text-stone-600">Review the other {study.tasks.length - 3} tasks under Scenarios and shared tasks.</p>}
          <p className="text-xs text-stone-600">{Math.round(study.execution.analysis_reserve_fraction * 100)}% of the model allowance is reserved for evidence analysis. The report keeps unknowns and access limits visible.</p>
        </section>
        {!sessionsPersist && study.targets.some((target) => target.access_scope === 'authenticated_workflow') && <Note tone="info">This computer has no secure key storage, so recorded logins will not survive a restart of Gnomi.</Note>}

        <details className="disclosure" open>
          <summary>Tools and access<span>What evidence can each tool provide?</span></summary>
          <div className="disclosure-body space-y-4">
            {study.targets.map((target) => {
              const change = (patch: Partial<typeof target>) => update({ targets: study.targets.map((t) => t.id === target.id ? { ...t, ...patch } : t) });
              const session = sessions.find((s) => s.role === target.session_role && s.target_id === target.id);
              return <fieldset key={target.id} className="space-y-3 rounded-lg border border-stone-200 p-3">
                <legend className="px-1 text-sm font-medium">{target.name}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Tool name"><input className={inputClass} value={target.name} onChange={(e) => change({ name: e.target.value })} /></Field>
                  <Field label="Evaluation scope"><select className={inputClass} value={target.access_scope} onChange={(e) => change({ access_scope: e.target.value as ComparisonAccess, session_role: e.target.value === 'authenticated_workflow' ? target.session_role : null })}>
                    {Object.entries(scopes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select></Field>
                </div>
                <fieldset className="space-y-1"><legend className="text-xs text-stone-600">Pages or materials belonging to this tool</legend>
                  {pois.map((poi) => <Check key={poi.id} checked={target.poi_ids.includes(poi.id)} onChange={(checked) => change({ poi_ids: checked ? [...target.poi_ids, poi.id] : target.poi_ids.filter((id) => id !== poi.id) })}>{poi.name}</Check>)}
                </fieldset>
                {target.access_scope === 'authenticated_workflow' && <>
                  <Field label="Login name for this tool" hint="Use a separate name for each tool, such as workable-recruiter."><input className={inputClass} value={target.session_role ?? ''} placeholder="tool-recruiter" onChange={(e) => change({ session_role: e.target.value.toLowerCase() || null })} /></Field>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button small disabled={!target.session_role || recorder.busy || recorder.recording !== null} onClick={() => void recorder.start(target.session_role!, saveFirst, target.id)}>{session ? 'Re-record login' : 'Record login'}</Button>
                    <span className="text-xs text-stone-600">{session ? `Recorded for ${target.name}.` : 'Without a valid recorded login, this workflow will be reported as access-limited.'}</span>
                  </div>
                </>}
                <Button small variant="link" disabled={study.targets.length <= 2} onClick={() => update({ targets: study.targets.filter((t) => t.id !== target.id), focal_target_id: study.focal_target_id === target.id ? null : study.focal_target_id, tasks: study.tasks.map((task) => ({ ...task, entries: task.entries.filter((entry) => entry.target_id !== target.id) })) })}>Remove tool</Button>
              </fieldset>;
            })}
            <Button small onClick={() => {
              const poi = pois.find((p) => !study.targets.some((t) => t.poi_ids.includes(p.id)));
              if (!poi) return setProblem('Add a new page or material above, then add it as a tool. To combine materials, select them under the same tool.');
              const id = nextId('target', study.targets);
              update({ targets: [...study.targets, { id, name: poi.name, poi_ids: [poi.id], access_scope: poi.type === 'web' ? 'public_site' : 'prototype', session_role: null }], tasks: study.tasks.map((task) => ({ ...task, entries: [...task.entries, { target_id: id, poi_id: poi.id }] })) });
            }}>Add another tool</Button>
          </div>
        </details>

        <details className="disclosure" open>
          <summary>Decision criteria<span>Evidence the report must compare</span></summary>
          <div className="disclosure-body space-y-3">
            {study.criteria.map((criterion) => {
              const change = (patch: Partial<typeof criterion>) => update({ criteria: study.criteria.map((c) => c.id === criterion.id ? { ...c, ...patch } : c) });
              return <fieldset key={criterion.id} className="space-y-3 rounded-lg border border-stone-200 p-3">
                <legend className="px-1 text-sm font-medium">{criterion.name || 'New criterion'}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Criterion"><input className={inputClass} value={criterion.name} onChange={(e) => change({ name: e.target.value })} /></Field>
                  <Field label="Importance"><select className={inputClass} value={criterion.importance} onChange={(e) => change({ importance: e.target.value as typeof criterion.importance })}><option value="must_have">Must have</option><option value="preference">Preference</option></select></Field>
                </div>
                <Field label="Question to answer"><input className={inputClass} value={criterion.question} onChange={(e) => change({ question: e.target.value })} /></Field>
                <Field label="What would meet this requirement?"><textarea rows={2} className={inputClass} value={criterion.decision_rule} onChange={(e) => change({ decision_rule: e.target.value })} /></Field>
                <Field label="Evidence to look for"><input className={inputClass} value={criterion.evidence_required} onChange={(e) => change({ evidence_required: e.target.value })} /></Field>
                <Button small variant="link" disabled={study.criteria.length <= 1} onClick={() => update({ criteria: study.criteria.filter((c) => c.id !== criterion.id), tasks: study.tasks.map((task) => ({ ...task, criterion_ids: task.criterion_ids.filter((id) => id !== criterion.id) })) })}>Remove criterion</Button>
              </fieldset>;
            })}
            <Button small onClick={() => {
              const id = nextId('criterion', study.criteria);
              update({ criteria: [...study.criteria, { id, name: '', question: '', importance: 'preference', evidence_required: '', decision_rule: '' }], tasks: study.tasks.map((task) => ({ ...task, criterion_ids: [...task.criterion_ids, id] })) });
            }}>Add criterion</Button>
          </div>
        </details>

        <details className="disclosure">
          <summary>Scenarios and shared tasks<span>Context, success rules and equal effort</span></summary>
          <div className="disclosure-body space-y-4">
            {study.scenarios.map((scenario) => <fieldset key={scenario.id} className="space-y-3 rounded-lg border border-stone-200 p-3">
              <legend className="px-1 text-sm font-medium">{scenario.name}</legend>
              <Field label="Scenario name"><input className={inputClass} value={scenario.name} onChange={(e) => update({ scenarios: study.scenarios.map((s) => s.id === scenario.id ? { ...s, name: e.target.value } : s) })} /></Field>
              <Field label="Company, user needs and constraints" hint="Specify size, budget or required workflows when relevant. Unknown requirements stay explicit."><textarea rows={3} className={inputClass} value={scenario.context} onChange={(e) => update({ scenarios: study.scenarios.map((s) => s.id === scenario.id ? { ...s, context: e.target.value } : s) })} /></Field>
              {draft.audience && <fieldset className="space-y-1"><legend className="text-xs text-stone-600">Eligible audience</legend>
                <Check checked={scenario.segment_ids === null} onChange={(all) => update({ scenarios: study.scenarios.map((s) => s.id === scenario.id ? { ...s, segment_ids: all ? null : [] } : s) })}>All segments</Check>
                {scenario.segment_ids !== null && draft.audience.segments.map((segment) => <Check key={segment.id} checked={scenario.segment_ids!.includes(segment.id)} onChange={(checked) => update({ scenarios: study.scenarios.map((s) => s.id === scenario.id ? { ...s, segment_ids: checked ? [...s.segment_ids!, segment.id] : s.segment_ids!.filter((id) => id !== segment.id) } : s) })}>{segment.name}</Check>)}
              </fieldset>}
              <Button small variant="link" disabled={study.scenarios.length <= 1 || study.tasks.some((task) => task.scenario_id === scenario.id)} onClick={() => update({ scenarios: study.scenarios.filter((s) => s.id !== scenario.id) })}>Remove unused scenario</Button>
            </fieldset>)}
            {study.tasks.map((task) => {
              const change = (patch: Partial<typeof task>) => update({ tasks: study.tasks.map((t) => t.id === task.id ? { ...t, ...patch } : t) });
              return <fieldset key={task.id} className="space-y-3 rounded-lg border border-stone-200 p-3">
                <legend className="px-1 text-sm font-medium">Shared task {study.tasks.indexOf(task) + 1}</legend>
                <Field label="Scenario"><select className={inputClass} value={task.scenario_id} onChange={(e) => change({ scenario_id: e.target.value })}>{study.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
                <Field label="Task for every tool"><textarea rows={3} className={inputClass} value={task.instruction} onChange={(e) => change({ instruction: e.target.value })} /></Field>
                <Field label="Evidence of task completion"><textarea rows={2} className={inputClass} value={task.success_rule} onChange={(e) => change({ success_rule: e.target.value })} /></Field>
                <Field label="Prerequisites, one per line"><textarea rows={2} className={inputClass} value={task.prerequisites.join('\n')} onChange={(e) => change({ prerequisites: lines(e.target.value) })} /></Field>
                <Check checked={task.requires_fixture ?? false} onChange={(checked) => change({ requires_fixture: checked })}>Requires prepared test data for every tool</Check>
                <Field label="Maximum steps per tool"><input className={inputClass} type="number" min={1} max={100} value={task.max_steps} onChange={(e) => change({ max_steps: Number(e.target.value) })} /></Field>
                <fieldset className="space-y-1"><legend className="text-xs text-stone-600">Criteria this task answers</legend>{study.criteria.map((criterion) => <Check key={criterion.id} checked={task.criterion_ids.includes(criterion.id)} onChange={(checked) => change({ criterion_ids: checked ? [...task.criterion_ids, criterion.id] : task.criterion_ids.filter((id) => id !== criterion.id) })}>{criterion.name}</Check>)}</fieldset>
                {study.targets.map((target) => {
                  const entry = task.entries.find((e) => e.target_id === target.id);
                  const changeEntry = (patch: Partial<NonNullable<typeof entry>>) => change({ entries: [...task.entries.filter((e) => e.target_id !== target.id), { target_id: target.id, poi_id: entry?.poi_id ?? target.poi_ids[0] ?? '', ...entry, ...patch }] });
                  return <div key={target.id} className="space-y-2">
                    <Field label={`${target.name}: starting material`}><select className={inputClass} value={entry?.poi_id ?? ''} onChange={(e) => changeEntry({ poi_id: e.target.value, start_url: undefined })}><option value="">Choose a starting material</option>{pois.filter((poi) => target.poi_ids.includes(poi.id)).map((poi) => <option key={poi.id} value={poi.id}>{poi.name}</option>)}</select></Field>
                    {pois.find((poi) => poi.id === entry?.poi_id)?.type === 'web' && <Field label={`${target.name}: task entry URL (optional)`}><input className={inputClass} value={entry?.start_url ?? ''} placeholder="Use the page's configured start URL" onChange={(e) => changeEntry({ start_url: e.target.value || undefined })} /></Field>}
                    <Field label={`${target.name}: test data or setup`}><input className={inputClass} value={entry?.fixture ?? ''} placeholder="For example, an existing test candidate; leave blank for public research" onChange={(e) => changeEntry({ fixture: e.target.value || undefined })} /></Field>
                  </div>;
                })}
                <Button small variant="link" disabled={study.tasks.length <= 1} onClick={() => update({ tasks: study.tasks.filter((t) => t.id !== task.id) })}>Remove task</Button>
              </fieldset>;
            })}
            <div className="flex flex-wrap gap-3">
              <Button small onClick={() => update({ tasks: [...study.tasks, { ...structuredClone(study.tasks[0]!), id: nextId('task', study.tasks), instruction: '', success_rule: '' }] })}>Add shared task</Button>
              <Button small onClick={() => update({ scenarios: [...study.scenarios, { id: nextId('scenario', study.scenarios), name: 'New scenario', context: '', segment_ids: null }] })}>Add scenario</Button>
            </div>
            <Field label="Assumptions, one per line"><textarea rows={3} className={inputClass} value={study.assumptions.join('\n')} onChange={(e) => update({ assumptions: lines(e.target.value) })} /></Field>
          </div>
        </details>
        <RecordingPanel recorder={recorder} />
        {recorder.outcome && <Note tone={recorder.outcome.ok ? 'ok' : 'error'}>{recorder.outcome.text}</Note>}
      </>}
    </div>
  </Card>;
}
