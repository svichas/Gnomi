import { isUnrated } from '../types.ts';
import type { Prevalence, Report, ReportEvidence, ReportFriction, ReportMethods, ReportTheme, SpreadStats, StepEvidence, Trust } from '../types.ts';
import { formatAttributeValue } from './dimensions.ts';

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

/** Why containment blocked requests, for the methods appendix; no reason means a host outside the allowed ones. */
export const BLOCK_REASON_TEXT = { observe_only: 'writes refused, observed only', robots: 'disallowed by robots.txt' } as const;

export function reportToMarkdown(report: Report): string {
  if (report.comparison) return comparisonToMarkdown(report);
  const status = report.stop_reason === null ? report.status : `${report.status} (${report.stop_reason})`;
  const duration = report.duration_ms === null ? 'not finished' : `${(report.duration_ms / 1000).toFixed(1)} s`;
  const missingUsage = missingUsageText(report.unreported_usage_calls);
  return [
    `# Gnomi report: ${report.goal}`,
    '',
    `> ${report.banner}`,
    '',
    `- Tried: ${report.pois.map((poi) => (poi.start_url ? `${poiName(poi)} (${poi.start_url})` : poiName(poi))).join(', ')}`,
    `- Personas: ${report.personas.length}, steps: ${report.steps}`,
    `- Status: ${status}`,
    '',
    '## Segments',
    '',
    ...segmentLines(report),
    ...dimensionLines(report),
    ...themeLines(report),
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
    ...methodsToMarkdown(report.methods),
    '',
  ].join('\n');
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

function themeLines(report: Report): string[] {
  if (!report.themes) return [];
  if (report.themes.length === 0) return ['', '## Themes', '', 'No frictions to group into themes.'];
  return [
    '', '## Themes', '',
    "The judge model is asked to put the findings one concrete product change would remove in one theme, so a cause seen on several pages is one theme; a friction and an objection never share one. Ranked by evidence first (strong, then some, then single, then none), so a problem one persona reported never ranks above one several met first-hand; within the same evidence, by severity (the median over personas of each one's worst); within a severity, by the low end of the share of personas who met it first-hand × the mean trust of its personas. The share counts the personas who reached its pages (for buyer objections, the buyers surveyed); its 95% Wilson range is among this run's simulated personas, assuming independent personas; not an estimate of real users. Evidence is strong with three or more personas and at least a quarter of those, some with two or more, single with one, none when every report followed a feed post. Trust is a label within the simulation, not validation by real people: confirmed is a self-report backed by an objective signal, observed a signal only, reported a self-report only.",
    // Themes are ranked within each POI, so several POIs get a section each.
    ...(report.pois.length > 1
      ? report.pois.flatMap((poi) => {
          const themes = report.themes!.filter((t) => t.poi_id === poi.id);
          return ['', `### ${line(poiName(poi))}`, ...(themes.length ? themes.flatMap((t) => themeToMarkdown(t, '####')) : ['', 'No frictions to group into themes.'])];
        })
      : report.themes.flatMap((theme) => themeToMarkdown(theme))),
  ];
}

function themeToMarkdown(t: ReportTheme, heading = '###'): string[] {
  const affected = t.affected.filter((a) => a.reached > 0).map((a) => `${cell(a.name)} ${a.affected} of ${a.reached} (${pct(a.rate)})`);
  return [
    '', `${heading} ${t.rank}. ${line(t.title)}`, '',
    line(t.description), '',
    ...(t.category ? [`- Kind: ${t.category === 'objection' ? 'objection (a reason not to adopt it)' : 'friction (got in the way of the task)'}`] : []),
    ...(t.prevalence ? [`- Evidence: ${t.prevalence.level}, ${shareText(t.prevalence)}${t.heard_first ? `; ${t.heard_first} more reported it only after reading about it in the feed` : ''}`] : []),
    t.trust_counts ? `- Trust: ${trustMix(t.trust_counts)}` : `- Trust: ${t.trust} (${TRUST_TEXT[t.trust]})`,
    `- Severity ${t.severity} of 4, score ${t.score.toFixed(2)}, ${t.personas} persona${t.personas === 1 ? '' : 's'}, ${t.frictions} friction${t.frictions === 1 ? '' : 's'}`,
    `- Affected first-hand by segment: ${affected.join('; ') || 'none'}`,
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
    ...(e.url ? [`   - Page: ${pageUrl(e.url)}`] : []),
    ...(e.frame !== undefined ? [`   - Frame: ${e.frame + 1}`] : []),
    ...passageLine(e),
    `   - Screenshot: ${e.screenshot ?? 'none'}`,
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
    ...s.seeds.map((p) => `- Seed post by ${line(p.persona_name)}, round ${p.round}${p.injected ? ', injected by the test harness' : ''}: "${line(p.text)}" (#${p.seq})`),
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
  if (report.frictions.length === 0) return ['No frictions reported.'];
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
    `   - Quote: "${line(friction.quote)}"`,
    ...passageLine(friction),
    `   - Page: ${pageUrl(friction.url)}`,
    ...(friction.frame !== undefined ? [`   - Frame: ${friction.frame + 1}`] : []),
    `   - Screenshot: ${friction.screenshot ?? 'none'}`,
  ].join('\n');
}

function methodsToMarkdown(m: ReportMethods): string[] {
  const models = Object.entries(m.models).map(([role, choice]) => `${role} ${choice?.model} (${choice?.provider})`);
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
    ...(m.undersized_targets ? [`- Undersized tap targets (an audit, not findings): ${m.undersized_targets.map((t) => `${line(t.page)}, ${t.element ? line(t.element) : 'unnamed element'}, ${t.width}×${t.height} px, ${count(t.personas, 'persona')}`).join('; ')}`] : []),
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
