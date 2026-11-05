import type { ReactNode } from 'react';
import type { ComparisonCell, ComparisonEvidence as EvidenceData } from '@gnomi/simulation/comparison/types.ts';

export const BASIS_LABELS = {
  observed_behavior: 'Observed task behavior',
  vendor_claim: 'Vendor claim',
  user_supplied_claim: 'User-supplied claim',
  simulated_inference: 'Simulated opinion / inference',
};

const key = (evidence: EvidenceData) => JSON.stringify([evidence.assessment_seq, evidence.event_seq, evidence.source, evidence.quote]);
export function evidenceCatalog(cells: ComparisonCell[]) {
  const catalog = new Map<string, { id: string; evidence: EvidenceData; cell: ComparisonCell }>();
  for (const cell of cells) for (const evidence of cell.evidence) {
    if (!catalog.has(key(evidence))) catalog.set(key(evidence), { id: `comparison-evidence-${catalog.size + 1}`, evidence, cell });
  }
  return [...catalog.values()];
}
export type EvidenceCatalog = ReturnType<typeof evidenceCatalog>;

export function EvidenceLinks({ evidence, catalog }: { evidence: EvidenceData[]; catalog: EvidenceCatalog }) {
  const keys = new Set(evidence.map(key));
  const rows = catalog.filter((row) => keys.has(key(row.evidence)));
  if (!rows.length) return null; // the verdict or summary beside it already says nothing was cited
  return <span className="comparison-cites">{rows.map((row) => (
    <a key={row.id} href={`#${row.id}`} className="text-link">Evidence {row.id.replace('comparison-evidence-', '')}</a>
  ))}</span>;
}

export function ComparisonEvidence({ catalog, targetName, criterionName, personaName, inFile, onInspect, renderScreenshot }: {
  catalog: EvidenceCatalog;
  targetName: (id: string) => string;
  criterionName: (id: string) => string;
  personaName: (id: string) => string;
  inFile: boolean;
  onInspect: (personaId: string, seq?: number) => void;
  renderScreenshot: (path: string, alt: string) => ReactNode;
}) {
  return <>
    {catalog.length === 0 ? <p className="text-sm text-stone-600">No validated citations were captured. Unknown criteria remain unresolved.</p> :
      <ol className="space-y-3">{catalog.map(({ id, evidence, cell }, i) => <li key={id} id={id} tabIndex={-1} className="comparison-evidence">
        <h4 className="text-sm font-medium text-stone-900">Evidence {i + 1} · {targetName(cell.target_id)} · {criterionName(cell.criterion_id)}</h4>
        <p className="text-xs text-stone-600">{BASIS_LABELS[evidence.basis]} · {personaName(evidence.persona_id)} · captured {new Date(evidence.captured_at).toISOString()} · event {evidence.event_seq}</p>
        <p className="text-sm text-stone-900">{evidence.proposition}</p>
        <blockquote className="border-l-4 border-stone-200 pl-3 text-sm text-stone-700">“{evidence.quote}”</blockquote>
        <p className="break-all text-xs text-stone-500">Source: {evidence.source}</p>
        {evidence.screenshot && renderScreenshot(evidence.screenshot, `Evidence ${i + 1}: ${targetName(cell.target_id)}, ${criterionName(cell.criterion_id)}`)}
        {!inFile && <button type="button" onClick={() => onInspect(evidence.persona_id, evidence.event_seq)} className="text-link">Inspect {personaName(evidence.persona_id)}’s evidence</button>}
      </li>)}</ol>}
  </>;
}
