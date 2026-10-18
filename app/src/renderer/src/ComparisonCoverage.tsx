import type { ComparisonOutcome, ComparisonReport } from '@gnomi/simulation/comparison/types.ts';

export const ACCESS_LABELS = {
  public_site: 'Public-site evaluation',
  documentation: 'Documentation review',
  prototype: 'Prototype evaluation',
  authenticated_workflow: 'Authenticated workflow',
};
const OUTCOME_LABELS: Record<ComparisonOutcome, string> = {
  completed: 'Completed', task_failed: 'Task failed', abandoned: 'Abandoned', blocked_environment: 'Environment blocked',
  incomplete: 'Incomplete', invalid_task: 'Invalid task', not_applicable: 'Not applicable', not_attempted: 'Not attempted',
};
const outcomes = Object.keys(OUTCOME_LABELS) as ComparisonOutcome[];

export function ComparisonCoverage({ comparison, targetName, scopeName, personaName, taskName, inFile }: {
  comparison: ComparisonReport;
  targetName: (id: string) => string;
  scopeName: (scope: { scenario_id: string; task_id: string; segment_id: string | null }) => string;
  personaName: (id: string) => string;
  taskName: (id: string) => string;
  inFile: boolean;
}) {
  return <section aria-labelledby="comparison-coverage-title" className="space-y-4">
    <div className="space-y-1">
      <h3 id="comparison-coverage-title" className="text-base font-semibold text-stone-900">Coverage and limitations</h3>
      <p className="text-sm text-stone-600">Completion uses completed, failed and abandoned valid attempts. Environment blocks, incomplete or invalid tasks and unattempted work are excluded and remain visible below.</p>
    </div>
    <div className="overflow-x-auto rounded-lg border border-stone-200" role="region" aria-label="Task coverage by target" tabIndex={0}>
      <table className="w-full min-w-160 text-left text-sm">
        <thead className="bg-stone-50 text-xs text-stone-600"><tr>
          <th scope="col" className="p-3">Target and task scope</th><th scope="col" className="p-3">Scheduled / attempted</th>
          <th scope="col" className="p-3">Completion / valid attempts</th><th scope="col" className="p-3">Every outcome</th>
        </tr></thead>
        <tbody className="divide-y divide-stone-200">{comparison.coverage.map((row) => <tr key={JSON.stringify([row.target_id, row.scenario_id, row.task_id, row.segment_id, row.access_scope])}>
          <th scope="row" className="p-3 align-top font-normal"><strong className="font-medium">{targetName(row.target_id)}</strong><span className="mt-1 block text-xs text-stone-600">{scopeName(row)}<br />{ACCESS_LABELS[row.access_scope]}</span></th>
          <td className="p-3 align-top tabular-nums">{row.scheduled} / {row.attempted}</td>
          <td className="p-3 align-top tabular-nums">{row.outcomes.completed} / {row.valid_attempts}<span className="block text-xs text-stone-600">{row.completion_rate === null ? 'Rate unavailable' : `${Math.round(row.completion_rate * 100)}% of valid attempts`}</span></td>
          <td className="p-3 align-top"><dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">{outcomes.map((outcome) => <div key={outcome} className="contents"><dt>{OUTCOME_LABELS[outcome]}</dt><dd className="text-right tabular-nums">{row.outcomes[outcome]}</dd></div>)}</dl></td>
        </tr>)}</tbody>
      </table>
    </div>
    {comparison.pairs.length > 0 && <div className="space-y-2">
      <h4 className="text-sm font-medium text-stone-900">Matched task comparisons</h4>
      <ul className="space-y-2 text-sm text-stone-700">{comparison.pairs.map((pair, i) => <li key={i}>
        <span className="font-medium">{pair.target_ids.map(targetName).join(' versus ')}:</span> {pair.matched} matched persona/task pairs. {pair.completion_difference === null ? 'Completion difference unavailable.' : `Completion difference: ${pair.completion_difference > 0 ? '+' : ''}${Math.round(pair.completion_difference * 100)} percentage points (first minus second).`}
        <span className="block text-xs text-stone-600">{scopeName(pair)}</span>
      </li>)}</ul>
    </div>}
    <p className="text-xs text-stone-600">Counts describe this simulation. Steps, duration and model latency measure simulator effort, not human time-to-value. These results do not establish purchase likelihood or human behavioral validity.</p>
    <ul className="list-disc space-y-1 pl-5 text-sm text-stone-700">{comparison.limitations.map((limitation, i) => <li key={i}>{limitation}</li>)}</ul>
    {comparison.rejected_assessments.length > 0 && <div className="space-y-1">
      <h4 className="text-sm font-medium text-stone-900">Evidence excluded from conclusions</h4>
      <ul className="list-disc space-y-1 pl-5 text-sm text-stone-700">{comparison.rejected_assessments.map((rejected, i) => <li key={i}>Assessment {rejected.seq}: {rejected.reason}</li>)}</ul>
    </div>}
    <details className="report-more" open={inFile}>
      <summary>Task order and execution scope</summary>
      <div className="mt-3 space-y-2 text-sm text-stone-700">
        <p>{comparison.study.execution.mode === 'independent' ? 'Independent benchmark. Each target starts with isolated task context.' : 'Buyer journey. Results reflect the recorded sequence and prior observations.'} Social interaction is off.</p>
        {comparison.orders.length === 0 && <p>No task order was recorded.</p>}
        <ul className="space-y-1">{comparison.orders.map((order, i) => <li key={i}>{personaName(order.persona_id)} · {taskName(order.task_id)}: {order.target_order.map(targetName).join(' → ')}</li>)}</ul>
        {comparison.study.assumptions.length > 0 && <><h4 className="font-medium">Frozen assumptions</h4><ul className="list-disc space-y-1 pl-5">{comparison.study.assumptions.map((assumption, i) => <li key={i}>{assumption}</li>)}</ul></>}
      </div>
    </details>
  </section>;
}
