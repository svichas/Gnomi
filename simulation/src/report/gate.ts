import type { ReportDiff, ThemeDiff } from './diff.ts';
import { isSevere } from './themes.ts';

// Whether CI should stop a build (features_roadmap.md item 11), read from a comparison of two repeat sets. Pure, with no model call.
// A pass only says nothing new and severe came back, and two sides that are not like for like are no pass (docs/ci-gate.md).

/** Finished runs each side needs: the regression plan's rolling window over three runs (roadmap.md). */
export const GATE_RUNS = 3;
/** Later runs a new theme must be high severity in before it fails: one run is one sample of a noisy model. */
export const GATE_SIGHTINGS = 2;

export type GateResult = 'passed' | 'failed' | 'could_not_decide';

export interface GateDecision {
  decision: GateResult;
  base: string[]; // the runs compared on each side
  run: string[];
  failing: ThemeDiff[]; // new, and high severity in GATE_SIGHTINGS later runs tied to each other by more than one shared key; with `reasons`, what would have failed
  warnings: ThemeDiff[]; // high severity, but too thin to fail: seen too rarely, or tied to an earlier theme by one shared key
  reasons: string[]; // why it could not decide
}

/** The later runs where a new theme was high severity. ThemeDiff.severity is the first run's alone, which would tie the verdict to run order. */
export const severeSightings = ({ sightings = [] }: ThemeDiff) => sightings.filter(({ severity }) => isSevere(severity));

export function gateDecision(diff: ReportDiff): GateDecision {
  const short = (runs: string[], side: string) => (runs.length < GATE_RUNS ? [`The ${side} side has ${runs.length} finished run${runs.length === 1 ? '' : 's'}, and the gate needs ${GATE_RUNS} from one repeat set.`] : []);
  const reasons = [...short(diff.before, 'earlier'), ...short(diff.after, 'later'), ...diff.gaps.map(({ text }) => text)];
  const failing = diff.themes.filter((theme) => theme.status === 'new' && severeSightings(theme).filter(({ weak }) => !weak).length >= GATE_SIGHTINGS);
  const warnings = diff.themes.filter((theme) => !failing.includes(theme) && (severeSightings(theme).length > 0 || (theme.weak && isSevere(theme.severity))));
  return { decision: reasons.length ? 'could_not_decide' : failing.length ? 'failed' : 'passed', base: diff.before, run: diff.after, failing, warnings, reasons };
}
