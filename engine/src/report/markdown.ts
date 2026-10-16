import type { Report, ReportEvidence, ReportFriction, ReportMethods, ReportSegment, ReportTheme, SpreadStats, StepEvidence } from '../types.ts';
import { formatAttributeValue } from './dimensions.ts';

// Free text from the model can hold line breaks, which would split a Markdown list item or a table row.
const line = (text: string) => text.replace(/\s+/g, ' ').trim();
const cell = (text: string) => line(text).replace(/\|/g, '\\|');
const pct = (rate: number) => `${Math.round(rate * 100)}%`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}`;

export function reportToMarkdown(report: Report): string {
  const status = report.stop_reason === null ? report.status : `${report.status} (${report.stop_reason})`;
  const duration = report.duration_ms === null ? 'not finished' : `${(report.duration_ms / 1000).toFixed(1)} s`;
  return [
    `# Gnomi report: ${report.goal}`,
    '',
    `> ${report.banner}`,
    '',
    `- Point${report.pois.length === 1 ? '' : 's'} of interest: ${report.pois.map((poi) => (poi.start_url ? `${poi.name} (${poi.start_url})` : poi.name)).join(', ')}`,
    `- Personas: ${report.personas.length}, steps: ${report.steps}`,
    `- Status: ${status}`,
    '',
    '## Segments',
    '',
    '| Segment | Share | Personas | Completion | With friction |',
    '| --- | --- | --- | --- | --- |',
    ...report.segments.map(segmentRow),
    '',
    `**Weighted by share:** completion ${pct(report.weighted.completion)}, with friction ${pct(report.weighted.with_friction)}.`,
    ...dimensionLines(report),
    ...themeLines(report),
    ...sentimentLines(report),
    ...buyerLines(report),
    ...wentWellLines(report),
    ...spreadLines(report),
    '',
    '## Frictions',
    '',
    ...frictionLines(report),
    '',
    '## Cost and time',
    '',
    `- Recorded cost: $${report.cost_usd.toFixed(4)}`,
    ...((report.unreported_usage_calls ?? 0) > 0 ? [
      `- ${report.unreported_usage_calls} model call${report.unreported_usage_calls === 1 ? '' : 's'} did not report complete usage. Canceled or failed requests may still incur provider charges. Actual charges may exceed the recorded cost.`,
    ] : []),
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

function dimensionLines(report: Report): string[] {
  if (!report.dimensions?.length) return [];
  return [
    '', '## Results by profile', '',
    'Each row counts personas with that exact value, without segment weighting. Mean latest feeling uses each persona’s latest valid step feeling, from -2 to 2; personas without one are excluded. Lists are grouped as an ordered whole.',
    ...report.dimensions.flatMap((dimension) => [
      '', `### ${cell(dimension.name)}`, '',
      '| Value | Personas | Completion | With friction | Mean latest feeling |',
      '| --- | --- | --- | --- | --- |',
      ...dimension.values.map((group) => `| ${cell(formatAttributeValue(group.value))} | ${group.personas} | ${pct(group.completion)} | ${pct(group.with_friction)} | ${group.sentiment === null ? 'No recorded feeling' : group.sentiment.toFixed(2)} |`),
    ]),
  ];
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
    'Ranked by segment-weighted affected share × median severity × trust. Trust is a label within the simulation, not validation by real people: confirmed is a self-report backed by an objective signal, observed a signal only, reported a self-report only.',
    // Themes are ranked within each POI, so several POIs get a section each.
    ...(report.pois.length > 1
      ? report.pois.flatMap((poi) => {
          const themes = report.themes!.filter((t) => t.poi_id === poi.id);
          return ['', `### ${line(poi.name)}`, ...(themes.length ? themes.flatMap((t) => themeToMarkdown(t, '####')) : ['', 'No frictions to group into themes.'])];
        })
      : report.themes.flatMap((theme) => themeToMarkdown(theme))),
  ];
}

function themeToMarkdown(t: ReportTheme, heading = '###'): string[] {
  const affected = t.affected.filter((a) => a.reached > 0).map((a) => `${cell(a.name)} ${a.affected} of ${a.reached} (${pct(a.rate)})`);
  return [
    '', `${heading} ${t.rank}. ${line(t.title)}`, '',
    line(t.description), '',
    `- Trust: ${t.trust} (${TRUST_TEXT[t.trust]})`,
    `- Severity ${t.severity} of 4, score ${t.score.toFixed(2)}, ${t.personas} persona${t.personas === 1 ? '' : 's'}, ${t.frictions} friction${t.frictions === 1 ? '' : 's'}`,
    `- Affected by segment: ${affected.join('; ') || 'none'}`,
    ...(t.pages.length > 0 ? [`- Pages: ${t.pages.join(', ')}`] : []),
    ...(t.elements.length > 0 ? [`- Elements: ${t.elements.map(line).join(', ')}`] : []),
    `- Events: ${t.seqs.map((seq) => `#${seq}`).join(', ')}`,
    '', 'Evidence:', '',
    ...t.evidence.map(evidenceToMarkdown),
    ...(t.suggestion
      ? ['', `**Suggested change (generated suggestion):** ${line(t.suggestion.change)}`, '', `**Possible solution (generated suggestion):** ${line(t.suggestion.solution)}`]
      : []),
  ];
}

function evidenceToMarkdown(e: ReportEvidence, i: number): string {
  const at = e.step_no === null ? 'survey' : `step ${e.step_no}`;
  const signals = e.signals.length > 0 ? `; signals: ${e.signals.join(', ')}` : '';
  return [
    `${i + 1}. ${line(e.persona_name)} (${at}, severity ${e.severity}, ${e.trust}${signals}): ${line(e.what)}`,
    ...(e.quote ? [`   - Quote: "${line(e.quote)}"`] : []),
    ...(e.url ? [`   - Page: ${e.url}`] : []),
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
    '| Segment | Surveyed | Mean sentiment | Would continue |',
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
    'Segments of buyers answered a buying survey after each point of interest. Sentiment from -2 to +2 with 0 neutral.',
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
    ...report.went_well.map((like, i) => `${i + 1}. ${line(like.text)} (${like.count} mention${like.count === 1 ? '' : 's'} by ${like.personas} persona${like.personas === 1 ? '' : 's'})`),
  ];
}

function spreadLines(report: Report): string[] {
  if (!report.spread) return [];
  const name = (id: string) => line(report.personas.find((p) => p.id === id)?.name ?? id);
  return [
    '', '## Opinion spread', '',
    "How talk travelled on the simulated feed. First-hand: personas with their own friction in it. Second-hand: personas who posted about it without one. Influence: a cited post moved a persona's sentiment by 0.5 or more.",
    ...(report.spread.length === 0 ? ['', 'No post was about a point of interest.'] : []),
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
    `- Segments reached: ${s.segments.map((g) => `${line(g.name)} ${g.personas}${g.seed ? ' (seed)' : ''}`).join(', ') || 'none'}; crossed into ${count(crossed, 'other segment')}`,
    `- Influence: ${s.influence.map((e) => `${name(e.from)} → ${name(e.to)} (round ${e.round}, ${signed(e.delta)}, #${e.seq})`).join('; ') || 'none'}`,
    `- Mean sentiment by round, -2 to +2: ${s.sentiment.map((r) => `${r.round}: ${r.mean === null ? 'no opinions' : `${signed(r.mean)} (${count(r.personas, 'persona')})`}`).join('; ')}`,
  ];
}

function segmentRow(s: ReportSegment): string {
  return `| ${cell(s.name)} | ${s.share}% | ${s.personas} | ${pct(s.completion)} | ${pct(s.with_friction)} |`;
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
    `   - Page: ${friction.url}`,
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
    `- Blocked requests: ${m.blocked_requests.map((r) => `${r.host} (${r.count})`).join(', ') || 'none'}`,
    ...(blocked.length > 0 ? blocked : ['- Blocked personas: none']),
    ...(tripwires.length > 0 ? tripwires : ['- Tripwires: none']),
    `- Reset hook: ${resetToMarkdown(m.reset)}`,
    ...(m.signal_thresholds === undefined ? [] : [`- Signal thresholds: ${m.signal_thresholds === null ? 'not frozen in this run' : Object.entries(m.signal_thresholds).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ')}`]),
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
