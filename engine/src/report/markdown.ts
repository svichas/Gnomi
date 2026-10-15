import type { Report, ReportFriction } from '../types.ts';

// Free text from the model can hold line breaks, which would split a Markdown list item.
const line = (text: string) => text.replace(/\s+/g, ' ').trim();

export function reportToMarkdown(report: Report): string {
  const status = report.stop_reason === null ? report.status : `${report.status} (${report.stop_reason})`;
  const outcome = report.outcome_text === null ? report.outcome : `${report.outcome}: ${line(report.outcome_text)}`;
  const frictions = report.frictions.length === 0 ? ['No frictions reported.'] : report.frictions.map(frictionToMarkdown);
  const duration = report.duration_ms === null ? 'not finished' : `${(report.duration_ms / 1000).toFixed(1)} s`;
  return [
    `# Gnomi report: ${report.goal}`,
    '',
    `> ${report.banner}`,
    '',
    `- Point of interest: ${report.poi.name} (${report.poi.start_url})`,
    `- Persona: ${report.persona.name}, ${report.persona.job_title}, ${report.persona.device}`,
    `- Steps: ${report.steps}`,
    `- Outcome: ${outcome}`,
    `- Status: ${status}`,
    '',
    '## Frictions',
    '',
    ...frictions,
    '',
    '## Cost and time',
    '',
    `- Cost: $${report.cost_usd.toFixed(4)}`,
    `- Tokens: ${report.input_tokens} in, ${report.output_tokens} out`,
    `- LLM calls: ${report.llm_calls}`,
    `- Duration: ${duration}`,
    '',
  ].join('\n');
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
