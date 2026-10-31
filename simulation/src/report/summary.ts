import type { Report, ReportTheme } from '../types.ts';
import { rankOrder } from './themes.ts';

// The top of a report in a few template sentences. Every name and number comes from the report, so it costs no model call and
// cannot invent anything. It speaks of personas in this run: its findings are hypotheses (docs/interpreting-simulations.md).

/** In a copy with nothing left to show: "no problem came up" would be false, as the team hid them. */
export const HIDDEN_ALL = 'No friction theme is left in this copy, which leaves out what the team sharing it hid.';

const SEGMENTS = 3; // named in full, the worst hit first
const list = new Intl.ListFormat('en');
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Who a theme's share counts: the page holds for a site only, and a theme of survey answers has no page. */
function exposed(theme: ReportTheme, poi?: Report['pois'][number]) {
  if (poi?.type === 'text') return 'who read the text';
  if (poi?.type === 'design') return 'who saw the design';
  return theme.pages.length > 1 ? 'who reached its pages' : theme.pages.length ? 'who reached the page' : 'who tried it';
}

function reach(theme: ReportTheme, verb: 'met' | 'raised', poi?: Report['pois'][number]) {
  const share = theme.prevalence;
  if (theme.scan_only) return 'found by the accessibility scan, which says nothing about how many personas met it';
  if (!share) return `${verb} by ${count(theme.personas, 'persona')}`; // older reports have no denominator
  if (share.personas === 0) return `which no persona ${verb} first-hand: ${count(theme.personas, 'persona')} reported it only after reading about it in the feed`;
  return `${verb} by ${share.personas} of ${count(share.exposed, 'persona')} ${exposed(theme, poi)}`;
}

/** The segments that met a theme first-hand; a run without an audience has one built-in segment, which says nothing. */
function segments(theme: ReportTheme) {
  const hit = theme.affected.filter((a) => a.segment_id !== null && a.affected > 0).sort((a, b) => b.rate - a.rate || b.affected - a.affected);
  if (hit.length === 0) return [];
  const named = hit.slice(0, SEGMENTS).map((a) => `${a.name} (${a.affected} of ${count(a.reached, 'persona')})`);
  return [`It came up among ${list.format(hit.length > SEGMENTS ? [...named, count(hit.length - SEGMENTS, 'more segment')] : named)}.`];
}

/** The biggest problem, who it affects and what to look at next, on the team's own product. Null for a report without themes. */
export function writtenSummary(report: Report): string | null {
  if (!report.themes) return null;
  const poiOf = (theme: ReportTheme) => report.pois.find((poi) => poi.id === theme.poi_id);
  const own = (theme: ReportTheme) => !poiOf(theme)?.competitor;
  const several = report.pois.filter((poi) => !poi.competitor).length > 1;
  const named = (theme: ReportTheme) => `“${theme.title}”${several && poiOf(theme) ? ` on ${poiOf(theme)!.name}` : ''}`;
  const themes = report.themes.filter(own);
  const problems = themes.filter((t) => t.category !== 'objection').sort(rankOrder); // across POIs too, where `rank` restarts
  const [lead, next] = [...problems, ...themes.filter((t) => t.category === 'objection').sort(rankOrder)];
  const aside = report.set_aside?.filter(own).length ?? 0;
  const started = report.personas.filter((p) => p.outcome !== 'not_started').length; // model_failed began, and can have met a theme
  const verb = problems.length ? 'met' : 'raised';
  return [
    ...(report.status === 'finished' ? [] : [`The run did not finish: ${started} of ${count(report.personas.length, 'persona')} started, so this covers only what they got to.`]),
    ...(problems.length ? [] : [report.shared?.hidden ? HIDDEN_ALL : aside
      ? `The evidence check set aside ${aside === 1 ? 'the one friction theme' : `all ${aside} friction themes`} as a persona's mistake or the test setup. That is one model's review, so a real problem can be among them.`
      : report.pois.every((poi) => poi.competitor) // report/compare.ts counts such a run as the team's, but it tried nothing of theirs
        ? 'This run tried only competitor sites, so it has no finding on your product.'
        : 'No friction theme came up on your product, which does not show that it works for real people.']),
    ...(lead ? [
      `${problems.length ? 'The biggest problem in this run is' : 'The top objection is'} ${named(lead)}, ${reach(lead, verb, poiOf(lead))}.`,
      ...((lead.prevalence?.personas ?? lead.personas) === 1 ? ['That is one persona, so it is worth a look but not yet a pattern.'] : []),
      ...segments(lead),
      next ? `Next, look at ${named(next)}.` : 'Next, open its evidence, then check it with real people.',
    ] : [`Next, ${aside ? 'read the reason given for each' : 'look at how far each persona got'}.`]),
  ].join(' ');
}
