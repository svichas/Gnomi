import type { ReactNode } from 'react';
import type { Report } from '@gnomi/simulation/types.ts';
import type { ComparisonAssessment, ComparisonCell, ComparisonReport as ComparisonData } from '@gnomi/simulation/comparison/types.ts';
import { BASIS_LABELS, ComparisonEvidence, EvidenceLinks, evidenceCatalog } from './ComparisonEvidence.tsx';
import { ACCESS_LABELS, ComparisonCoverage } from './ComparisonCoverage.tsx';
import { Icon } from './Icon.tsx';
import { Fold, SectionHeading, Tile } from './reportParts.tsx';
import type { Tone } from './reportParts.tsx';

const ASSESSMENTS: Record<ComparisonAssessment, { label: string; tone: Tone }> = {
  meets: { label: 'Meets', tone: 'good' }, partially_meets: { label: 'Partially meets', tone: 'warn' },
  does_not_meet: { label: 'Does not meet', tone: 'bad' }, unknown: { label: 'Unknown', tone: 'neutral' },
  not_applicable: { label: 'Not applicable', tone: 'neutral' },
};
const FITS: Record<ComparisonData['fits'][number]['status'], { label: string; tone: Tone }> = {
  supported: { label: 'Supported for this scope', tone: 'good' }, conditional: { label: 'Conditional fit', tone: 'warn' },
  not_suitable: { label: 'Does not meet a must-have', tone: 'bad' }, insufficient_evidence: { label: 'Insufficient evidence', tone: 'neutral' },
};
const DECISIONS = {
  conditional_shortlist: { label: 'Conditional shortlist', tone: 'warn' }, no_suitable_tool: { label: 'No suitable tool in this scope', tone: 'bad' },
  insufficient_evidence: { label: 'Insufficient evidence', tone: 'neutral' },
} as const satisfies Record<ComparisonData['decision']['status'], { label: string; tone: Tone }>;
const OWNER_LABELS = { product_team: 'Your product team', buyer: 'Buyer', study_owner: 'Study owner' };
const TRADEOFFS = {
  advantage: { label: 'Focal-tool advantage', tone: 'good' }, gap: { label: 'Focal-tool gap', tone: 'bad' },
  parity: { label: 'Parity', tone: 'neutral' }, unresolved: { label: 'Unresolved comparison', tone: 'neutral' },
} as const satisfies Record<string, { label: string; tone: Tone }>;

type Props = {
  comparison: ComparisonData;
  report: Report;
  inFile: boolean;
  onInspect: (personaId: string, seq?: number) => void;
  renderScreenshot: (path: string, alt: string) => ReactNode;
};

/** Labels shared by the main sections and the detail folds. */
function names({ study }: ComparisonData, report: Report) {
  const taskName = (id: string) => { const index = study.tasks.findIndex((task) => task.id === id); return index < 0 ? 'Unrecorded task' : `Task ${index + 1}`; };
  const scenarioName = (id: string) => study.scenarios.find((scenario) => scenario.id === id)?.name ?? id;
  const segmentName = (id: string | null) => report.segments.find((segment) => segment.id === id)?.name ?? (id ?? 'Unsegmented personas');
  return {
    taskName,
    targetName: (id: string) => study.targets.find((target) => target.id === id)?.name ?? id,
    criterionName: (id: string) => study.criteria.find((criterion) => criterion.id === id)?.name ?? id,
    personaName: (id: string) => report.personas.find((persona) => persona.id === id)?.name ?? id,
    scopeName: (scope: { scenario_id: string; task_id: string; segment_id: string | null }) => `${scenarioName(scope.scenario_id)} · ${segmentName(scope.segment_id)} · ${taskName(scope.task_id)}`,
  };
}

/** This component also renders every HTML/PDF export: the decision and denominators have one source. */
export function ComparisonReport({ comparison, report, inFile }: Props) {
  const { study, decision } = comparison;
  const { targetName, criterionName, scopeName } = names(comparison, report);
  const catalog = evidenceCatalog(comparison.cells);
  const groups = new Map<string, ComparisonCell[]>();
  for (const cell of comparison.cells) {
    const key = JSON.stringify([cell.scenario_id, cell.task_id, cell.segment_id, cell.access_scope]);
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  const scopes = [...new Set(study.targets.map((target) => ACCESS_LABELS[target.access_scope]))];
  const mustHaves = new Set(study.criteria.filter((criterion) => criterion.importance === 'must_have').map((criterion) => criterion.id));
  const mustCells = comparison.cells.filter((cell) => mustHaves.has(cell.criterion_id) && cell.assessment !== 'not_applicable');
  const settled = mustCells.filter((cell) => cell.assessment !== 'unknown').length;
  const isFocal = (id: string) => id === study.focal_target_id;
  return <>
    <section aria-labelledby="comparison-decision-title" className="comparison-decision">
      <div className="comparison-decision-top">
        <h3 className="report-eyebrow" id="comparison-decision-title">Decision and scope</h3>
        <span data-tone={DECISIONS[decision.status].tone} className="tone-chip">{DECISIONS[decision.status].label}</span>
      </div>
      <p className="comparison-verdict">{decision.summary}</p>
      <dl className="comparison-facts">
        <div><dt>Decision question</dt><dd>{study.question}</dd></div>
        {decision.shortlist.length > 0 && <div><dt>Conditional candidates</dt><dd>{decision.shortlist.map(targetName).join(', ')}. Check each scenario’s unresolved requirements below.</dd></div>}
        <div><dt>Scope</dt><dd>{scopes.join(' · ')} · {study.execution.mode === 'independent' ? 'Independent benchmark' : 'Buyer journey'}</dd></div>
      </dl>
      <p className="comparison-caveat">Assessments apply only to the recorded scenario, criteria and access. A visible vendor claim does not verify a live workflow.</p>
    </section>

    <section aria-label="Comparison summary" className="report-stats">
      <Tile icon="globe" tone="neutral" label="Tools compared" value={String(study.targets.length)} detail={`${decision.shortlist.length} conditional ${decision.shortlist.length === 1 ? 'candidate' : 'candidates'}`} />
      <Tile icon="check" tone={mustCells.length && settled === mustCells.length ? 'good' : 'warn'} label="Must-have checks settled" value={`${settled} of ${mustCells.length}`} detail={mustCells.length - settled ? `${mustCells.length - settled} still unknown` : 'Every must-have was assessed'} />
      <Tile icon="report" tone={catalog.length ? 'neutral' : 'warn'} label="Evidence cited" value={String(catalog.length)} detail="Distinct citations behind the matrix" />
    </section>

    <section aria-labelledby="comparison-matrix-title" className="min-w-0">
      <SectionHeading id="comparison-matrix-title" title="Side-by-side comparison" hint="Each tool faces the same criterion. Unknown means the evidence cannot settle the requirement." />
      {groups.size === 0 && <div className="report-empty"><h4>No comparison evidence yet</h4><p>No criterion observations are available. Review coverage and limitations below to see what prevented an assessment.</p></div>}
      <div className="space-y-6">{[...groups.entries()].map(([key, cells], groupIndex) => {
        const scope = cells[0];
        const task = study.tasks.find((candidate) => candidate.id === scope.task_id);
        const criteria = study.criteria.filter((criterion) => task?.criterion_ids.includes(criterion.id) || cells.some((cell) => cell.criterion_id === criterion.id));
        return <section key={key} aria-labelledby={`comparison-scope-${groupIndex}`} className="space-y-3">
          <div>
            <h4 id={`comparison-scope-${groupIndex}`} className="comparison-scope">{scopeName(scope)} · {ACCESS_LABELS[scope.access_scope]}</h4>
            {task && <p className="comparison-task">{task.instruction}</p>}
          </div>
          <div className="comparison-table-scroll" role="region" aria-label={`Comparison matrix: ${scopeName(scope)}, ${ACCESS_LABELS[scope.access_scope]}`} tabIndex={0}>
            <table className="comparison-matrix" style={{ minWidth: `${13 + study.targets.length * 12}rem` }}>
              <thead><tr><th scope="col">Shared criterion</th>{study.targets.map((target) => <th scope="col" key={target.id}>{target.name}{isFocal(target.id) && <span className="comparison-focal">Your tool</span>}</th>)}</tr></thead>
              <tbody>{criteria.map((criterion) => <tr key={criterion.id}>
                <th scope="row">
                  <span className="comparison-criterion">{criterion.name}</span>
                  <span className="comparison-importance" data-must={criterion.importance === 'must_have' || undefined}>{criterion.importance === 'must_have' ? 'Must-have' : 'Preference'}</span>
                  <details className="report-more" open={inFile}><summary>Assessment rule</summary><div className="comparison-rule"><p>{criterion.question}</p><p>{criterion.decision_rule}</p><p>Required evidence: {criterion.evidence_required}</p></div></details>
                </th>
                {study.targets.map((target) => {
                  const cell = cells.find((item) => item.target_id === target.id && item.criterion_id === criterion.id);
                  if (!cell) return <td key={target.id} className="comparison-cell" data-empty>{target.access_scope !== scope.access_scope
                    ? <><span className="tone-chip" data-tone="neutral">Different access scope</span><p className="comparison-meta">{ACCESS_LABELS[target.access_scope]}; see its separate comparison below.</p></>
                    : <><span className="tone-chip" data-tone="neutral">Unknown</span><p className="comparison-meta">No assessment recorded for this scope.</p></>}</td>;
                  return <td key={target.id} className="comparison-cell" data-tone={ASSESSMENTS[cell.assessment].tone}>
                    <span className="tone-chip" data-tone={ASSESSMENTS[cell.assessment].tone}>{ASSESSMENTS[cell.assessment].label}</span>
                    <p className="comparison-summary">{cell.summary}</p>
                    <p className="comparison-meta">{cell.bases.map((basis) => BASIS_LABELS[basis]).join('; ') || 'No supporting evidence'}</p>
                    <p className="comparison-meta tabular-nums">{cell.assessed} / {cell.eligible} eligible episodes assessed · {cell.distinct_sources} distinct {cell.distinct_sources === 1 ? 'source' : 'sources'}</p>
                    <EvidenceLinks evidence={cell.evidence} catalog={catalog} />
                    {cell.limitations.length > 0 && <ul className="comparison-limits">{cell.limitations.map((limitation, i) => <li key={i}>{limitation}</li>)}</ul>}
                  </td>;
                })}
              </tr>)}</tbody>
            </table>
          </div>
        </section>;
      })}</div>
    </section>

    <section aria-labelledby="comparison-fit-title">
      <SectionHeading id="comparison-fit-title" title="Where each tool fits" hint="Strengths, gaps and open questions per tool, within the recorded scope." />
      {comparison.tradeoffs.length > 0 && <ul className="comparison-cards mb-4" aria-label="Your tool’s advantages, gaps and parity">{comparison.tradeoffs.map((tradeoff, i) => <li key={i} className="comparison-card">
        <span className="tone-chip" data-tone={TRADEOFFS[tradeoff.result].tone}>{TRADEOFFS[tradeoff.result].label}</span>
        <h4>{criterionName(tradeoff.criterion_id)}</h4>
        <p className="comparison-meta">{targetName(tradeoff.focal_target_id)} versus {targetName(tradeoff.other_target_id)} · {scopeName(tradeoff)}</p>
        <p>{tradeoff.summary}</p>
        <EvidenceLinks evidence={catalog.filter(({ evidence }) => tradeoff.evidence_seqs.includes(evidence.event_seq)).map(({ evidence }) => evidence)} catalog={catalog} />
      </li>)}</ul>}
      {comparison.fits.length === 0 && <p className="report-empty">No supported fit assessment is available yet.</p>}
      <ul className="comparison-cards">{comparison.fits.map((fit, i) => {
        const cells = comparison.cells.filter((cell) => cell.target_id === fit.target_id && cell.scenario_id === fit.scenario_id && cell.task_id === fit.task_id && cell.segment_id === fit.segment_id);
        const lists = ([['Strengths', fit.strengths, 'good'], ['Gaps', fit.gaps, 'bad'], ['Unresolved requirements', fit.unknowns, 'neutral']] as const).filter(([, values]) => values.length);
        return <li key={i} className="comparison-card" data-tone={FITS[fit.status].tone}>
          <h4>{targetName(fit.target_id)}{isFocal(fit.target_id) && ' (your tool)'}</h4>
          <span className="tone-chip" data-tone={FITS[fit.status].tone}>{FITS[fit.status].label}</span>
          <p className="comparison-meta">{scopeName(fit)}</p>
          {lists.length > 0 && <dl className="comparison-fit-lists">{lists.map(([label, values, tone]) => <div key={label}><dt><span className="tone-dot" data-tone={tone} />{label}</dt><dd><ul>{values.map((value, j) => <li key={j}>{value}</li>)}</ul></dd></div>)}</dl>}
          <EvidenceLinks evidence={cells.flatMap((cell) => cell.evidence)} catalog={catalog} />
        </li>;
      })}</ul>
    </section>

    <section aria-labelledby="comparison-actions-title">
      <SectionHeading id="comparison-actions-title" title={study.purpose === 'improve_own_product' ? 'Actions for your product and evaluation' : 'Next checks before choosing'} hint="What would settle the open questions. Each benefit is a hypothesis to validate." />
      {comparison.actions.length === 0 && <p className="report-empty">No supported action was generated. Resolve the unknown must-haves in the matrix before making a selection.</p>}
      {comparison.actions.length > 0 && <ol className="report-finding-list">{comparison.actions.map((action, i) => <li key={i} className="comparison-action">
        <span className="report-finding-number" data-tone="neutral">{String(i + 1).padStart(2, '0')}</span>
        <div className="comparison-action-copy">
          <h4>{action.action}</h4>
          <p className="comparison-meta">{OWNER_LABELS[action.owner]} · {targetName(action.target_id)} · {scopeName(action)}</p>
          <p>{action.rationale}</p>
          <div className="report-suggestion"><Icon name="spark" size={16} /><div>
            <h5>Expected benefit (hypothesis)</h5><p>{action.expected_benefit}</p>
            <p className="report-suggestion-how"><strong>Validate:</strong> {action.validation}</p>
          </div></div>
          <EvidenceLinks evidence={catalog.filter(({ evidence }) => action.evidence_seqs.includes(evidence.event_seq) || action.evidence_seqs.includes(evidence.assessment_seq)).map(({ evidence }) => evidence)} catalog={catalog} />
        </div>
      </li>)}</ol>}
    </section>
  </>;
}

/** Coverage and citations, folded into the report's details like the other secondary sections. */
export function ComparisonDetails({ comparison, report, inFile, onInspect, renderScreenshot }: Props) {
  const { targetName, criterionName, personaName, scopeName, taskName } = names(comparison, report);
  const catalog = evidenceCatalog(comparison.cells);
  return <>
    <Fold id="comparison-coverage-title" title="Coverage and limitations" hint="Attempts, outcomes and what the comparison cannot show" icon="activity">
      <ComparisonCoverage comparison={comparison} targetName={targetName} scopeName={scopeName} personaName={personaName} taskName={taskName} inFile={inFile} />
    </Fold>
    <Fold id="comparison-evidence-title" title={`Evidence behind the comparison (${catalog.length})`} hint="Every citation, with its source, quote and screenshot" icon="report">
      <ComparisonEvidence catalog={catalog} targetName={targetName} criterionName={criterionName} personaName={personaName} inFile={inFile} onInspect={onInspect} renderScreenshot={renderScreenshot} />
    </Fold>
  </>;
}
