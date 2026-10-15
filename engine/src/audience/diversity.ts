// The homogeneity guard (tech.md §6.6): TF-IDF cosine over backgrounds, no embeddings, plus duplicate names.
import type { DiversityReport, Persona } from '../types.ts';
import { nameKey } from './write.ts';

// From diversity.test.ts: varied personas pair at most 0.11 (the templated demo writer up to 0.83) and average 0.04–0.18;
// a near-copy with three words swapped scores 0.90, and one template filled in eight ways averages 0.52.
const MAX_SIMILARITY = 0.85;
export const MEAN_SIMILARITY = 0.3;

const STOPWORDS = new Set(
  ('a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing ' +
    'don down during each even every few for from further get got had has have having he her here hers herself him himself his how i if in into is ' +
    'it its itself just ll me more most much my myself no nor not now of off on once one only or other our ours out over own re same she should so ' +
    'some still such than that the their theirs them then there these they this those through to too under until up us ve very was we were what ' +
    'when where which while who whom why will with would you your yours').split(' '),
);

function vector(text: string, idf: (term: string) => number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) if (t.length > 1 && !STOPWORDS.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [t, c] of counts) counts.set(t, c * idf(t));
  const norm = Math.hypot(...counts.values());
  for (const [t, w] of counts) counts.set(t, w / norm);
  return counts;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size > b.size) [a, b] = [b, a];
  let dot = 0;
  for (const [t, w] of a) dot += w * (b.get(t) ?? 0);
  return Math.min(1, dot);
}

/** Mean and highest pairwise TF-IDF cosine over texts, with the indices of the most similar pair (tech.md §6.6). Pure. */
export function similarity(texts: string[]): { mean: number; max: number; most: [number, number] | null } {
  const terms = texts.map((text) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []));
  const df = new Map<string, number>();
  for (const set of terms) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const n = texts.length;
  // Smoothed idf: a word every text shares still counts, so two near-copies cannot cancel out.
  const vectors = texts.map((text) => vector(text, (t) => Math.log((1 + n) / (1 + (df.get(t) ?? 0))) + 1));

  let sum = 0;
  let max = 0;
  let most: [number, number] | null = null;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const s = cosine(vectors[i], vectors[j]);
      sum += s;
      if (most === null || s > max) [max, most] = [s, [i, j]];
    }
  return { mean: n > 1 ? sum / ((n * (n - 1)) / 2) : 0, max, most };
}

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
