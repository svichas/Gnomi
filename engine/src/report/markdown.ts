import type { Report, ReportFriction, ReportMethods, ReportSegment } from '../types.ts';
import { formatAttributeValue } from './dimensions.ts';

// Free text from the model can hold line breaks, which would split a Markdown list item or a table row.
const line = (text: string) => text.replace(/\s+/g, ' ').trim();
const cell = (text: string) => line(text).replace(/\|/g, '\\|');
const pct = (rate: number) => `${Math.round(rate * 100)}%`;

export function reportToMarkdown(report: Report): string {
  const status = report.stop_reason === null ? report.status : `${report.status} (${report.stop_reason})`;
  const duration = report.duration_ms === null ? 'not finished' : `${(report.duration_ms / 1000).toFixed(1)} s`;
  return [
    `# Gnomi report: ${report.goal}`,
    '',
    `> ${report.banner}`,
    '',
    `- Point of interest: ${report.poi.name} (${report.poi.start_url})`,
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
    '',
    '## Frictions',
    '',
    ...frictionLines(report),
    '',
    '## Cost and time',
    '',
    `- Cost: $${report.cost_usd.toFixed(4)}`,
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
  ];
}

function resetToMarkdown(reset: ReportMethods['reset']): string {
  if (reset === null) return 'not called';
  if (reset.error !== null) return `${reset.url}, failed: ${line(reset.error)}`;
  return `${reset.url}, ${reset.status === null ? 'no response' : `HTTP ${reset.status}`}`;
}
