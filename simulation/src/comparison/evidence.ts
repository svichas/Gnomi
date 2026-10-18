import type { EventOf } from '../types.ts';
import type { ComparisonCriterion } from './types.ts';

type Source = EventOf<'comparison.source'>;
const STOP = new Set('about after against also applicable captured claim claims criterion does each evidence explicit from have information into meets missing only observed other pricingterms relevant required requirements same scenario should source stated support supports that their there these this unknown using visible what when where which with without'.split(' '));
const terms = (criterion: ComparisonCriterion) => [...new Set(`${criterion.name} ${criterion.question} ${criterion.evidence_required} ${criterion.decision_rule}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((word) => !STOP.has(word));
const score = (text: string, words: string[]) => words.reduce((n, word) => n + (text.includes(word) ? 1 : 0), 0);

/** Keep criterion matches from multiple sources (including disagreement), plus endpoint state and separate action proof. */
export function criterionSources(sources: Source[], criteria: ComparisonCriterion[]): Source[] {
  const content = sources.filter((source) => source.payload.kind !== 'action');
  const selected = new Set<Source>();
  if (content[0]) selected.add(content[0]);
  if (content.at(-1)) selected.add(content.at(-1)!);
  const rankings = criteria.map((criterion) => {
    const words = terms(criterion);
    return content.map((source) => ({ source, score: score(source.payload.text.toLowerCase(), words) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.source.seq - b.source.seq);
  });
  // Round robin gives every criterion a first source before allocating corroboration or conflicting sources.
  for (let position = 0; position < 2; position++) for (const ranking of rankings) if (selected.size < 24 && ranking[position]) selected.add(ranking[position].source);
  for (let index = 0; selected.size < Math.min(24, content.length) && index < content.length; index++) selected.add(content[Math.round(index * (content.length - 1) / Math.max(1, Math.min(24, content.length) - 1))]);
  // Action/results do not evict all substantive pages. Preserve the final action for last-step success proof.
  return [...selected, ...sources.filter((source) => source.payload.kind === 'action').slice(-8)].sort((a, b) => a.seq - b.seq);
}

/** Exact excerpts with local context; markers disclose omitted text and cannot become source quotations. */
export function criterionExcerpt(text: string, limit: number, criteria: ComparisonCriterion[]): string {
  if (text.length <= limit) return text;
  const lower = text.toLowerCase();
  const separator = '\n[excerpt gap; uncited content omitted]\n';
  const matches = criteria.map((criterion) => terms(criterion).flatMap((word) => {
      const first = lower.indexOf(word), last = lower.lastIndexOf(word);
      return first < 0 ? [] : [first, last].map((position) => ({ position, length: word.length }));
    }).sort((a, b) => a.position - b.position));
  const anchors = new Map<number, number>();
  // Preserve a useful claim-sized window per selected match. Give each criterion a first match before
  // adding alternatives; hundreds of tiny prefix slices would omit the very words that selected them.
  const maxWindows = Math.max(1, Math.floor((limit + separator.length) / (96 + separator.length)));
  for (let index = 0; index < 6; index++) for (const criterion of matches) {
    const match = criterion[index];
    if (match && anchors.size < maxWindows) anchors.set(match.position, Math.max(match.length, anchors.get(match.position) ?? 0));
  }
  if (anchors.size < maxWindows) anchors.set(0, 0);
  if (anchors.size < maxWindows) anchors.set(text.length - 1, 1);
  const allowance = Math.floor((limit - separator.length * (anchors.size - 1)) / anchors.size);
  const windows = [...anchors].sort(([a], [b]) => a - b).map(([position, length]) => {
    const before = Math.max(0, Math.floor((allowance - length) / 3));
    const start = Math.min(Math.max(0, position - before), Math.max(0, text.length - allowance));
    return { start, end: Math.min(text.length, start + allowance) };
  });
  const merged: { start: number; end: number }[] = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else merged.push(window);
  }
  return merged.map((window) => text.slice(window.start, window.end)).join(separator);
}
