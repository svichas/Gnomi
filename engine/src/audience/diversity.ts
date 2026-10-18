// The homogeneity guard (tech.md §6.6): TF-IDF cosine over backgrounds, no embeddings, plus duplicate names.
import type { DiversityReport, Persona } from '@gnomi/simulation/types.ts';
import { MEAN_SIMILARITY, similarity } from '@gnomi/simulation/report/similarity.ts';
import { nameKey } from './write.ts';

// From diversity.test.ts: varied personas pair at most 0.11 (the templated demo writer up to 0.83) and average 0.04–0.18;
// a near-copy with three words swapped scores 0.90, and one template filled in eight ways averages 0.52.
const MAX_SIMILARITY = 0.85;

/** Pairwise TF-IDF cosine over backgrounds plus duplicate names (tech.md §6.6). Pure. */
export function diversityReport(personas: Persona[]): DiversityReport {
  const { mean, max, most: pair } = similarity(personas.map((p) => p.background));
  const most: [string, string] | null = pair && [personas[pair[0]].id, personas[pair[1]].id];

  const byName = new Map<string, string[]>();
  for (const p of personas) byName.set(nameKey(p.name), [...(byName.get(nameKey(p.name)) ?? []), p.name.trim()]);
  const duplicate_names = [...byName.values()].filter((names) => names.length > 1).map(([first]) => first);

  const nameOf = (id: string) => personas.find((p) => p.id === id)?.name ?? id;
  const problems = [
    duplicate_names.length ? `${duplicate_names.length === 1 ? 'one name is' : `${duplicate_names.length} names are`} used more than once (${duplicate_names.join(', ')})` : null,
    most && max >= MAX_SIMILARITY ? `${nameOf(most[0])} and ${nameOf(most[1])} have near-identical backgrounds (similarity ${max.toFixed(2)})` : null,
    mean >= MEAN_SIMILARITY ? `backgrounds read alike across the population (mean similarity ${mean.toFixed(2)})` : null,
  ].filter((p) => p !== null);
  const warning = problems.length
    ? `${problems.join('; ').replace(/^./, (c) => c.toUpperCase())}. Regenerate the personas concerned, or widen the segments' ranges.`
    : null;

  return { mean_similarity: mean, max_similarity: max, most_similar: most, duplicate_names, warning };
}
