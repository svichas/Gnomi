import type { ReactNode } from 'react';
import type { ComparisonCell, ComparisonEvidence as EvidenceData } from '@gnomi/simulation/comparison/types.ts';
import { comparisonEvidenceCatalog, comparisonEvidenceKey } from '@gnomi/simulation/report/comparison.ts';

export const BASIS_LABELS = {
  observed_behavior: 'Observed task behavior',
  vendor_claim: 'Vendor claim',
  user_supplied_claim: 'User-supplied claim',
  simulated_inference: 'Simulated opinion / inference',
};

const key = comparisonEvidenceKey;
export const evidenceCatalog = (cells: ComparisonCell[]) => comparisonEvidenceCatalog(cells);
export type EvidenceCatalog = ReturnType<typeof evidenceCatalog>;

export function EvidenceLinks({ evidence, catalog }: { evidence: EvidenceData[]; catalog: EvidenceCatalog }) {
  const keys = new Set(evidence.map(key));
  const rows = catalog.filter((row) => row.captures.some((capture) => keys.has(key(capture))));
  if (!rows.length) return <span className="block text-xs text-stone-500">No supporting citation</span>;
  return <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">{rows.map((row) => (
    <a key={row.id} href={`#${row.id}`} className="text-link" onClick={() => {
      for (let element = document.getElementById(row.id); element; element = element.parentElement) if (element instanceof HTMLDetailsElement) element.open = true;
    }}>Evidence {row.id.replace('comparison-evidence-', '')}</a>
  ))}</span>;
}

export function ComparisonEvidence({ catalog, cells, targetName, criterionName, personaName, inFile, onInspect, renderScreenshot }: {
  catalog: EvidenceCatalog;
  cells: ComparisonCell[];
  targetName: (id: string) => string;
  criterionName: (id: string) => string;
  personaName: (id: string) => string;
  inFile: boolean;
  onInspect: (personaId: string, seq?: number) => void;
  renderScreenshot: (path: string, alt: string) => ReactNode;
}) {
  return <section aria-labelledby="comparison-evidence-title" className="space-y-3"><details className="report-more" open={inFile}>
    <summary><h3 id="comparison-evidence-title" className="inline text-base font-semibold text-stone-900">Evidence behind the comparison</h3><span className="ml-2 text-xs text-stone-600">{catalog.length} source claims · complete capture history</span></summary>
    {catalog.length === 0 ? <p className="text-sm text-stone-600">No validated citations were captured. Unknown criteria remain unresolved.</p> :
      <ol className="mt-3 space-y-3">{catalog.map(({ id, evidence, cell, captures }, i) => <li key={id} id={id} tabIndex={-1} className="scroll-mt-4 space-y-2 rounded-lg border border-stone-200 p-4">
        <h4 className="text-sm font-medium text-stone-900">Evidence {i + 1} · {targetName(cell.target_id)} · {criterionName(cell.criterion_id)}</h4>
        <p className="text-xs text-stone-600">{BASIS_LABELS[evidence.basis]} · {captures.length} recorded {captures.length === 1 ? 'capture' : 'captures'}. Repeated captures are not independent verification.</p>
        <p className="text-sm text-stone-900">{evidence.proposition}</p>
        <blockquote className="border-l-4 border-stone-200 pl-3 text-sm text-stone-700">“{evidence.quote}”</blockquote>
        <p className="break-all text-xs text-stone-500">Source: {evidence.source}</p>
        {evidence.screenshot && renderScreenshot(evidence.screenshot, `Evidence ${i + 1}: ${targetName(cell.target_id)}, ${criterionName(cell.criterion_id)}`)}
        <details className="report-more" open={inFile}><summary>Capture history and recorded propositions</summary><ul className="mt-2 space-y-2">{captures.map((capture) => <li key={key(capture)} className="text-xs text-stone-600">
          <p>{personaName(capture.persona_id)} · {new Date(capture.captured_at).toISOString()} · source event {capture.event_seq} · assessment {capture.assessment_seq} · episode {capture.episode_id}</p>
          <p>{capture.proposition}</p>{capture.screenshot && <p>Screenshot reference: {capture.screenshot}</p>}
          {!inFile && <button type="button" onClick={() => onInspect(capture.persona_id, capture.event_seq)} className="text-link">Inspect {personaName(capture.persona_id)}’s evidence</button>}
        </li>)}</ul></details>
      </li>)}</ol>}
    {cells.flatMap((cell) => (cell.observations ?? []).filter((observation) => !observation.evidence_seqs.length).map((observation) => <p key={observation.assessment_seq} className="mt-2 text-xs text-stone-600">{targetName(cell.target_id)} · {criterionName(cell.criterion_id)} · assessment {observation.assessment_seq} · {observation.assessment.replaceAll('_', ' ')}: {observation.summary}</p>))}
  </details></section>;
}
