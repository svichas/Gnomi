import { isTimelineHighlight } from './activity.ts';
import type { Row } from './activity.ts';

export interface ActivityMoment {
  key: string;
  row: Row;
  related: Row[];
  latestSeq: number;
}

// Only evidence about one action belongs together. A later resume, outcome or
// opinion is a new moment, even when it refers to the same step number.
const STEP_CONTEXT = new Set([
  'persona.step', 'persona.friction_reported', 'signal.failed_action', 'signal.loop',
  'signal.backtrack', 'signal.error', 'signal.validation_error', 'signal.small_target',
]);

function priority(row: Row): number {
  if (row.tone === 'alarm') return 6;
  if (row.badge?.ok === false || row.tone === 'bad') return 5;
  if (row.tone === 'friction') return 4;
  if (row.source?.type.startsWith('signal.')) return 3;
  if (row.source?.type === 'persona.step') return 2;
  return 1;
}

/** One thought and its action/evidence read as one moment, even with concurrent people. */
export function activityMoments(rows: Row[], allEvents = false): ActivityMoment[] {
  const moments = new Map<string, ActivityMoment>();
  for (const row of rows) {
    if (!allEvents && !isTimelineHighlight(row)) continue;
    const source = row.source;
    const grouped = !allEvents && row.persona_id !== null && source?.poi_id != null && source.step !== undefined && STEP_CONTEXT.has(source.type);
    const key = grouped ? JSON.stringify([row.persona_id, source.poi_id, source.round, source.step]) : `event-${row.seq}`;
    const existing = moments.get(key);
    if (existing) {
      existing.related.push(row);
      existing.latestSeq = Math.max(existing.latestSeq, row.seq);
      if (priority(row) > priority(existing.row)) existing.row = row;
    } else moments.set(key, { key, row, related: [row], latestSeq: row.seq });
  }
  return [...moments.values()].map((moment) => ({ ...moment, related: moment.related.sort((a, b) => a.seq - b.seq) }))
    .sort((a, b) => b.latestSeq - a.latestSeq);
}

export function momentKind(row: Row): string {
  if (row.tone === 'alarm') return 'Safety stop';
  if (row.badge?.ok === false) return 'Action failed';
  if (row.tone === 'friction') return 'Friction';
  if (row.source?.type === 'persona.blocked') return 'Needs help';
  if (row.source?.type === 'persona.goal_done') return 'Goal reached';
  if (row.source?.type === 'persona.abandoned') return 'Gave up';
  if (row.source?.type === 'persona.survey') return 'Final feedback';
  if (row.source?.type === 'persona.opinion_changed') return 'Opinion changed';
  if (row.source?.type === 'persona.step') return 'Exploring';
  if (row.source?.type.startsWith('signal.')) return 'Observation';
  if (row.label === 'Post' || row.label === 'Reply') return 'Shared feedback';
  return row.tone === 'bad' ? 'Issue' : row.label;
}

/** A paused snapshot also notices updates to aggregated rows such as blocked requests. */
export function pendingActivityCount(current: Row[], frozen: Row[]): number {
  const previous = new Map(frozen.map((row) => [row.seq, row]));
  return current.reduce((count, row) => {
    const before = previous.get(row.seq);
    return count + (!before || before.title !== row.title || before.detail !== row.detail || before.quote !== row.quote || before.badge?.text !== row.badge?.text ? 1 : 0);
  }, 0);
}
