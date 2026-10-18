// Pairwise TF-IDF cosine over texts (tech.md §6.6): the homogeneity measure the spread report and the audience guard share.
// From diversity.test.ts: varied personas pair at most 0.11 and average 0.04–0.18; one template filled in eight ways averages 0.52.
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
