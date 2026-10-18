import type { ComparisonReport } from '@gnomi/simulation/comparison/types.ts';
import { comparisonDecisionLabels } from '@gnomi/simulation/report/comparison.ts';
import { EvidenceLinks, type EvidenceCatalog } from './ComparisonEvidence.tsx';

export function ComparisonDecision({ comparison, catalog, targetName, segmentName, inFile }: {
  comparison: ComparisonReport; catalog: EvidenceCatalog; targetName: (id: string) => string; segmentName: (id: string | null) => string; inFile: boolean;
}) {
  const { study, decision } = comparison;
  const shared = study.execution.collection === 'shared_research';
  const citations = (seqs: number[]) => catalog.flatMap((row) => row.captures.filter((capture) => seqs.includes(capture.event_seq)));
  return <div className="space-y-4">
    {(decision.scenarios ?? []).map((scenario) => <section key={JSON.stringify([scenario.scenario_id, scenario.segment_id])} className="space-y-3 border-l-2 border-stone-200 pl-4">
      <h4 className="text-sm font-medium text-stone-900">{study.scenarios.find((item) => item.id === scenario.scenario_id)?.name} · {shared ? 'Company requirements' : segmentName(scenario.segment_id)}</h4>
      {(decision.scenarios?.length ?? 0) > 1 && <><p className="text-xs font-medium text-stone-600">{comparisonDecisionLabels[scenario.status]}</p><p className="text-sm text-stone-900">{scenario.summary}</p></>}
      {scenario.reasons.length > 0 && <div className="space-y-2"><p className="text-sm font-medium text-stone-900">Why this conclusion</p><ul className="list-disc space-y-2 pl-5 text-sm text-stone-700">{scenario.reasons.map((reason, i) => <li key={i}>{reason.text}<EvidenceLinks evidence={citations(reason.evidence_seqs)} catalog={catalog} /></li>)}</ul></div>}
      {scenario.alternatives.length > 0 && <div className="space-y-2"><p className="text-sm font-medium text-stone-900">Selection conditions</p><ul className="space-y-2 text-sm text-stone-700">{scenario.alternatives.map((alternative) => <li key={alternative.target_id}><span className="font-medium">{targetName(alternative.target_id)}:</span> {alternative.condition}<EvidenceLinks evidence={citations(alternative.evidence_seqs)} catalog={catalog} /></li>)}</ul></div>}
      {scenario.unresolved.length > 0 && <details className="report-more" open={inFile}><summary>{scenario.unresolved.length} unresolved requirement{scenario.unresolved.length === 1 ? '' : 's'} that could change the choice</summary><ul className="mt-2 space-y-3 text-sm text-stone-700">{scenario.unresolved.map((item) => <li key={item.criterion_id}><p>{item.summary}</p><p className="mt-1 font-medium">What would change the choice: {item.changes_choice}</p></li>)}</ul></details>}
    </section>)}
    {study.decision_context && <details className="report-more" open={inFile}><summary>Company decision brief</summary><dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">{[
      ['Company size', study.decision_context.company_size], ['Hiring volume', study.decision_context.hiring_volume], ['Budget', study.decision_context.budget],
      ['Required integrations', study.decision_context.required_integrations.join(', ')], ['Must-have requirements', study.decision_context.requirements.join('; ')], ['Switching constraints', study.decision_context.switching_constraints],
    ].map(([label, value]) => <div key={label}><dt className="font-medium text-stone-900">{label}</dt><dd className="text-stone-700">{value || 'Unspecified; remains unknown'}</dd></div>)}</dl></details>}
  </div>;
}
