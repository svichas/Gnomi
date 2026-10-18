import type { Report } from '../types.ts';
import type { ComparisonEvidence } from '../comparison/types.ts';
import { comparisonDecisionLabels, comparisonEvidenceCatalog, comparisonEvidenceKey } from './comparisonPresentation.ts';

const line = (text: string) => text.replace(/\s+/g, ' ').trim().replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const cell = (text: string) => line(text).replaceAll('|', '\\|');
const label = (text: string) => text.replaceAll('_', ' ');

/** The same report projection and deduplicated source claims used by the interactive reader. */
export function comparisonMarkdown(report: Report, methods: string[]): string {
  const comparison = report.comparison!, { study } = comparison;
  const shared = study.execution.collection === 'shared_research';
  const target = (id: string) => study.targets.find((item) => item.id === id)?.name ?? id;
  const criterion = (id: string) => study.criteria.find((item) => item.id === id)!;
  const scenarioName = (id: string) => study.scenarios.find((item) => item.id === id)?.name ?? id;
  const scope = (item: { scenario_id: string; task_id?: string; segment_id: string | null }) => `${scenarioName(item.scenario_id)} / ${shared ? 'Shared company evidence' : report.segments.find((segment) => segment.id === item.segment_id)?.name ?? item.segment_id ?? 'Built-in persona'}${item.task_id ? ` / ${item.task_id}` : ''}`;
  const catalog = comparisonEvidenceCatalog(comparison.cells);
  const citations = (seqs: number[], records?: ComparisonEvidence[]) => {
    const keys = records ? new Set(records.map(comparisonEvidenceKey)) : null;
    const entries = catalog.filter((entry) => entry.captures.some((capture) => keys ? keys.has(comparisonEvidenceKey(capture)) : seqs.includes(capture.event_seq)));
    const missing = seqs.filter((seq) => !entries.some((entry) => entry.captures.some((capture) => capture.event_seq === seq)));
    return [...entries.map((entry) => `[Evidence ${entry.id.replace('comparison-evidence-', '')}](#${entry.id})`), ...new Set(missing.map((seq) => `event #${seq}`))].join(' ');
  };
  const groups = [...new Set(comparison.cells.map((item) => JSON.stringify([item.scenario_id, item.task_id, item.segment_id, item.access_scope])))];
  const brief = study.decision_context;
  return [
    `# Gnomi comparison: ${line(study.question)}`, '', `> ${report.banner}`, '', '## Decision and scope', '',
    `**${comparisonDecisionLabels[comparison.decision.status]}**`, '', line(comparison.decision.summary), '',
    `- Purpose: ${label(study.purpose)}${study.focal_target_id ? `; focal tool: ${line(target(study.focal_target_id))}` : ''}`,
    `- Collection: ${shared ? 'Shared source research; source reviews are not independent persona attempts.' : 'Persona tasks'}`,
    `- Mode: ${label(study.execution.mode)}; carryover: ${label(study.execution.carryover)}; social: ${study.execution.social}`,
    `- Targets: ${study.targets.map((item) => `${line(item.name)} (${label(item.access_scope)})`).join('; ')}`,
    `- Status: ${report.status}${report.stop_reason ? ` (${line(report.stop_reason)})` : ''}`,
    ...(brief ? ['', '### Company decision brief', '', ...[
      ['Company size', brief.company_size], ['Hiring volume', brief.hiring_volume], ['Budget', brief.budget], ['Required integrations', brief.required_integrations.join(', ')], ['Must-have requirements', brief.requirements.join('; ')], ['Switching constraints', brief.switching_constraints],
    ].map(([name, value]) => `- ${name}: ${line(value || 'Unspecified; remains unknown')}`)] : []),
    ...(comparison.decision.scenarios ?? []).flatMap((decision) => [
      '', `### ${line(scope(decision))}`, '', ...(comparison.decision.scenarios!.length > 1 ? [line(decision.summary), ''] : []),
      ...decision.reasons.map((reason) => `- **Why:** ${line(reason.text)} ${citations(reason.evidence_seqs)}`),
      ...decision.alternatives.map((alternative) => `- **${line(target(alternative.target_id))}:** ${line(alternative.condition)} ${citations(alternative.evidence_seqs)}`),
      ...decision.unresolved.map((item) => `- **Unresolved:** ${line(item.summary)} **What would change the choice:** ${line(item.changes_choice)}`),
    ]),
    '', '## Side-by-side comparison', '',
    ...groups.flatMap((group) => {
      const [scenario_id, task_id, segment_id, access_scope] = JSON.parse(group) as [string, string, string | null, string];
      const rows = comparison.cells.filter((item) => item.scenario_id === scenario_id && item.task_id === task_id && item.segment_id === segment_id && item.access_scope === access_scope);
      const task = study.tasks.find((item) => item.id === task_id)!;
      const criteria = study.criteria.filter((item) => task.criterion_ids.includes(item.id));
      return ['', `### ${line(scope({ scenario_id, task_id, segment_id }))} — ${label(access_scope)}`, '',
        `Context: ${line(study.scenarios.find((item) => item.id === scenario_id)?.context ?? '')}`, `Task: ${line(task.instruction)}`, `Success rule: ${line(task.success_rule)}`, '',
        `| Criterion | ${study.targets.map((item) => cell(item.name)).join(' | ')} |`, `| --- | ${study.targets.map(() => '---').join(' | ')} |`,
        ...criteria.map((item) => `| ${cell(item.name)} (${label(item.importance)}) | ${study.targets.map((target) => {
          const value = rows.find((row) => row.target_id === target.id && row.criterion_id === item.id);
          if (!value) return target.access_scope !== access_scope ? `Different access scope: ${label(target.access_scope)}; see its separate matrix.` : 'Unknown: no assessment recorded for this scope.';
          return `${label(value.assessment)}: ${cell(value.summary)}; ${value.assessed}/${value.eligible} ${shared ? 'source reviews' : 'episodes'} assessed; ${value.distinct_sources} distinct source(s); basis: ${value.bases.map(label).join(', ') || 'none'}. ${citations(value.evidence.map((entry) => entry.event_seq), value.evidence)}`;
        }).join(' | ')} |`), '',
        ...criteria.map((item) => `- **${line(item.name)} assessment rule:** ${line(item.decision_rule)} Required evidence: ${line(item.evidence_required)} Question: ${line(item.question)}`),
      ];
    }),
    '', '## Where each tool fits', '',
    ...comparison.fits.flatMap((fit) => [`### ${line(target(fit.target_id))}: ${label(fit.status)}`, '', `Scope: ${line(scope(fit))}`, '', `- Supported strengths: ${fit.strengths.map(line).join('; ') || 'none established'}`, `- Gaps: ${fit.gaps.map(line).join('; ') || 'none established'}`, `- Unresolved: ${fit.unknowns.map(line).join('; ') || 'none in these criteria'}`, '']),
    ...(comparison.tradeoffs.length ? ['', '### Supported tradeoffs and parity', '', ...comparison.tradeoffs.map((item) => `- **${label(item.result)}** (${line(scope(item))}): ${line(item.summary)} ${citations(item.evidence_seqs)}`)] : []),
    '', '## Next actions', '',
    ...(comparison.actions.length ? comparison.actions.flatMap((action, i) => [
      `${i + 1}. **${line(action.action)}**`, `   - Responsible: ${label(action.owner)}; ${(action.scopes ?? [action]).map(scope).map(line).join('; ')}`,
      `   - Evidence: ${line(action.rationale)} ${citations(action.evidence_seqs)}`, `   - Expected benefit (hypothesis): ${line(action.expected_benefit)}`,
      `   - Validate: ${line(action.validation)}`, ...(action.changes_choice ? [`   - What would change the choice: ${line(action.changes_choice)}`] : []), '',
    ]) : ['No unresolved check is prioritized from the tested criteria. Review the supported selection conditions.']),
    '', '## Coverage and evidence', '',
    `Counts describe ${shared ? 'shared source reviews, not independent personas' : 'persona/task episodes'}. Completion = completed / (completed + task failed + abandoned). Blocked, incomplete, invalid, not applicable and not attempted are excluded and remain visible.`, '',
    '| Tool / scope | Scheduled | Attempted | Completed | Failed | Abandoned | Blocked | Incomplete | Invalid task | Not applicable | Not attempted | Valid attempts | Completion |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...comparison.coverage.map((row) => `| ${cell(target(row.target_id))} / ${cell(scope(row))} / ${label(row.access_scope)} | ${row.scheduled} | ${row.attempted} | ${row.outcomes.completed} | ${row.outcomes.task_failed} | ${row.outcomes.abandoned} | ${row.outcomes.blocked_environment} | ${row.outcomes.incomplete} | ${row.outcomes.invalid_task} | ${row.outcomes.not_applicable} | ${row.outcomes.not_attempted} | ${row.valid_attempts} | ${row.completion_rate === null ? 'Unavailable' : `${Math.round(row.completion_rate * 100)}%`} |`),
    '', '### Recorded episode outcomes and causes', '',
    ...comparison.coverage.flatMap((row) => (row.episodes ?? []).map((episode) => `- ${line(target(row.target_id))} / ${line(scope(row))}: **${label(episode.outcome)}** — ${line(episode.reason)} Trace: start ${episode.start_seq ?? 'not recorded'}, finish ${episode.finish_seq ?? 'not recorded'}; collector/persona ${line(episode.persona_id)}; episode ${line(episode.episode_id)}. ${citations(episode.evidence_seqs)}`)),
    '', ...comparison.pairs.map((pair) => `- Comparable pairs, ${line(target(pair.target_ids[0]))} / ${line(target(pair.target_ids[1]))}, ${line(scope(pair))}: ${pair.matched}; completion difference ${pair.completion_difference === null ? 'unavailable' : `${(pair.completion_difference * 100).toFixed(1)} percentage points (first minus second)`}.`),
    '', '### Captured source claims', '',
    ...catalog.flatMap(({ id, evidence, cell: item, captures }) => [
      `<a id="${id}"></a>`, `- **${line(target(item.target_id))} / ${line(criterion(item.criterion_id).name)}** (${label(evidence.basis)}); ${captures.length} recorded capture(s), not independent verification.`,
      `  - Source: ${line(evidence.source)}`, `  - Excerpt: “${line(evidence.quote)}”`,
      ...captures.map((capture) => `  - Event #${capture.event_seq}; assessment #${capture.assessment_seq}; persona ${line(capture.persona_id)}; episode ${line(capture.episode_id)}; captured ${new Date(capture.captured_at).toISOString()}; screenshot ${line(capture.screenshot ?? 'none')}. Proposition: ${line(capture.proposition)}`), '',
    ]),
    '', '### Assessment limits and uncited observations', '',
    ...comparison.cells.flatMap((item) => [
      ...item.limitations.map((limit) => `- ${line(target(item.target_id))} / ${line(scope(item))} / ${line(criterion(item.criterion_id).name)}: ${line(limit)}`),
      ...(item.observations ?? []).filter((observation) => !observation.evidence_seqs.length).map((observation) => `- Assessment #${observation.assessment_seq}, ${line(target(item.target_id))} / ${line(scope(item))}: ${label(observation.assessment)} — ${line(observation.summary)}`),
    ]),
    '', '### Recorded target orders', '', ...comparison.orders.map((order) => `- ${line(order.persona_id)}, ${line(order.task_id)}: ${order.target_order.map(target).map(line).join(' → ')}`),
    '', '### Limitations', '', ...comparison.limitations.map((item) => `- ${line(item)}`), ...comparison.rejected_assessments.map((item) => `- Rejected assessment #${item.seq}: ${line(item.reason)}`),
    '', '## Cost and methods', '', `- Recorded cost: $${report.cost_usd.toFixed(4)}`, `- Model calls: ${report.llm_calls}; tokens: ${report.input_tokens} in / ${report.output_tokens} out`,
    ...((report.unreported_usage_calls ?? 0) > 0 ? [`- ${report.unreported_usage_calls} calls did not report complete usage; actual charges may exceed recorded cost.`] : []), ...methods, '',
  ].join('\n');
}
