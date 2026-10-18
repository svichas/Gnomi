import type { ReactNode } from 'react';
import type { Report } from '@gnomi/simulation/types.ts';
import type { ComparisonAssessment, ComparisonCell, ComparisonReport as ComparisonData } from '@gnomi/simulation/comparison/types.ts';
import { BASIS_LABELS, ComparisonEvidence, EvidenceLinks, evidenceCatalog } from './ComparisonEvidence.tsx';
import { ACCESS_LABELS, ComparisonCoverage } from './ComparisonCoverage.tsx';

const ASSESSMENTS: Record<ComparisonAssessment, { label: string; tone: string }> = {
  meets: { label: 'Meets', tone: 'good' }, partially_meets: { label: 'Partially meets', tone: 'warn' },
  does_not_meet: { label: 'Does not meet', tone: 'bad' }, unknown: { label: 'Unknown', tone: 'neutral' },
  not_applicable: { label: 'Not applicable', tone: 'neutral' },
};
const FIT_LABELS = { supported: 'Supported for this scope', conditional: 'Conditional fit', not_suitable: 'Does not meet a must-have', insufficient_evidence: 'Insufficient evidence' };
const OWNER_LABELS = { product_team: 'Your product team', buyer: 'Buyer', study_owner: 'Study owner' };
const TRADEOFF_LABELS = { advantage: 'Focal-tool advantage', gap: 'Focal-tool gap', parity: 'Parity', unresolved: 'Unresolved comparison' };
const heading = 'text-base font-semibold text-stone-900';

/** This component also renders every HTML/PDF export: the decision and denominators have one source. */
export function ComparisonReport({ comparison, report, inFile, onInspect, renderScreenshot }: {
  comparison: ComparisonData;
  report: Report;
  inFile: boolean;
  onInspect: (personaId: string, seq?: number) => void;
  renderScreenshot: (path: string, alt: string) => ReactNode;
}) {
  const { study } = comparison;
  const targetName = (id: string) => study.targets.find((target) => target.id === id)?.name ?? id;
  const criterionName = (id: string) => study.criteria.find((criterion) => criterion.id === id)?.name ?? id;
  const personaName = (id: string) => report.personas.find((persona) => persona.id === id)?.name ?? id;
  const taskName = (id: string) => { const index = study.tasks.findIndex((task) => task.id === id); return index < 0 ? 'Unrecorded task' : `Task ${index + 1}`; };
  const scenarioName = (id: string) => study.scenarios.find((scenario) => scenario.id === id)?.name ?? id;
  const segmentName = (id: string | null) => report.segments.find((segment) => segment.id === id)?.name ?? (id ?? 'Unsegmented personas');
  const scopeName = (scope: { scenario_id: string; task_id: string; segment_id: string | null }) => `${scenarioName(scope.scenario_id)} · ${segmentName(scope.segment_id)} · ${taskName(scope.task_id)}`;
  const catalog = evidenceCatalog(comparison.cells);
  const groups = new Map<string, ComparisonCell[]>();
  for (const cell of comparison.cells) {
    const key = JSON.stringify([cell.scenario_id, cell.task_id, cell.segment_id, cell.access_scope]);
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  const scopes = [...new Set(study.targets.map((target) => ACCESS_LABELS[target.access_scope]))];
  return <>
    <section aria-labelledby="comparison-decision-title" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="comparison-decision-title" className={heading}>Decision and scope</h3>
        <span data-tone={comparison.decision.status === 'conditional_shortlist' ? 'warn' : 'neutral'} className="tone-chip">{comparison.decision.status === 'conditional_shortlist' ? 'Conditional shortlist' : comparison.decision.status === 'no_suitable_tool' ? 'No suitable tool in this scope' : 'Insufficient evidence'}</span>
      </div>
      <p className="text-base font-medium text-stone-900">{comparison.decision.summary}</p>
      <p className="text-sm text-stone-600">{scopes.join(' · ')} · {study.execution.mode === 'independent' ? 'Independent benchmark' : 'Buyer journey'}</p>
      <p className="text-sm text-stone-700"><span className="font-medium">Decision question:</span> {study.question}</p>
      {comparison.decision.shortlist.length > 0 && <p className="text-sm text-stone-700"><span className="font-medium">Conditional candidates:</span> {comparison.decision.shortlist.map(targetName).join(', ')}. Check each scenario’s unresolved requirements below.</p>}
      <p className="text-xs text-stone-600">Assessments apply only to the recorded scenario, criteria and access. A visible vendor claim does not verify a live workflow.</p>
    </section>

    <section aria-labelledby="comparison-matrix-title" className="min-w-0 space-y-5">
      <div className="space-y-1">
        <h3 id="comparison-matrix-title" className={heading}>Side-by-side comparison</h3>
        <p className="text-sm text-stone-600">Each target faces the same criterion. Coverage counts assessed persona/task episodes; distinct sources are counted separately. Unknown means the evidence cannot settle the requirement.</p>
        <p className="text-xs text-stone-600 print:hidden">On narrow screens, scroll the table horizontally to compare every tool.</p>
      </div>
      {groups.size === 0 && <p className="text-sm text-stone-600">No criterion observations are available yet. The decision remains unresolved.</p>}
      {[...groups.entries()].map(([key, cells], groupIndex) => {
        const scope = cells[0];
        const task = study.tasks.find((candidate) => candidate.id === scope.task_id);
        const criteria = study.criteria.filter((criterion) => task?.criterion_ids.includes(criterion.id) || cells.some((cell) => cell.criterion_id === criterion.id));
        return <section key={key} aria-labelledby={`comparison-scope-${groupIndex}`} className="space-y-2">
          <h4 id={`comparison-scope-${groupIndex}`} className="text-sm font-medium text-stone-900">{scopeName(scope)} · {ACCESS_LABELS[scope.access_scope]}</h4>
          {task && <p className="text-sm text-stone-600">{task.instruction}</p>}
          <div className="overflow-x-auto rounded-lg border border-stone-200" role="region" aria-label={`Comparison matrix: ${scopeName(scope)}, ${ACCESS_LABELS[scope.access_scope]}`} tabIndex={0}>
            <table className="comparison-matrix w-full table-fixed text-left text-sm" style={{ minWidth: `${12 + study.targets.length * 11}rem` }}>
              <thead className="bg-stone-50"><tr><th scope="col" className="w-48 p-3 text-xs font-medium text-stone-600">Shared criterion</th>{study.targets.map((target) => <th scope="col" key={target.id} className="p-3 align-top font-medium text-stone-900">{target.name}{target.id === study.focal_target_id && <span className="block text-xs font-normal text-stone-600">Your tool</span>}</th>)}</tr></thead>
              <tbody className="divide-y divide-stone-200">{criteria.map((criterion) => <tr key={criterion.id}>
                <th scope="row" className="space-y-1 p-3 align-top font-normal"><span className="font-medium text-stone-900">{criterion.name}</span><span className="block text-xs text-stone-600">{criterion.importance === 'must_have' ? 'Must-have' : 'Preference'}</span><span className="block text-xs text-stone-600">{criterion.question}</span><details className="report-more" open={inFile}><summary>Assessment rule</summary><div className="mt-2 space-y-1 text-xs text-stone-600"><p>{criterion.decision_rule}</p><p>Required evidence: {criterion.evidence_required}</p></div></details></th>
                {study.targets.map((target) => {
                  const cell = cells.find((item) => item.target_id === target.id && item.criterion_id === criterion.id);
                  if (!cell) return <td key={target.id} className="p-3 align-top text-stone-600">{target.access_scope !== scope.access_scope ? <><span className="font-medium">Different access scope</span><p className="mt-1 text-xs">{ACCESS_LABELS[target.access_scope]}; see its separate comparison below.</p></> : <><span className="font-medium">Unknown</span><p className="mt-1 text-xs">No assessment recorded for this scope.</p></>}</td>;
                  return <td key={target.id} className="space-y-2 p-3 align-top">
                    <span className="tone-chip" data-tone={ASSESSMENTS[cell.assessment].tone}>{ASSESSMENTS[cell.assessment].label}</span>
                    <p className="text-stone-900">{cell.summary}</p>
                    <p className="text-xs text-stone-600"><span className="font-medium">Basis:</span> {cell.bases.map((basis) => BASIS_LABELS[basis]).join('; ') || 'No supporting evidence'}</p>
                    <p className="text-xs tabular-nums text-stone-600">{cell.assessed} / {cell.eligible} eligible episodes assessed · {cell.distinct_sources} distinct {cell.distinct_sources === 1 ? 'source' : 'sources'}</p>
                    <EvidenceLinks evidence={cell.evidence} catalog={catalog} />
                    {cell.limitations.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-stone-600">{cell.limitations.map((limitation, i) => <li key={i}>{limitation}</li>)}</ul>}
                  </td>;
                })}
              </tr>)}</tbody>
            </table>
          </div>
        </section>;
      })}
    </section>

    <section aria-labelledby="comparison-fit-title" className="space-y-3">
      <h3 id="comparison-fit-title" className={heading}>Where each tool fits</h3>
      {comparison.tradeoffs.length > 0 && <ul className="space-y-3" aria-label="Your tool’s advantages, gaps and parity">{comparison.tradeoffs.map((tradeoff, i) => <li key={i} className="space-y-1 rounded-lg bg-stone-50 p-3 text-sm">
        <h4 className="font-medium text-stone-900">{TRADEOFF_LABELS[tradeoff.result]} · {criterionName(tradeoff.criterion_id)}</h4>
        <p className="text-xs text-stone-600">{targetName(tradeoff.focal_target_id)} versus {targetName(tradeoff.other_target_id)} · {scopeName(tradeoff)}</p>
        <p className="text-stone-700">{tradeoff.summary}</p>
        <EvidenceLinks evidence={catalog.filter(({ evidence }) => tradeoff.evidence_seqs.includes(evidence.event_seq)).map(({ evidence }) => evidence)} catalog={catalog} />
      </li>)}</ul>}
      {comparison.fits.length === 0 && <p className="text-sm text-stone-600">No supported fit assessment is available yet.</p>}
      <ul className="divide-y divide-stone-200">{comparison.fits.map((fit, i) => {
        const cells = comparison.cells.filter((cell) => cell.target_id === fit.target_id && cell.scenario_id === fit.scenario_id && cell.task_id === fit.task_id && cell.segment_id === fit.segment_id);
        return <li key={i} className="space-y-2 py-3">
          <h4 className="text-sm font-medium text-stone-900">{targetName(fit.target_id)}{fit.target_id === study.focal_target_id && ' (your tool)'} · {FIT_LABELS[fit.status]}</h4>
          <p className="text-xs text-stone-600">{scopeName(fit)}</p>
          <dl className="space-y-2 text-sm">{([
            ['Strengths', fit.strengths, 'No supported strength recorded.'], ['Gaps', fit.gaps, 'No supported mismatch recorded.'], ['Unresolved requirements', fit.unknowns, 'None recorded in this scope.'],
          ] as const).map(([label, values, empty]) => <div key={label}><dt className="font-medium text-stone-900">{label}</dt><dd className="text-stone-700">{values.length ? <ul className="list-disc pl-5">{values.map((value, j) => <li key={j}>{value}</li>)}</ul> : empty}</dd></div>)}</dl>
          <EvidenceLinks evidence={cells.flatMap((cell) => cell.evidence)} catalog={catalog} />
        </li>;
      })}</ul>
    </section>

    <section aria-labelledby="comparison-actions-title" className="space-y-3">
      <h3 id="comparison-actions-title" className={heading}>{study.purpose === 'improve_own_product' ? 'Actions for your product and evaluation' : 'Next checks before choosing'}</h3>
      {comparison.actions.length === 0 && <p className="text-sm text-stone-600">No supported action was generated. Resolve the unknown must-haves in the matrix before making a selection.</p>}
      <ol className="list-decimal space-y-4 pl-5">{comparison.actions.map((action, i) => <li key={i} className="space-y-1 pl-1 text-sm">
        <h4 className="font-medium text-stone-900">{action.action}</h4>
        <p className="text-xs text-stone-600">{OWNER_LABELS[action.owner]} · {targetName(action.target_id)} · {scopeName(action)}</p>
        <p className="text-stone-700">{action.rationale}</p>
        <p className="text-stone-700"><span className="font-medium">Expected benefit (hypothesis):</span> {action.expected_benefit}</p>
        <p className="text-stone-700"><span className="font-medium">Validate:</span> {action.validation}</p>
        <EvidenceLinks evidence={catalog.filter(({ evidence }) => action.evidence_seqs.includes(evidence.event_seq) || action.evidence_seqs.includes(evidence.assessment_seq)).map(({ evidence }) => evidence)} catalog={catalog} />
      </li>)}</ol>
    </section>

    <ComparisonCoverage comparison={comparison} targetName={targetName} scopeName={scopeName} personaName={personaName} taskName={taskName} inFile={inFile} />
    <ComparisonEvidence catalog={catalog} targetName={targetName} criterionName={criterionName} personaName={personaName} inFile={inFile} onInspect={onInspect} renderScreenshot={renderScreenshot} />
  </>;
}
