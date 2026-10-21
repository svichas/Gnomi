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

function momentKey(row: Row, allEvents: boolean): string {
  const source = row.source;
  const grouped = !allEvents && row.persona_id !== null && source?.poi_id != null && source.step !== undefined && STEP_CONTEXT.has(source.type);
  return grouped ? JSON.stringify([row.persona_id, source.poi_id, source.round, source.step]) : `event-${row.seq}`;
}

// The most telling row leads a moment; of equals, the latest.
const lead = (rows: Row[]) => rows.reduce((best, row) => (priority(row) >= priority(best) ? row : best));

/** A live feed's moments, newest first, kept by folding only the rows each batch adds or replaces. */
export interface MomentFold {
  byKey: Map<string, ActivityMoment>;
  list: ActivityMoment[];
}

export const emptyMoments = (): MomentFold => ({ byKey: new Map(), list: [] });

/**
 * Folds rows added in time order, each later than every row folded before, and earlier rows replaced in place (a blocked
 * host's count). A moment a new row joins moves to the top; the list is a new array, so a memo on it sees the change.
 */
export function foldMoments(fold: MomentFold, added: Row[], replaced: Row[], allEvents = false): MomentFold {
  if (!added.length && !replaced.length) return fold;
  const touched = new Map<string, ActivityMoment>();
  for (const row of added) {
    if (!allEvents && !isTimelineHighlight(row)) continue;
    const key = momentKey(row, allEvents);
    const moment = touched.get(key) ?? fold.byKey.get(key);
    touched.set(key, moment
      ? { key, row: priority(moment.row) > priority(row) ? moment.row : row, related: [...moment.related, row], latestSeq: Math.max(moment.latestSeq, row.seq) }
      : { key, row, related: [row], latestSeq: row.seq });
  }
  const fresh = [...touched.values()].sort((a, b) => b.latestSeq - a.latestSeq);
  const stale = new Set(fresh.flatMap((moment) => fold.byKey.get(moment.key) ?? []));
  const list = fresh.concat(stale.size ? fold.list.filter((moment) => !stale.has(moment)) : fold.list);
  for (const moment of fresh) {
    moment.related.sort((a, b) => a.seq - b.seq);
    fold.byKey.set(moment.key, moment);
  }
  for (const row of replaced) {
    const old = fold.byKey.get(momentKey(row, allEvents));
    if (!old || (!allEvents && !isTimelineHighlight(row))) continue;
    const related = old.related.map((each) => (each.seq === row.seq ? row : each));
    const moment = { ...old, row: lead(related), related };
    list[list.indexOf(old)] = moment;
    fold.byKey.set(old.key, moment);
  }
  fold.list = list;
  return fold;
}

/** One thought and its action/evidence read as one moment, even with concurrent people. Rows come newest first. */
export const activityMoments = (rows: Row[], allEvents = false): ActivityMoment[] => foldMoments(emptyMoments(), rows.toReversed(), [], allEvents).list;

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
