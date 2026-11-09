import { isUnrated } from '../types.ts';
import type { Outcome, Prevalence, Report, ReportCoverage, ReportDriver, ReportEvidence, ReportFlow, ReportFlowPage, ReportFriction, ReportMethods, ReportStudyPlan, ReportTheme, SpreadStats, StepEvidence, StudyCount, ThemeValidation, Trust } from '../types.ts';
import { RETEST_REACH, type Change, type DiffStatus, type ReportDiff, type Seen, type SpreadDiff, type ThemeDiff } from './diff.ts';
import { DRIVER_AFFECTED, DRIVER_GAP, DRIVER_HOLDERS, formatAttributeValue } from './dimensions.ts';
import { GATE_SIGHTINGS, severeSightings, type GateDecision, type GateResult } from './gate.ts';
import { MIN_PAIRS, uncounted, type RepeatSet, type WhatIfNumber, type WhatIfResult } from './repeats.ts';
import { HIDDEN_ALL, writtenSummary } from './summary.ts';
import { screenName, screensOf, type Screen } from './screens.ts';
import { priorityOf } from './themes.ts';

// Free text from the model can hold line breaks, which would split a Markdown list item or a table row. It also quotes pages,
// so HTML and the characters that start a link, image or code span are escaped: a page cannot make the export load an image
// or hide a link behind its own words. Escaping `[` is enough to stop `![`.
const line = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/[\\[\]`]/g, '\\$&').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cell = (text: string) => line(text).replace(/\|/g, '\\|');
// A query string or fragment can carry a session or reset token, but a hash route (#/settings) names the page and stays.
// A text's or design's name is not an http(s) URL and stays whole.
const pageUrl = (url: string) => line(/^https?:\/\//i.test(url) ? url.replace(/[?#].*$/s, '') + (/#!?\/[^?]*/.exec(url)?.[0] ?? '') : url);
const pct = (rate: number | null) => (rate === null ? '-' : `${Math.round(rate * 100)}%`); // null: a rate over nobody
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}`;

/** A POI as the report names it: a competitor's site says so. */
export const poiName = (poi: Report['pois'][number]) => (poi.competitor ? `${poi.name} (competitor, observed only)` : poi.name);

/** The name of a theme's POI, in a report with several. */
export const themePoi = ({ poi_id }: ReportTheme, pois: Report['pois']) => {
  const poi = pois.find(({ id }) => id === poi_id);
  return pois.length > 1 && poi ? poiName(poi) : undefined;
};

export const PRIORITY_TEXT = { fix_now: 'Fix now', next: 'Next', later: 'Later' } as const;

/** Said wherever the labels are explained: they are a suggestion within one run, not a finding about real users. */
export const PRIORITY_NOTE = 'Fix now, Next and Later suggest where to look first within this run, from its evidence and severity. They do not change the ranking, so a Next can sit below a Later, and they say nothing about real users.';

/** A finding's label; a competitor's has none, because its problems are not the team's to fix. */
export const themePriority = (theme: ReportTheme, pois: Report['pois']) => (pois.find(({ id }) => id === theme.poi_id)?.competitor ? null : priorityOf(theme));

/** Said wherever a finding of the page scan alone is shown, so its place on a persona's step does not read as that persona meeting it. */
export const SCAN_TEXT = 'Found by the accessibility scan of the page, not by a persona. It sits on the step of whichever persona reached that page first, so it says nothing about how many personas met it.';

/** What a reader acts on: the rule, how bad it is, and where. */
export const scanText = ({ rule, impact, elements, selectors }: Pick<NonNullable<ReportEvidence['scan']>, 'rule' | 'impact' | 'elements' | 'selectors'>) => `${rule}, ${impact}, ${count(elements, 'element')}: ${selectors.join('; ')}${elements > selectors.length ? ' and more' : ''}`;

/** "More common among personas with Region EMEA: 4 of 6 with it, against 1 of 9 others": counts within the run, never a cause. */
export const driverText = ({ name, value, holders, others }: ReportDriver) => `More common among personas with ${name} ${formatAttributeValue(value)}: ${holders.affected} of ${holders.reached} with it, against ${others.affected} of ${count(others.reached, 'other')}`;

/** Said wherever drivers are shown. */
export const DRIVER_NOTE = `"More common among" compares the simulated personas who reached a finding's pages, or answered a survey for a finding with no pages. It shows only with at least ${DRIVER_HOLDERS} personas holding a value, ${DRIVER_AFFECTED} of them meeting the finding and a gap of ${Math.round(DRIVER_GAP * 100)} points. Connected personas are not independent, so read it as a place to look, within this run only.`;

/** What a POI's coverage says, in the order it is shown: the hint, the curve, then what few personas reached. */
export const coverageText = ({ hint, curve, thin_pages }: ReportCoverage) => [
  hint,
  ...(curve ? [`New problems per persona, in the order they began: ${curve.join(', ')}.`] : []),
  ...(thin_pages.length ? [`Barely tested, reached by fewer than ${RETEST_REACH} personas: ${thin_pages.map(({ page, personas }) => `${page} (${personas})`).join(', ')}.`] : []),
];

const studyDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "Your team's study, 12 Oct 2026: supported": always attributed, so an outcome can never read as something the simulation found. */
export const outcomeText = ({ status, study_date }: ThemeValidation) => `Your team's study, ${studyDay.format(new Date(`${study_date}T00:00:00Z`))}: ${status}`;

/** The note and, after a rejudge renamed the finding, what it was called when the study was recorded. */
export const outcomeDetails = ({ note, title }: ThemeValidation, current?: string) => [...(note ? [note] : []), ...(current !== undefined && title !== current ? [`Recorded for "${title}".`] : [])];

/** Said wherever outcomes are shown: what people found stays apart from what the simulation did, and belongs to one run. */
export const OUTCOME_NOTE = "Study outcomes are your team's own, from real people. They change no simulated count, rank, label or summary, reach no model, and stay with this run: a repeat set or a comparison does not carry them across.";

export const UNMATCHED_NOTE = 'These outcomes have no finding of their own in this report, for example after the findings were judged again and two studied ones became one. They stay here, with the title each was recorded for.';

/** "Of the top 5 findings, your team's studies supported 2, contradicted 1, left 1 unresolved, and 1 is not studied yet": counts, as a handful of chosen findings is no sample. */
export function studyCountText({ of, supported, contradicted, unresolved, not_studied }: StudyCount): string {
  const found = [...(supported ? [`supported ${supported}`] : []), ...(contradicted ? [`contradicted ${contradicted}`] : []), ...(unresolved ? [`left ${unresolved} unresolved`] : [])];
  const parts = [...(found.length ? [`your team's studies ${found[0]}`, ...found.slice(1)] : []), ...(not_studied ? [`${not_studied} ${not_studied === 1 ? 'is' : 'are'} not studied yet`] : [])];
  return `Of the top ${count(of, 'finding')}, ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}` : parts[0]}.`;
}

/** At the top of every plan: the file goes to a researcher, who must keep the hypotheses from participants. */
export const STUDY_WARNING = 'These hypotheses come from simulated users and are unproven. Do not show them to participants: people get only the screener and the tasks. A model wrote this plan, so read it before you use it.';

/** At the top of every copy for sharing the team changed anything in, and nothing the team can do removes it: a copy that hides what it left out would mislead its reader. */
export const sharedText = ({ hidden, reworded }: NonNullable<Report['shared']>) => `The team sharing this report hid ${count(hidden, 'finding')} from this copy and reworded ${count(reworded, 'finding')}. The rest is as the run found it.`;

/** On every finding whose words in a copy are the team's. */
export const REWORDED_TEXT = 'Reworded by the team';

/** Where a copy has no friction left to list: "none reported" would be false, as they went with what the team hid. */
export const HIDDEN_FRICTIONS = 'Frictions are left out of this copy with the findings the team sharing it hid.';

export const NO_TASKS = 'No task is left for this hypothesis, so write one by hand that does not mention the finding.';
export const NO_SCREENER = 'No screener question is left, so write them by hand from who you want to reach.';
export const OUTDATED_PLAN = 'The findings were judged again after this plan was written, so it may not match them. Plan again to catch up.';

/** Null when the quote check took nothing out. */
export const droppedText = (dropped: number) => (dropped ? `${count(dropped, 'draft')} left out because ${dropped === 1 ? 'it' : 'they'} repeated a finding's words.` : null);

/** What a plan does not cover, and why; null when it covers every finding. */
export function leftOutText({ lower_ranked, objections, competitors, set_aside, scan_only }: ReportStudyPlan['left_out']): string | null {
  const parts = [
    ...(lower_ranked ? [count(lower_ranked, 'lower-ranked finding')] : []),
    ...(objections ? [count(objections, 'objection')] : []),
    ...(competitors ? [count(competitors, 'competitor finding')] : []),
    ...(set_aside ? [`${set_aside} set aside by the evidence check`] : []),
    ...(scan_only ? [`${scan_only} found by the accessibility scan alone, which needs an audit rather than a study with people`] : []),
  ];
  return parts.length ? `Left out of this plan: ${parts.join('; ')}.` : null;
}

function studyPlanLines(plan: ReportStudyPlan, heading: string): string[] {
  const dropped = droppedText(plan.screener_dropped);
  const leftOut = leftOutText(plan.left_out);
  return [
    ...(plan.outdated ? [OUTDATED_PLAN, ''] : []),
    `${heading} Screener`, '',
    ...(plan.screener.length ? plan.screener.map((question) => `- ${line(question)}`) : [NO_SCREENER]),
    ...(dropped ? ['', dropped] : []),
    ...plan.hypotheses.flatMap((hypothesis, i) => {
      const left = droppedText(hypothesis.dropped);
      return [
        '', `${heading} Hypothesis ${i + 1}: ${line(hypothesis.title)}`, '',
        'Tasks:', '',
        ...(hypothesis.tasks.length ? hypothesis.tasks.map((task, n) => `${n + 1}. ${line(task)}`) : [NO_TASKS]),
        ...(left ? ['', left] : []),
        '', 'For the researcher, what to watch for:', '',
        ...(hypothesis.observe.length ? hypothesis.observe.map((note) => `- ${line(note)}`) : ['- Nothing was written.']),
      ];
    }),
    ...(leftOut ? ['', leftOut] : []),
  ];
}

/** The plan on its own, as runs/<id>/study-plan.md: a team can hand a researcher this without the findings. */
export const studyPlanToMarkdown = (report: Report, plan: ReportStudyPlan): string =>
  [`# Study plan: ${line(report.goal)}`, '', `> ${STUDY_WARNING}`, '', ...(report.shared ? [`> ${sharedText(report.shared)}`, ''] : []), ...(report.methods.prior ? [`> ${priorNotice(report.methods.prior)}`, ''] : []), `From Gnomi run ${report.run_id}.`, '', ...studyPlanLines(plan, '##'), ''].join('\n');

/** Why containment blocked requests, for the methods appendix; no reason means a host outside the allowed ones. */
export const BLOCK_REASON_TEXT = { observe_only: 'writes refused, observed only', robots: 'disallowed by robots.txt' } as const;

/** "2 runs compared." and what a repeat means, or that the set is still going, or that it ended early. */
export function setNote(set: RepeatSet): string {
  const state = set.running ? `${set.compared} of ${set.of} runs finished so far.` : set.incomplete ? `Incomplete set: ${set.compared} of ${set.of} runs finished.` : `${count(set.of, 'run')} compared.`;
  return `${state} Repeats test robustness inside the simulation: a finding that comes back is still a hypothesis about real users.${set.trait_free ? ' One more run, of personas with no traits, is in no count here.' : ''}${set.what_if ? ' The runs with the added post are in no count here.' : ''}`;
}

/** What sets a run apart in its set, for the line that places it there. */
export function repeatLabel(run: Parameters<typeof uncounted>[0]): string {
  const what_if = run.repeat?.what_if;
  if (what_if) return `, pair ${what_if.pair}, ${what_if.post ? 'with the post your team added' : 'without the added post'}`;
  return uncounted(run) === 'trait_free' ? ', of personas with no traits' : '';
}

/** Said before a what-if starts with too few pairs for an interval; null with enough. */
export const fewPairsText = (pairs: number) => (pairs < MIN_PAIRS ? `${count(pairs, 'pair')} ${pairs === 1 ? 'gives' : 'give'} no interval, only a mean difference. Use at least ${MIN_PAIRS}.` : null);

export const WHAT_IF_COLUMNS = ['Number', 'Mean difference, with the post minus without', '95% interval', 'Pairs'];

/** A what-if's row after its label: the interval, or why there is none. */
export const whatIfCells = ({ mean, lower, upper, note, n }: WhatIfNumber) => [mean === null ? '-' : signed(mean), lower === null || upper === null ? note! : `${signed(lower)} to ${signed(upper)}`, String(n)];

/** Where the post stood and how many pairs count. */
export const whatIfText = ({ round, pairs, of }: WhatIfResult) => `Added by your team in round ${round}, shown to the others as one persona's post, which it never wrote. ${pairs} of ${count(of, 'pair')} finished; a pair with a run still going or stopped is left out.`;

function whatIfLines(whatIf: WhatIfResult): string[] {
  return [
    '## What-if post', '',
    `> ${whatIf.note}`, '',
    `"${line(whatIf.post)}"`, '',
    whatIfText(whatIf), '',
    `| ${WHAT_IF_COLUMNS.join(' | ')} |`,
    '| --- | --- | --- | --- |',
    ...whatIf.numbers.map((number) => `| ${cell(number.label)} | ${whatIfCells(number).join(' | ')} |`),
    '',
  ];
}

/** On a finding that the set's run of personas with no traits matched. It removes nothing and changes no rank. */
export const TRAIT_FREE_TEXT = 'Personas with no traits hit this too, so it may say more about the model than this audience';

/** What a set says about one finding of its run: "Appeared in 3 of 3 runs". Null for a run the set could not compare, or a set of one with nothing to add. */
export function repeatNote(set: RepeatSet | undefined, run_id: string, theme: ReportTheme) {
  const finding = set?.findings.find((f) => f.poi_id === theme.poi_id && f.themes[run_id] === theme.id);
  if (!set || !finding || (finding.of < 2 && !finding.trait_free)) return null;
  return {
    appeared: finding.of < 2 ? null : `Appeared in ${finding.seen_in} of ${finding.of} runs`,
    one_family: set.families.length > 1 && finding.families.length === 1 ? `Only ${finding.families[0]} runs produced this` : null,
    trait_free: finding.trait_free ? TRAIT_FREE_TEXT : null,
    other_titles: finding.titles.filter((title) => title !== theme.title), // how a reader can spot a false pair (report/repeats.ts)
  };
}

/** A set's findings side by side, for `gnomi report --repeat`. */
export function repeatsToMarkdown(set: RepeatSet): string {
  return [
    `# Gnomi repeat set ${set.group ?? ''}`.trimEnd(), '',
    `> ${setNote(set)}`, '',
    ...(set.prior ? [`> ${priorNotice(set.prior)}`, ''] : []),
    ...(set.what_if ? whatIfLines(set.what_if) : []),
    `Model families: ${set.families.map(line).join(', ') || 'none'}.`, '',
    '| Finding | Appeared in | Model families | Also named |',
    '| --- | --- | --- | --- |',
    ...set.findings.map((f) => `| ${cell(f.titles[0])} | ${f.seen_in} of ${f.of} runs${f.trait_free ? `. ${TRAIT_FREE_TEXT}` : ''} | ${f.families.map(cell).join(', ')} | ${f.titles.slice(1).map(cell).join('; ')} |`),
    '',
  ].join('\n');
}

/** At the top of every comparison: the status stays `fixed` for machines, but nothing here may tell a person a problem is fixed. */
export const DIFF_NOTICE = '"Not seen again" means the later run did not show a problem, not that it is fixed: the personas may simply not have tried the failing path. These are simulated findings, so treat every change here as a hypothesis and check it with real users.';

export const DIFF_LABEL: Record<DiffStatus, string> = { fixed: 'Not seen again', new: 'New', unchanged: 'Unchanged', not_retested: 'Not retested' };

export const DIFF_HINT: Record<DiffStatus, string> = {
  fixed: 'The later run did not show these, on pages it did reach. That does not prove they are fixed.',
  new: 'Only the later run showed these.',
  unchanged: 'Both sides showed these.',
  not_retested: `The later run did not show these, but fewer than ${RETEST_REACH} personas reached their pages, so their absence says nothing.`,
};

/** What a person reads as a comparison row's name: the later title when there is one. */
export const diffTitle = (theme: ThemeDiff) => (theme.after_title ?? theme.before_title)!;

/** "was in 3 of 4 runs, not seen in 3 of 3, 6 personas reached its page", then what weakens the row, in plain words. */
export function diffText(theme: ThemeDiff): string {
  const runs = ({ seen_in, of }: Seen) => `${seen_in} of ${count(of, 'run')}`;
  const reach = theme.reached === null
    ? 'the later report does not say who got there'
    : `${count(theme.reached, 'persona')} ${theme.pages.length === 0 ? 'answered a survey on it' : theme.pages.length === 1 ? 'reached its page' : 'reached all its pages'}`;
  const seen = `was in ${runs(theme.before)}`;
  const gone = `${seen}, not seen in ${theme.after.of} of ${theme.after.of}, ${reach}`;
  const titles = theme.before_title !== null && theme.after_title !== null && theme.before_title !== theme.after_title;
  const quoted = (...names: (string | null)[]) => new Intl.ListFormat('en').format([...new Set(names)].map((name) => `"${name}"`));
  return [
    `${theme.status === 'fixed' ? gone : theme.status === 'not_retested' ? `${gone}${theme.reached === null ? '' : `, and it takes ${RETEST_REACH} to say anything`}` : `${seen}, now in ${runs(theme.after)}`}.`,
    ...(theme.weak ? [`They only share one place on a page, so ${quoted(...(theme.grouped_with ?? []), theme.before_title, theme.after_title)} may be different problems.`] : titles ? [`Earlier called "${theme.before_title}".`] : []),
    ...(theme.set_aside ? [`The evidence check set it aside in the ${theme.set_aside === 'before' ? 'earlier' : 'later'} run and kept it in the other, so this says nothing either way about a change in the product.`] : []),
  ].join(' ');
}

/** Posts and personas average over a set's runs, so a side can be 2.5. */
export const plainNumber = (n: number) => String(Math.round(n * 10) / 10);

/** "0.50 → 1.00 (+0.50)", or a dash for a side without the number. */
export function changeText(change: Change, show: (n: number) => string, delta = (n: number) => `${n > 0 ? '+' : ''}${show(n)}`): string {
  const side = (n: number | null) => (n === null ? '-' : show(n));
  return `${side(change.before)} → ${side(change.after)}${change.delta === null ? '' : ` (${delta(change.delta)})`}`;
}

export const pointsChange = (change: Change) => changeText(change, (n) => pct(n), (n) => `${n > 0 ? '+' : ''}${Math.round(n * 100)} points`);

/** A product's row of the spread table, then a row per segment, which has only its readers. */
export const spreadRows = (spread: SpreadDiff) => [
  { name: spread.name, cells: [changeText(spread.posts, plainNumber), changeText(spread.second_hand, plainNumber), changeText(spread.readers, plainNumber), changeText(spread.sentiment, (n) => n.toFixed(2))] },
  ...spread.segments.map((segment) => ({ name: `${spread.name}: ${segment.name}`, cells: ['-', '-', changeText(segment.readers, plainNumber), '-'] })),
];

/** Two sides of a comparison, for `gnomi compare`. */
export function diffToMarkdown(diff: ReportDiff): string {
  const side = (ids: string[]) => ids.map(line).join(', ');
  const poi = (theme: ThemeDiff) => (diff.pois.length > 1 ? ` on ${line(diff.pois.find(({ id }) => id === theme.poi_id)?.name ?? theme.poi_id)}` : '');
  return [
    `# Gnomi comparison: ${side(diff.before)} to ${side(diff.after)}`, '',
    `> ${DIFF_NOTICE}`, '',
    ...(diff.notes.length ? ['## What weakens this comparison', '', ...diff.notes.map((note) => `- ${line(note)}`), ''] : []),
    ...(['new', 'unchanged', 'not_retested', 'fixed'] as const).flatMap((status) => {
      const themes = diff.themes.filter((theme) => theme.status === status);
      return themes.length ? [`## ${DIFF_LABEL[status]} (${themes.length})`, '', DIFF_HINT[status], '', ...themes.map((theme) => `- **${line(diffTitle(theme))}**${poi(theme)}, severity ${theme.severity} of 4: ${line(diffText(theme))}`), ''] : [];
    }),
    ...(diff.themes.length ? [] : ['No themes on either side.', '']),
    ...(diff.segments.length ? [
      '## By segment', '',
      '| Segment | Mean sentiment, -2 to +2 | Ran into friction |',
      '| --- | --- | --- |',
      ...diff.segments.map((s) => `| ${cell(s.name)} | ${changeText(s.sentiment, (n) => n.toFixed(2))} | ${pointsChange(s.with_friction)} |`), '',
    ] : []),
    ...(diff.spread.length ? [
      '## Opinion spread', '',
      '| Product | Posts | Second-hand | Reached | Mean sentiment, last round |',
      '| --- | --- | --- | --- | --- |',
      ...diff.spread.flatMap(spreadRows).map(({ name, cells }) => `| ${cell(name)} | ${cells.join(' | ')} |`), '',
    ] : []),
  ].join('\n');
}

const GATE_HEADLINE: Record<GateResult, string> = {
  passed: 'No new high-severity theme in these simulated runs. This does not show that people will not hit one.',
  failed: `A new high-severity theme came back in at least ${GATE_SIGHTINGS} of the later simulated runs. It is a hypothesis to check, not evidence about real users.`,
  could_not_decide: 'The gate could not decide, so this is not a pass.',
};

/** A pass with warnings lists new high-severity themes from these same runs, so it cannot say there were none. */
const gateHeadline = ({ decision, warnings }: GateDecision) => (decision === 'passed' && warnings.length
  ? `No new high-severity problem clearly came back in at least ${GATE_SIGHTINGS} of these simulated runs. This does not show that people will not hit one.`
  : GATE_HEADLINE[decision]);

/** A gate's verdict, for `gnomi gate`. */
export function gateToMarkdown(gate: GateDecision): string {
  const rows = (themes: ThemeDiff[]) => themes.map((theme) => {
    const sightings = theme.sightings ?? [];
    const severe = severeSightings(theme).length;
    const loose = sightings.some(({ weak }) => weak) ? ' Some of those runs only share one place on a page, so they may be different problems.' : '';
    const attitude = theme.category === 'objection' ? ' This is an objection, a reason not to adopt, so it never fails a build.' : '';
    return `- **${line(diffTitle(theme))}**, ${sightings.length ? `high severity in ${severe} of ${count(theme.after.of, 'later run')}` : `severity ${theme.severity} of 4`}: ${line(diffText(theme))}${loose}${attitude}`;
  });
  return [
    `# Gnomi gate: ${gate.decision.replaceAll('_', ' ')}`, '',
    ...(gate.base.length ? [`Compared ${gate.base.map(line).join(', ')} to ${gate.run.map(line).join(', ')}.`, ''] : []),
    `> ${gateHeadline(gate)}`, '',
    ...(gate.reasons.length ? ['## Why it could not decide', '', ...gate.reasons.map((reason) => `- ${line(reason)}`), ''] : []),
    ...(gate.failing.length ? [`## ${gate.reasons.length ? 'Would have failed' : 'Failed on'} (${gate.failing.length})`, '', ...rows(gate.failing), ''] : []),
    ...(gate.warnings.length ? [`## Warnings (${gate.warnings.length})`, '', 'High severity, but not enough to fail on.', '', ...rows(gate.warnings), ''] : []),
  ].join('\n');
}

/** A run of a repeat set gets `set` when read, which adds how its findings did across the set; the run's own report stays as it was. */
export function reportToMarkdown(report: Report, set?: RepeatSet): string {
  if (report.comparison) return comparisonToMarkdown(report);
  const status = report.stop_reason === null ? report.status : `${report.status} (${report.stop_reason})`;
  const duration = report.duration_ms === null ? 'not finished' : `${(report.duration_ms / 1000).toFixed(1)} s`;
  const missingUsage = missingUsageText(report.unreported_usage_calls);
  const summary = writtenSummary(report);
  return [
    `# Gnomi report: ${report.goal}`,
    '',
    `> ${report.banner}`,
    '',
    ...(report.shared ? [`> ${sharedText(report.shared)}`, ''] : []),
    ...(report.methods.prior ? [`> ${priorNotice(report.methods.prior)}`, ''] : []),
    ...(summary ? [line(summary), ''] : []),
    ...(report.study_count ? [`**From your team's studies, not the simulation:** ${studyCountText(report.study_count)}`, ''] : []),
    `- Tried: ${report.pois.map((poi) => (poi.start_url ? `${poiName(poi)} (${poi.start_url})` : poiName(poi))).join(', ')}`,
    `- Personas: ${report.personas.length}, steps: ${report.steps}`,
    `- Status: ${status}`,
    ...(report.repeat ? [`- Repeat: run ${report.repeat.index} of ${report.repeat.of} in set ${report.repeat.group}${repeatLabel(report)}`] : []),
    ...(set ? [`- ${setNote(set)}`] : []),
    '',
    ...(set?.what_if ? whatIfLines(set.what_if) : []),
    '## Segments',
    '',
    ...segmentLines(report),
    ...dimensionLines(report),
    ...themeLines(report, set),
    ...screenLines(report),
    ...setAsideLines(report),
    ...studyLines(report),
    ...flowLines(report),
    ...sentimentLines(report),
    ...buyerLines(report),
    ...wentWellLines(report),
    ...comparisonLines(report),
    ...spreadLines(report),
    '',
    '## Frictions',
    '',
    ...frictionLines(report),
    '',
    '## Cost and time',
    '',
    `- Recorded cost: $${report.cost_usd.toFixed(4)}. ${COST_SCOPE_TEXT}`,
    ...(missingUsage ? [`- ${missingUsage}`] : []),
    `- Tokens: ${report.input_tokens} in, ${report.output_tokens} out`,
    `- LLM calls: ${report.llm_calls}`,
    `- Duration: ${duration}`,
    '',
    '## Methods',
    '',
    ...coverageLines(report),
    ...methodsToMarkdown(report.methods),
    '',
  ].join('\n');
}

function coverageLines({ coverage = [], pois }: Report): string[] {
  const of = ({ poi_id }: ReportCoverage) => (pois.length > 1 ? ` of ${line(pois.find(({ id }) => id === poi_id)?.name ?? poi_id)}` : '');
  return coverage.flatMap((poi) => coverageText(poi).map((text) => `- Coverage${of(poi)}: ${line(text)}`));
}

/** Comparison studies lead with decisions and scoped evidence, never pooled legacy completion. */
function comparisonToMarkdown(report: Report): string {
  const comparison = report.comparison!;
  const study = comparison.study;
  const target = (id: string) => study.targets.find((item) => item.id === id)?.name ?? id;
  const criterion = (id: string) => study.criteria.find((item) => item.id === id)?.name ?? id;
  const scope = (item: { scenario_id: string; task_id: string; segment_id: string | null }) => `${study.scenarios.find((scenario) => scenario.id === item.scenario_id)?.name ?? item.scenario_id} / ${item.task_id} / ${report.segments.find((segment) => segment.id === item.segment_id)?.name ?? item.segment_id ?? 'Built-in persona'}`;
  const label = (text: string) => text.replaceAll('_', ' ');
  const cite = (seq: number) => `[#${seq}](#comparison-source-${seq})`;
  const groups = [...new Set(comparison.cells.map((item) => JSON.stringify([item.scenario_id, item.task_id, item.segment_id, item.access_scope])))];
  const evidence = new Map<number, typeof comparison.cells[number]['evidence']>();
  for (const item of comparison.cells.flatMap((value) => value.evidence)) {
    const existing = evidence.get(item.event_seq) ?? [];
    if (!existing.some((prior) => prior.quote === item.quote && prior.assessment_seq === item.assessment_seq)) existing.push(item);
    evidence.set(item.event_seq, existing);
  }
  return [
    `# Gnomi comparison: ${line(study.question)}`, '', `> ${report.banner}`, '',
    '## Decision and scope', '', line(comparison.decision.summary), '',
    `- Purpose: ${label(study.purpose)}${study.focal_target_id ? `; focal tool: ${line(target(study.focal_target_id))}` : ''}`,
    `- Mode: ${label(study.execution.mode)}; carryover: ${label(study.execution.carryover)}; social: ${study.execution.social}`,
    `- Targets: ${study.targets.map((item) => `${line(item.name)} (${label(item.access_scope)})`).join('; ')}`,
    `- Status: ${report.status}${report.stop_reason ? ` (${report.stop_reason})` : ''}`,
    '', '## Side-by-side comparison', '',
    ...groups.flatMap((group) => {
      const [scenario_id, task_id, segment_id, access_scope] = JSON.parse(group) as [string, string, string | null, string];
      const rows = comparison.cells.filter((item) => item.scenario_id === scenario_id && item.task_id === task_id && item.segment_id === segment_id && item.access_scope === access_scope);
      const targets = study.targets.filter((item) => rows.some((row) => row.target_id === item.id));
      return ['', `### ${line(scope({ scenario_id, task_id, segment_id }))} — ${label(access_scope)}`, '',
        `| Criterion | ${targets.map((item) => cell(item.name)).join(' | ')} |`,
        `| --- | ${targets.map(() => '---').join(' | ')} |`,
        ...[...new Set(rows.map((item) => item.criterion_id))].map((criterion_id) => `| ${cell(criterion(criterion_id))}${study.criteria.find((item) => item.id === criterion_id)?.importance === 'must_have' ? ' (must-have)' : ''} | ${targets.map((item) => {
          const value = rows.find((row) => row.target_id === item.id && row.criterion_id === criterion_id)!;
          return `${label(value.assessment)}: ${cell(value.summary)}; basis: ${value.bases.map(label).join(', ') || 'none'}; ${value.assessed}/${value.eligible} assessed; ${value.distinct_sources} distinct source(s). ${[...new Set(value.evidence.map((entry) => entry.event_seq))].map(cite).join(' ')}${value.limitations.length ? ` Limits: ${cell(value.limitations.join(' '))}` : ''}`;
        }).join(' | ')} |`),
      ];
    }),
    '', '## Where each tool fits', '',
    ...comparison.fits.flatMap((fit) => [
      `### ${line(target(fit.target_id))}: ${label(fit.status)}`, '', `Scope: ${line(scope(fit))}`, '',
      `- Supported strengths: ${fit.strengths.map(line).join('; ') || 'none established'}`,
      `- Gaps: ${fit.gaps.map(line).join('; ') || 'none established'}`,
      `- Unresolved: ${fit.unknowns.map(line).join('; ') || 'none in these criteria'}`, '',
    ]),
    ...(comparison.tradeoffs.length ? ['', '## Focal tool tradeoffs', '', ...comparison.tradeoffs.map((item) => `- **${label(item.result)}** (${line(scope(item))}): ${line(item.summary)} ${item.evidence_seqs.map(cite).join(' ')}`)] : []),
    '', '## Next actions', '',
    ...(comparison.actions.length ? comparison.actions.flatMap((action, i) => [
      `${i + 1}. **${line(action.action)}**`, `   - Responsible: ${label(action.owner)}; ${line(scope(action))}`,
      `   - Evidence: ${line(action.rationale)} ${action.evidence_seqs.map(cite).join(' ')}`,
      `   - Expected benefit: ${line(action.expected_benefit)}`, `   - Validate: ${line(action.validation)}`, '',
    ]) : ['No supported change is prioritized from the tested criteria. Validate the observed fit with real users.']),
    '', '## Coverage and evidence', '',
    'Completion = completed / (completed + task failed + abandoned). Blocked, incomplete, invalid, not applicable and not attempted are excluded and remain visible. Source counts describe distinct documents, not independent human verification.', '',
    '| Tool / scope | Scheduled | Attempted | Completed | Failed | Abandoned | Blocked | Incomplete | Invalid task | Not applicable | Not attempted | Valid attempts | Completion |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...comparison.coverage.map((row) => `| ${cell(target(row.target_id))} / ${cell(scope(row))} / ${label(row.access_scope)} | ${row.scheduled} | ${row.attempted} | ${row.outcomes.completed} | ${row.outcomes.task_failed} | ${row.outcomes.abandoned} | ${row.outcomes.blocked_environment} | ${row.outcomes.incomplete} | ${row.outcomes.invalid_task} | ${row.outcomes.not_applicable} | ${row.outcomes.not_attempted} | ${row.valid_attempts} | ${row.completion_rate === null ? 'Unavailable' : pct(row.completion_rate)} |`),
    '', ...comparison.pairs.map((pair) => `- Comparable pairs, ${line(target(pair.target_ids[0]))} / ${line(target(pair.target_ids[1]))}, ${line(scope(pair))}: ${pair.matched}; completion difference ${pair.completion_difference === null ? 'unavailable' : `${(pair.completion_difference * 100).toFixed(1)} percentage points (first minus second)`}.`),
    '', '### Captured sources', '',
    ...[...evidence.entries()].flatMap(([seq, items]) => [
      `<a id="comparison-source-${seq}"></a>`, `- Event #${seq}; persona ${line(items[0].persona_id)}; captured ${new Date(items[0].captured_at).toISOString()}`,
      `  - Source: ${pageUrl(items[0].source)}`,
      ...items.flatMap((item) => [`  - Excerpt: “${line(item.quote)}”`, `  - Proposition (${label(item.basis)}; assessment #${item.assessment_seq}): ${line(item.proposition)}`]),
      `  - Screenshot: ${items[0].screenshot ?? 'none'}`, '',
    ]),
    '', '### Recorded target orders', '', ...comparison.orders.map((order) => `- ${line(order.persona_id)}, ${line(order.task_id)}: ${order.target_order.map(target).map(line).join(' → ')}`),
    '', '### Limitations', '', ...comparison.limitations.map((item) => `- ${line(item)}`),
    ...comparison.rejected_assessments.map((item) => `- Rejected assessment #${item.seq}: ${line(item.reason)}`),
    '', '## Cost and methods', '', `- Recorded cost: $${report.cost_usd.toFixed(4)}. ${COST_SCOPE_TEXT}`,
    `- Model calls: ${report.llm_calls}; tokens: ${report.input_tokens} in / ${report.output_tokens} out`,
    ...((report.unreported_usage_calls ?? 0) > 0 ? [`- ${report.unreported_usage_calls} calls did not report complete usage; actual charges may exceed recorded cost.`] : []),
    ...methodsToMarkdown(report.methods), '',
  ].join('\n');
}

function dimensionLines(report: Report): string[] {
  if (!report.dimensions?.length) return [];
  return [
    '', '## Results by profile', '',
    'Each row counts personas with that exact value, without segment weighting; completion and friction rates leave out personas who did not start or got no valid model answer. Mean latest feeling uses each persona’s latest valid step feeling, from -2 to 2; personas without one are excluded. Lists are grouped as an ordered whole.',
    ...report.dimensions.flatMap((dimension) => [
      '', `### ${cell(dimension.name)}`, '',
      '| Value | Personas | Completion | Ran into friction | Mean latest feeling |',
      '| --- | --- | --- | --- | --- |',
      ...dimension.values.map((group) => `| ${cell(formatAttributeValue(group.value))} | ${group.personas} | ${pct(group.completion)} | ${pct(group.with_friction)} | ${group.sentiment === null ? 'No recorded feeling' : group.sentiment.toFixed(2)} |`),
    ]),
  ];
}

/** Persona writing happens before the run, so its calls are in the project's setup log, not the run's. */
export const COST_SCOPE_TEXT = 'Writing the personas is recorded separately and is not included in this cost.';

/** Said beside a recorded cost when some model calls did not report their usage; null when every call did. */
export function missingUsageText(calls: number | undefined): string | null {
  if (!calls) return null;
  return `${count(calls, 'model call')} did not report complete usage. Canceled or failed requests may still incur provider charges. Actual charges may exceed the recorded cost.`;
}

export const TRUST_TEXT = {
  confirmed: 'a self-report backed by an objective signal',
  observed: 'an objective signal only',
  reported: 'a self-report only',
} as const;

/** Said wherever a set-aside theme is shown: the verdict is one model's reading, and the reader decides. */
export const SET_ASIDE_TEXT = "A model reviewed the evidence behind these themes and judged that it points to a persona's mistake or the test setup rather than the product. This is a model's review, not a test of the product, so a real problem can be among them: read each reason. They are left out of the ranking and the friction rate, and their events stay in the log.";

/** The tag's reason, for a reader deciding whether to discount it (tech.md §9.2). Nothing tagged leaves the report. */
export const INTERFERENCE_TEXT = "possibly interference between personas: another persona changed an element of the same name shortly before, so this may be their doing rather than the product's";

/** "1 of 3 reports tagged …": how much of a theme carries the tag. */
export const interferenceNote = ({ interference, frictions }: ReportTheme) => `${interference} of ${count(frictions, 'report')} tagged ${INTERFERENCE_TEXT}`;

/** What a set-aside theme's verdict points to, in words. */
export const setAsideCause = ({ check }: ReportTheme) => (check?.verdict === 'environment' ? 'the test setup' : "a persona's mistake");

// Weak signals alone make no theme, so an empty section cannot say that nothing went wrong. The undersized-target audit leaves competitors out.
const noThemes = ({ shared }: Report, aside: ReportTheme[] = [], competitor?: true) => {
  if (shared?.hidden) return HIDDEN_ALL;
  return aside.length ? 'The evidence check set aside every theme here.' : `No themes. Small-target and backtrack signals do not make one alone${competitor ? '.' : '; any undersized targets on your product are listed under Methods.'}`;
};

function themeLines(report: Report, set?: RepeatSet): string[] {
  if (!report.themes) return [];
  if (report.themes.length === 0) return ['', '## Themes', '', noThemes(report, report.set_aside)];
  return [
    '', '## Themes', '',
    "The judge model is asked to put the findings one concrete product change would remove in one theme, so a cause seen on several pages is one theme; a friction and an objection never share one. Ranked by evidence first (strong, then some, then single, then none), so a problem one persona reported never ranks above one several met first-hand; within the same evidence, by severity (the median over personas of each one's worst); within a severity, by the low end of the share of personas who met it first-hand × the mean trust of its personas. The share counts the personas who reached its pages (for buyer objections, the buyers surveyed); its 95% Wilson range is among this run's simulated personas, assuming independent personas; not an estimate of real users. Evidence is strong with three or more personas and at least a quarter of those, some with two or more, single with one, none when every report followed a feed post. Trust is a label within the simulation, not validation by real people: confirmed is a self-report backed by an objective signal, observed a signal only, reported a self-report only.",
    '', PRIORITY_NOTE,
    ...(report.themes.some((t) => t.drivers) ? ['', DRIVER_NOTE] : []),
    // Themes are ranked within each POI, so several POIs get a section each.
    ...(report.pois.length > 1
      ? report.pois.flatMap((poi) => {
          const themes = report.themes!.filter((t) => t.poi_id === poi.id);
          return ['', `### ${line(poiName(poi))}`, ...(themes.length ? themes.flatMap((t) => themeToMarkdown(t, '####', repeatNote(set, report.run_id, t), report.pois)) : ['', noThemes(report, report.set_aside?.filter((t) => t.poi_id === poi.id), poi.competitor)])];
        })
      : report.themes.flatMap((theme) => themeToMarkdown(theme, '###', repeatNote(set, report.run_id, theme), report.pois))),
  ];
}

/** The same themes by screen, in the order the Themes section lists them. Set-aside themes are not in report.themes. */
function screenLines(report: Report): string[] {
  const screens = screensOf(report.themes ?? [], report.reach);
  // With no screen to name, the section would only repeat the themes (the HTML export leaves it out too).
  if (!screens.some((s) => s.kind !== 'none')) return [];
  const h = report.pois.length > 1 ? '####' : '###';
  const group = ({ kind, page, reached, picture, findings }: Screen): string[] => [
    '',
    `${h} ${kind === 'page' ? `${line(screenName(page!))}${reached === null ? '' : ` (reached by ${count(reached, 'persona')})`}` : kind === 'across' ? 'Across many screens' : 'Not tied to one screen'}`,
    '',
    ...(picture ? [`Screenshot: ${picture.screenshot}`, ''] : []),
    ...findings.map(({ theme, number, picture: own, pinned }) =>
      `${number}. ${line(theme.title)}${theme.category === 'objection' ? ' (a reason not to adopt, from the survey)' : ''} (severity ${theme.severity} of 4)${
        pinned ? ` — marked on the screenshot: ${line(own!.box!.element)}` : own ? ` — own screenshot: ${own.screenshot}` : ''}`),
  ];
  return [
    '', '## Findings by screen',
    ...[...new Set(screens.map((s) => s.poi_id))].flatMap((id) => {
      const own = screens.filter((s) => s.poi_id === id);
      const poi = themePoi(own[0].findings[0].theme, report.pois);
      return [...(poi ? ['', `### ${line(poi)}`] : []), ...own.flatMap(group)];
    }),
  ];
}

/** Beside a finding, apart from its simulated numbers. */
const outcomeLines = (t: ReportTheme) => (t.validation ? [`**${outcomeText(t.validation)}.**${outcomeDetails(t.validation, t.title).map((text) => ` ${line(text)}`).join('')}`, ''] : []);

function studyLines({ study_plan: plan, unmatched_outcomes: unmatched }: Report): string[] {
  return [
    ...(unmatched ? ['', '## Study outcomes with no matching finding', '', UNMATCHED_NOTE, '', ...unmatched.map((outcome) => `- **${line(outcome.title)}**: ${outcomeText(outcome)}.${outcomeDetails(outcome).map((text) => ` ${line(text)}`).join('')}`)] : []),
    ...(plan ? ['', '## Study plan', '', `> ${STUDY_WARNING}`, '', ...studyPlanLines(plan, '###')] : []),
  ];
}

function setAsideLines(report: Report): string[] {
  if (!report.set_aside?.length) return [];
  return [
    '', '## Set aside by the evidence check', '',
    '<details>', `<summary>${count(report.set_aside.length, 'theme')} set aside</summary>`, '',
    SET_ASIDE_TEXT, '',
    ...report.set_aside.map((t) => {
      const poi = themePoi(t, report.pois);
      return `- **${line(t.title)}**${t.reworded ? ` (${REWORDED_TEXT})` : ''}${poi ? ` on ${line(poi)}` : ''} (the model's review points to ${setAsideCause(t)}): ${line(t.check?.reason ?? '')} Events: ${t.seqs.map((seq) => `#${seq}`).join(', ')}${t.validation ? ` ${outcomeLines(t)[0]}` : ''}`;
    }),
    '', '</details>',
  ];
}

/** Said wherever a flow is shown: it counts where episodes ended, and leaves the reasons to the findings. */
export const FLOW_TEXT = 'Each persona counts once per page and once per direction between two pages. "Ended here" says where an episode ended, not why.';

/** "3: 2 done, 1 abandoned": the personas who ended on a page, by outcome. */
export function flowEnded(ended: ReportFlowPage['ended'], word = (outcome: Outcome) => outcome.replaceAll('_', ' ')): string {
  const outcomes = Object.entries(ended) as [Outcome, number][];
  const total = outcomes.reduce((sum, [, n]) => sum + n, 0);
  return total ? `${total}: ${outcomes.map(([outcome, n]) => `${n} ${word(outcome)}`).join(', ')}` : '0';
}

/** The pages past the flow's cap; null when it shows them all. */
export function flowLeftOut({ left_out: { pages, ended } }: ReportFlow): string | null {
  return pages ? `${count(pages, 'less visited page')} left out, where ${count(ended, 'persona')} ended. Moves to and from them are not counted here.` : null;
}

function flowLines(report: Report): string[] {
  if (!report.flows) return [];
  return [
    '', '## Where personas went', '',
    FLOW_TEXT,
    ...report.flows.flatMap((flow) => {
      const poi = report.pois.find(({ id }) => id === flow.poi_id);
      const leftOut = flowLeftOut(flow);
      return [
        ...(report.pois.length > 1 && poi ? ['', `### ${line(poiName(poi))}`] : []),
        '', '| Page | Reached | Ended here | Moved on to |', '| --- | --- | --- | --- |',
        ...flow.pages.map(({ page, reached, ended }) => `| ${cell(page)} | ${reached} | ${flowEnded(ended)} | ${flow.moves.filter((m) => m.from === page).map((m) => `${cell(m.to)} (${m.personas})`).join(', ') || '-'} |`),
        ...(leftOut ? ['', leftOut] : []),
      ];
    }),
  ];
}

function themeToMarkdown(t: ReportTheme, heading: string, repeats: ReturnType<typeof repeatNote>, pois: Report['pois']): string[] {
  const affected = t.affected.filter((a) => a.reached > 0).map((a) => `${cell(a.name)} ${a.affected} of ${a.reached} (${pct(a.rate)})`);
  const priority = themePriority(t, pois);
  return [
    '', `${heading} ${t.rank}. ${line(t.title)}`, '',
    ...(t.reworded ? [`${REWORDED_TEXT}.`, ''] : []),
    ...(priority ? [`Suggested priority in this run: **${PRIORITY_TEXT[priority]}**`, ''] : []),
    ...outcomeLines(t),
    line(t.description), '',
    ...(t.category ? [`- Kind: ${t.category === 'objection' ? 'objection (a reason not to adopt it)' : 'friction (got in the way of the task)'}`] : []),
    ...(t.scan_only ? [`- Evidence: ${SCAN_TEXT}`] : t.prevalence ? [`- Evidence: ${t.prevalence.level}, ${shareText(t.prevalence)}${t.heard_first ? `; ${t.heard_first} more reported it only after reading about it in the feed` : ''}${t.remembered ? `; ${t.remembered} more reported it after remembering it from an earlier visit` : ''}`] : []),
    t.trust_counts ? `- Trust: ${trustMix(t.trust_counts)}` : `- Trust: ${t.trust} (${TRUST_TEXT[t.trust]})`,
    ...(repeats ? [`- Repeats: ${[repeats.appeared, repeats.one_family, repeats.trait_free].filter((text) => text !== null).map(line).join('. ')}`] : []),
    ...(repeats?.other_titles.length ? [`- Named in other runs: ${repeats.other_titles.map(line).join('; ')}`] : []),
    ...(t.interference ? [`- ${interferenceNote(t)}.`] : []),
    `- Severity ${t.severity} of 4, ${t.scan_only ? '' : `score ${t.score.toFixed(2)}, ${t.personas} persona${t.personas === 1 ? '' : 's'}, `}${t.frictions} friction${t.frictions === 1 ? '' : 's'}`,
    ...(t.scan_only ? [] : [`- Affected first-hand by segment: ${affected.join('; ') || 'none'}`]),
    ...(t.drivers ?? []).map((driver) => `- ${line(driverText(driver))}`),
    ...(t.pages.length > 0 ? [`- Pages: ${t.pages.map(line).join(', ')}`] : []),
    ...(t.elements.length > 0 ? [`- Elements: ${t.elements.map(line).join(', ')}`] : []),
    `- Events: ${t.seqs.map((seq) => `#${seq}`).join(', ')}`,
    '', 'Evidence:', '',
    ...t.evidence.map(evidenceToMarkdown),
    ...(t.suggestion
      ? ['', `**Suggested change (generated suggestion):** ${line(t.suggestion.change)}`, '', `**Possible solution (generated suggestion):** ${line(t.suggestion.solution)}`]
      : []),
  ];
}

const shareText = (p: Prevalence) => `${p.personas} of ${p.exposed} persona${p.exposed === 1 ? '' : 's'} (${pct(p.share)}, 95% range ${pct(p.low)}–${pct(p.high)})`;

/** "1 confirmed, 3 reported": how many member frictions rest on each kind of evidence. */
export const trustMix = (counts: Record<Trust, number>) => (['confirmed', 'observed', 'reported'] as const).filter((t) => counts[t] > 0).map((t) => `${counts[t]} ${t}`).join(', ');

function evidenceToMarkdown(e: ReportEvidence, i: number): string {
  const at = e.step_no === null ? 'survey' : `step ${e.step_no}`;
  const signals = e.signals.length > 0 ? `; signals: ${e.signals.join(', ')}` : '';
  return [
    `${i + 1}. ${line(e.persona_name)} (${at}, severity ${e.severity}, ${e.trust}${signals}): ${line(e.what)}`,
    ...(e.quote ? [`   - Quote: "${line(e.quote)}"`] : []),
    ...(e.scan ? [`   - Accessibility scan: ${line(scanText(e.scan))}${e.trust === 'observed' ? `. ${SCAN_TEXT}` : ''}`] : []),
    ...(e.url ? [`   - Page: ${pageUrl(e.url)}`] : []),
    ...(e.frame !== undefined ? [`   - Frame: ${e.frame + 1}`] : []),
    ...passageLine(e),
    `   - Screenshot: ${e.screenshot ?? 'none'}`,
    ...(e.box ? [`   - About: ${line(e.box.element)}`] : []),
    ...(e.interference ? [`   - Tagged ${INTERFERENCE_TEXT}.`] : []),
    `   - Event: #${e.seq}`,
  ].join('\n');
}

function sentimentLines(report: Report): string[] {
  if (!report.sentiment?.length) return [];
  return [
    '', '## Sentiment by segment', '',
    'From the end-of-episode survey, on a scale from -2 to +2 with 0 neutral.', '',
    "Users' answers only, one per persona and text, design or site they surveyed; buyers are in the buying survey.", '',
    '| Segment | Answers | Mean sentiment | Would continue |',
    '| --- | --- | --- | --- |',
    ...report.sentiment.map((s) => `| ${cell(s.name)} | ${s.surveyed} | ${s.sentiment === null ? 'no answers' : s.sentiment.toFixed(2)} | ${s.surveyed === 0 ? '-' : pct(s.would_continue)} |`),
  ];
}

const passageLine = ({ passage }: StepEvidence) =>
  passage ? [`   - Passage: characters ${passage.start}–${passage.end}${passage.text ? `, "${line(passage.text)}"` : ''}`] : [];

function buyerLines(report: Report): string[] {
  if (!report.buyers?.length) return [];
  const top = (items: { text: string; personas: number }[]) => items.slice(0, 5).map((i) => `${line(i.text)} (${count(i.personas, 'persona')})`).join('; ') || 'none';
  return [
    '', '## Buying survey', '',
    'Segments of buyers answered a buying survey after each text, design or site they looked at. Sentiment from -2 to +2 with 0 neutral.',
    ...report.pois.flatMap((poi) => {
      const rows = report.buyers!.filter((b) => b.poi_id === poi.id);
      if (rows.length === 0) return [];
      return [
        '', `### ${line(poi.name)}`, '',
        '| Segment | Surveyed | Mean sentiment | Would buy or recommend | Price: low / fair / high / unclear |',
        '| --- | --- | --- | --- | --- |',
        ...rows.map((b) => `| ${cell(b.name)} | ${b.surveyed} | ${b.sentiment.toFixed(2)} | ${pct(b.would_buy)} | ${b.price.low} / ${b.price.fair} / ${b.price.high} / ${b.price.unclear} |`),
        '',
        ...rows.flatMap((b) => [`- ${cell(b.name)}, top objections: ${top(b.objections)}`, `- ${cell(b.name)}, unclear: ${top(b.unclear)}`]),
      ];
    }),
  ];
}

function wentWellLines(report: Report): string[] {
  if (!report.went_well?.length) return [];
  return [
    '', '## What went well', '',
    ...report.went_well.map((like, i) => `${i + 1}. ${line(like.text)} (${like.prevalence ? shareText(like.prevalence) : `${like.count} mention${like.count === 1 ? '' : 's'} by ${like.personas} persona${like.personas === 1 ? '' : 's'}`})${like.description ? `: ${line(like.description)}` : ''}`),
  ];
}

const PREFERS = { product: 'Prefer the product', competitor: 'Prefer the competitor', no_preference: 'No preference' } as const;

function comparisonLines(report: Report): string[] {
  if (!report.comparisons?.length) return [];
  const name = (id: string) => line(report.pois.find((poi) => poi.id === id)?.name ?? id);
  return report.comparisons.flatMap((c) => [
    '', `## ${name(c.poi_id)} compared with ${name(c.with_poi_id)}`, '',
    `From the survey after the competitor's site, asked of personas who used ${name(c.with_poi_id)} first. "Product" is ${name(c.with_poi_id)}. ${name(c.poi_id)} was only browsed: nothing was signed up for or sent, so its side covers what a visitor sees.`, '',
    '| Segment | Compared | Prefer the product | Prefer the competitor | No preference |',
    '| --- | --- | --- | --- | --- |',
    ...c.segments.map((s) => `| ${cell(s.name)} | ${s.compared} | ${s.product} | ${s.competitor} | ${s.no_preference} |`),
    '',
    ...c.answers.map((a) => `- ${line(a.persona_name)} (${PREFERS[a.prefers].toLowerCase()}): "${line(a.reason)}" (event #${a.seq})`),
  ]);
}

function spreadLines(report: Report): string[] {
  if (!report.spread) return [];
  const name = (id: string) => line(report.personas.find((p) => p.id === id)?.name ?? id);
  return [
    '', '## Opinion spread', '',
    "How talk travelled on the simulated feed. First-hand: personas who met it before reading about it, as the theme counts them. Second-hand: personas who posted about it without meeting it first-hand. Reached: personas shown a post about it in a feed or at a step. Influence: a cited post moved a persona's sentiment by 0.5 or more, once per author and change. Heard before a change: the persona changed its mind at a step it was handed the post at, without citing it; not counted as influence.",
    ...(report.spread.length === 0 ? ['', 'No post was about a particular text, design or site.'] : []),
    ...report.spread.flatMap((poi) => [
      '', `### About ${line(poi.name)}`, '', ...spreadToMarkdown(poi, name),
      ...poi.themes.flatMap((t) => ['', `#### ${t.rank}. ${line(t.title)}`, '', ...spreadToMarkdown(t, name)]),
    ]),
  ];
}

function spreadToMarkdown(s: SpreadStats, name: (id: string) => string): string[] {
  const crossed = s.segments.filter((g) => !g.seed).length;
  return [
    `- ${count(s.posts, 'post')}; first-hand: ${count(s.first_hand.length, 'persona')}; second-hand: ${count(s.second_hand.length, 'persona')}${s.second_hand.length > 0 ? ` (${s.second_hand.map(name).join(', ')})` : ''}`,
    ...s.seeds.map((p) => `- ${p.injected ? `Post added by your team, shown as ${line(p.persona_name)}'s` : `Seed post by ${line(p.persona_name)}`}, round ${p.round}: "${line(p.text)}" (#${p.seq})`),
    ...(s.posters ? [`- Posted: ${count(s.posters.length, 'persona')}; reached: ${count(s.readers?.length ?? 0, 'persona')}`] : []),
    `- Segments reached: ${s.segments.map((g) => `${line(g.name)} ${g.personas}${g.seed ? ' (seed)' : ''}`).join(', ') || 'none'}; crossed into ${count(crossed, 'other segment')}`,
    `- Influence: ${s.influence.map((e) => `${name(e.from)} → ${name(e.to)} (round ${e.round}, ${signed(e.delta)}, #${e.seq})`).join('; ') || 'none'}`,
    ...(s.heard?.length ? [`- Heard before a change: ${s.heard.map((e) => `${name(e.from)} → ${name(e.to)} (round ${e.round}, ${signed(e.delta)}, #${e.seq})`).join('; ')}`] : []),
    `- Mean sentiment by round, -2 to +2: ${s.sentiment.map((r) => `${r.round}: ${r.mean === null ? 'no opinions' : `${signed(r.mean)} (${count(r.personas, 'persona')})`}`).join('; ')}`,
  ];
}

function segmentLines(report: Report): string[] {
  const pois = report.segments[0]?.pois ?? [];
  const name = (id: string) => cell(report.pois.find((poi) => poi.id === id)?.name ?? id);
  const started = report.personas.filter((p) => !isUnrated(p.outcome));
  const notStarted = report.personas.filter((p) => p.outcome === 'not_started').length;
  const noAnswer = report.personas.length - started.length - notStarted;
  return [
    `| Segment | Share | Personas | Completion | Ran into friction |${pois.map((p) => ` Completion: ${name(p.poi_id)} |`).join('')}`,
    `| --- | --- | --- | --- | --- |${pois.map(() => ' --- |').join('')}`,
    ...report.segments.map((s) => `| ${cell(s.name)} | ${s.share}% | ${s.personas} | ${pct(s.completion)} | ${pct(s.with_friction)} |${(s.pois ?? []).map((p) => ` ${p.personas ? `${pct(p.completion)} of ${p.personas}` : '-'} |`).join('')}`),
    '',
    'Ran into friction: a self-report, survey friction or browser signal in one of the problem themes; objections are not counted.',
    ...(pois.length ? ['A persona reached the goal only when it did so on every text, design or site it was given.'] : []),
    ...(notStarted ? [`${count(notStarted, 'persona')} did not start before the run ended and ${notStarted === 1 ? 'is' : 'are'} left out of these rates.`] : []),
    ...(noAnswer ? [`${count(noAnswer, 'persona')} got no valid model answer and ${noAnswer === 1 ? 'is' : 'are'} left out of these rates; that says nothing about the product.`] : []),
    '',
    `**Weighted by share:** completion ${pct(report.weighted.completion)}, with friction ${pct(report.weighted.with_friction)}. **Unweighted:** completion ${pct(started.length ? started.filter((p) => p.outcome === 'done').length / started.length : null)}.`,
  ];
}

// Grouped by segment, then persona. Numbers run on across the groups, so each finding has one reference.
function frictionLines(report: Report): string[] {
  if (report.frictions.length === 0) return [report.shared?.hidden ? HIDDEN_FRICTIONS : 'No frictions reported.'];
  const segmentIds = [...new Set([...report.segments.map((s) => s.id), ...report.frictions.map((f) => f.segment_id)])];
  const lines: string[] = [];
  let n = 0;
  for (const id of segmentIds) {
    const inSegment = report.frictions.filter((f) => f.segment_id === id);
    if (inSegment.length === 0) continue;
    lines.push(`### ${cell(report.segments.find((s) => s.id === id)?.name ?? 'Other personas')}`, '');
    for (const personaId of new Set(inSegment.map((f) => f.persona_id))) {
      const mine = inSegment.filter((f) => f.persona_id === personaId);
      const outcome = report.personas.find((p) => p.id === personaId)?.outcome ?? 'unknown';
      lines.push(`**${cell(mine[0].persona_name)}** (${outcome})`, '');
      for (const friction of mine) lines.push(frictionToMarkdown(friction, n++), '');
    }
  }
  return lines.slice(0, -1); // the report adds the blank line that ends the section
}

function frictionToMarkdown(friction: ReportFriction, index: number): string {
  return [
    `${index + 1}. Step ${friction.step_no}, severity ${friction.severity}: ${line(friction.what)}`,
    `   - Expected: ${line(friction.expected)}`,
    ...(friction.quote ? [`   - Quote: "${line(friction.quote)}"`] : []),
    ...passageLine(friction),
    `   - Page: ${pageUrl(friction.url)}`,
    ...(friction.frame !== undefined ? [`   - Frame: ${friction.frame + 1}`] : []),
    `   - Screenshot: ${friction.screenshot ?? 'none'}`,
  ].join('\n');
}

/** Said wherever a report names grounded segments, because real data makes personas look more credible whether or not they are more accurate. */
export const GROUNDING_NOTE = 'Grounded personas are still fictional, and their findings are still hypotheses.';

/** The notice on a returning run: how the report and the app say what its personas knew, and who had nothing to remember. */
export const priorNotice = ({ run_id, fresh }: NonNullable<ReportMethods['prior']>) =>
  `These personas used the product before, in ${run_id}, so this run says little about first use.${fresh ? ` ${count(fresh, 'persona')} had no earlier visit to remember and started fresh.` : ''}`;

export const groundingText = ({ name, facts, remarks, sources }: NonNullable<ReportMethods['grounding']>[number]) =>
  `${name}: ${count(sources.length, 'source')} (${sources.join(', ')}), ${count(facts, 'fact')}, ${count(remarks, 'remark')}`;

function methodsToMarkdown(m: ReportMethods): string[] {
  const models = [...Object.entries(m.models), ...(m.check_model ? [['evidence check', m.check_model] as const] : [])].map(([role, choice]) => `${role} ${choice?.model} (${choice?.provider})`);
  const blocked = m.blocked.map(
    (b) =>
      `- Blocked at step ${b.step_no}, persona ${b.persona_id} (${b.reason}, ${b.resumed ? 'resumed' : 'not resumed'}): ${line(b.detail)}`,
  );
  const tripwires = m.tripwires.map((t) => `- Tripwire (${t.kind}): ${line(t.detail)}`);
  return [
    `- Seed: ${m.seed}`,
    `- Roles: ${m.roles.join(', ') || 'none, browsing logged out'}`,
    `- Models: ${models.join('; ') || 'none called'}`,
    `- Budgets: $${m.budgets.cost_usd.toFixed(2)} cost, ${m.budgets.wall_clock_min} min wall clock, concurrency ${m.budgets.concurrency}`,
    `- Concurrency changes: ${m.concurrency_changes.map((c) => `${c.concurrency} (${line(c.reason)})`).join('; ') || 'none'}`,
    `- Allowed hosts: ${m.allowed_hosts.join(', ') || 'none'}`,
    `- Blocked requests: ${m.blocked_requests.map((r) => `${r.host} (${r.count}${r.reason ? `, ${BLOCK_REASON_TEXT[r.reason]}` : ''})`).join(', ') || 'none'}`,
    ...(blocked.length > 0 ? blocked : ['- Blocked personas: none']),
    ...(tripwires.length > 0 ? tripwires : ['- Tripwires: none']),
    `- Reset hook: ${resetToMarkdown(m.reset)}`,
    ...(m.signal_thresholds === undefined ? [] : [`- Signal thresholds: ${m.signal_thresholds === null ? 'not frozen in this run' : Object.entries(m.signal_thresholds).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ')}`]),
    ...(m.undersized_targets ? [`- Undersized tap targets on your product (an audit, not findings; only elements a mobile persona tapped): ${m.undersized_targets.map((t) => `${line(t.page)}, ${t.element ? line(t.element) : 'unnamed element'}, ${t.width}×${t.height} px, ${count(t.personas, 'persona')}`).join('; ')}`] : []),
    ...(m.accessibility_audit ? [`- Accessibility audit of your product (an audit, not findings; the moderate and minor rules the page scan flagged, not ranked): ${m.accessibility_audit.map((a) => `${line(a.page)}, ${line(a.help)} (${line(scanText(a))})`).join('; ')}`] : []),
    ...(m.grounding ? [`- Grounded segments: ${m.grounding.map((segment) => line(groundingText(segment))).join('; ')}. ${GROUNDING_NOTE}`] : []),
    ...(m.prior ? [`- Earlier visit: ${priorNotice(m.prior)}`] : []),
    ...(m.homogeneity ? [
      `- Homogeneity (mean pairwise TF-IDF cosine, warning at ${m.homogeneity.threshold.toFixed(2)}): posts ${m.homogeneity.posts === null ? 'too few to compare' : m.homogeneity.posts.toFixed(2)} (${count(m.homogeneity.post_count, 'post')}), persona backgrounds ${m.homogeneity.narratives === null ? 'too few to compare' : m.homogeneity.narratives.toFixed(2)}`,
      ...(m.homogeneity.warning ? [`- Homogeneity warning: ${line(m.homogeneity.warning)}`] : []),
    ] : []),
    ...(m.limitations?.length ? m.limitations.map((l) => `- Limitation: ${line(l)}`) : m.limitations ? ['- Limitations: none'] : []),
  ];
}

function resetToMarkdown(reset: ReportMethods['reset']): string {
  if (reset === null) return 'not called';
  if (reset.error !== null) return `${reset.url}, failed: ${line(reset.error)}`;
  return `${reset.url}, ${reset.status === null ? 'no response' : `HTTP ${reset.status}`}`;
}
