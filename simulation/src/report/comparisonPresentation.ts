import type { ComparisonCell, ComparisonEvidence } from '../comparison/types.ts';

export const comparisonEvidenceKey = (item: ComparisonEvidence) => JSON.stringify([item.assessment_seq, item.event_seq, item.source, item.quote]);
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** One displayed source/criterion claim, retaining every capture and original proposition for audit. */
export function comparisonEvidenceCatalog(cells: ComparisonCell[]) {
  const catalog = new Map<string, { id: string; evidence: ComparisonEvidence; cell: ComparisonCell; captures: ComparisonEvidence[] }>();
  for (const cell of cells) for (const evidence of cell.evidence) {
    const claim = JSON.stringify([cell.target_id, cell.scenario_id, cell.task_id, cell.criterion_id, cell.assessment, evidence.source, normalize(evidence.quote), evidence.basis]);
    const existing = catalog.get(claim);
    if (existing) {
      if (!existing.captures.some((capture) => comparisonEvidenceKey(capture) === comparisonEvidenceKey(evidence))) existing.captures.push(evidence);
    } else catalog.set(claim, { id: `comparison-evidence-${catalog.size + 1}`, evidence, cell, captures: [evidence] });
  }
  return [...catalog.values()];
}

export const comparisonDecisionLabels = {
  leading_candidate: 'Leading candidate for this scenario', parity: 'Supported parity', conditional_shortlist: 'Conditional shortlist',
  no_suitable_tool: 'No suitable tool in this scope', insufficient_evidence: 'Insufficient evidence',
};
