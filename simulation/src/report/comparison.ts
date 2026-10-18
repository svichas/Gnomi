import type { EventOf, GnomiEvent } from '../types.ts';
import type { ComparisonCell, ComparisonCoverage, ComparisonEpisodeResult, ComparisonEvidence, ComparisonFit, ComparisonOutcome, ComparisonReport, ComparisonScope } from '../comparison/types.ts';
import { validateComparison } from '../comparison/config.ts';
import { comparisonPlan } from '../comparison/planning.ts';
import { isPriced } from '../llm/prices.ts';
import { comparisonDecision } from './comparisonDecision.ts';
export { comparisonEvidenceCatalog, comparisonEvidenceKey, comparisonDecisionLabels } from './comparisonPresentation.ts';

const OUTCOMES: ComparisonOutcome[] = ['completed', 'task_failed', 'abandoned', 'blocked_environment', 'incomplete', 'invalid_task', 'not_applicable', 'not_attempted'];
const VALID = new Set<ComparisonOutcome>(['completed', 'task_failed', 'abandoned']);
const key = (...parts: unknown[]) => JSON.stringify(parts);
const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
const sameScope = (a: ComparisonScope, b: ComparisonScope) => a.episode_id === b.episode_id && a.replicate_id === b.replicate_id && a.target_id === b.target_id && a.scenario_id === b.scenario_id && a.task_id === b.task_id && a.segment_id === b.segment_id && a.access_scope === b.access_scope;

/** Pure projection: never invokes a model or reinterprets a recorded semantic judgment. */
export function buildComparison(events: GnomiEvent[]): ComparisonReport | undefined {
  const run = events.find((event) => event.type === 'run.started');
  const config = run?.payload.config;
  const study = config?.project.comparison;
  if (!run || !config || !study) return undefined;
  const configIssues = validateComparison(config.project);
  if (configIssues.length) throw new Error(`Cannot build comparison: ${configIssues.join(' ')}`);
  const ordered = events.filter((event) => event.run_id === config.run_id).toSorted((a, b) => a.seq - b.seq);
  const bySeq = new Map(ordered.map((event) => [event.seq, event]));
  const personas = new Map(config.personas.map((persona) => [persona.id, persona]));
  const plan = comparisonPlan(config);
  const starts = new Map<string, EventOf<'comparison.episode_started'>>();
  const assignments = new Map<string, EventOf<'comparison.episode_started'>>();
  const finishes = new Map<string, EventOf<'comparison.episode_finished'>>();
  const unstarted = new Map<string, EventOf<'comparison.episode_finished'>>();
  const sources = new Map<number, EventOf<'comparison.source'>>();
  const accepted: { event: EventOf<'comparison.assessment'>; evidence: ComparisonEvidence[] }[] = [];
  const rejected: ComparisonReport['rejected_assessments'] = [];
  const limitations = new Set<string>([
    'Synthetic observations describe this study, not human purchase likelihood or market share. No overall score is calculated.',
    'Public and supplied sources establish claims; they do not verify live workflow performance or undisclosed pricing terms.',
    'Steps and execution latency measure simulator effort, not human time-to-value. Counts from this run are descriptive.',
    ...study.assumptions,
  ]);
  if (study.targets.some((target) => target.access_scope === 'authenticated_workflow')) {
    limitations.add('Fresh browser contexts isolate task context, but server-side test data is not reset between episodes. Shared fixtures can affect repeated workflow observations.');
    limitations.add('An unexpected login screen is treated as unavailable test access. This study does not diagnose login-form defects without an authenticated task trace.');
  }
  const unpriced = [...new Set(['navigator', 'judge'].flatMap((role) => {
    const model = config.project.settings.routing[role as 'navigator' | 'judge'];
    return isPriced(model) ? [] : [`${model.provider}/${model.model}`];
  }))];
  if (unpriced.length) limitations.add(`Model pricing was unavailable for ${unpriced.join(', ')}. Initial matched-block admission cannot reserve their dollar cost; recorded charges and observed costs are used when available. Actual spend may exceed the estimate.`);
  const assignmentKey = (personaId: string, taskId: string, targetId: string) => key(personaId, taskId, targetId);
  const planned = new Map(plan.episodes.map((episode) => [assignmentKey(episode.persona_id, episode.task_id, episode.target_id), episode]));
  const eligible = (personaId: string, taskId: string, targetId: string) => planned.get(assignmentKey(personaId, taskId, targetId))?.eligible ?? false;
  for (const event of ordered) {
    if (event.type !== 'comparison.episode_started') continue;
    const scope = event.payload;
    const persona = personas.get(event.persona_id ?? '');
    const target = study.targets.find((item) => item.id === scope.target_id);
    const task = study.tasks.find((item) => item.id === scope.task_id);
    const entry = task?.entries.find((item) => item.target_id === scope.target_id);
    const assignment = assignmentKey(event.persona_id ?? '', scope.task_id, scope.target_id);
    const job = planned.get(assignment);
    if (!persona || !target || !job || (plan.collection === 'shared_research' && scope.episode_id !== job.episode_id) || task?.scenario_id !== scope.scenario_id || entry?.poi_id !== event.poi_id || scope.poi_id !== event.poi_id || scope.segment_id !== job.segment_id || scope.access_scope !== target.access_scope || scope.replicate_id !== study.execution.replicate_id || starts.has(scope.episode_id) || assignments.has(assignment)) {
      limitations.add(`Ignored invalid or duplicate comparison episode at event #${event.seq}.`);
      continue;
    }
    starts.set(scope.episode_id, event);
    assignments.set(assignment, event);
  }
  const matches = (event: GnomiEvent & { payload: ComparisonScope }, start: EventOf<'comparison.episode_started'> | undefined, allowTargetSources = false) => !!start && event.seq > start.seq && event.persona_id === start.persona_id && (event.poi_id === start.poi_id || (allowTargetSources && study.targets.find((target) => target.id === start.payload.target_id)?.poi_ids.includes(event.poi_id ?? ''))) && sameScope(event.payload, start.payload);
  for (const event of ordered) {
    if (event.type === 'comparison.source') {
      const start = starts.get(event.payload.episode_id);
      const step = bySeq.get(event.payload.step_seq);
      if (matches(event, start, true) && event.payload.poi_id === event.poi_id && step?.type === 'persona.step' && step.persona_id === event.persona_id && step.poi_id === event.poi_id && step.seq > start!.seq && step.seq < event.seq && step.payload.step_no === event.payload.step_no && typeof event.payload.text === 'string' && event.payload.text.length > 0 && Number.isFinite(event.payload.captured_at)) {
        const source = event.payload.source;
        // Action captures refer to the acted-on page; a post-navigation capture may refer to the new page.
        const poi = config.project.pois.find((item) => item.id === event.poi_id)!;
        const assets = poi.type === 'text' ? [`asset:${poi.asset}`] : poi.type === 'design' ? poi.frames.map((frame) => `asset:${frame.asset}`) : [];
        if ([step.payload.result.url_before, step.payload.result.url_after, ...assets].includes(source)) sources.set(event.seq, event);
      }
    }
    if (event.type === 'comparison.episode_finished') {
      if (matches(event, starts.get(event.payload.episode_id)) && !finishes.has(event.payload.episode_id) && OUTCOMES.includes(event.payload.outcome)) finishes.set(event.payload.episode_id, event);
      else if (!starts.has(event.payload.episode_id) && ['not_attempted', 'not_applicable'].includes(event.payload.outcome)) {
        const scope = event.payload;
        const persona = personas.get(event.persona_id ?? '');
        const target = study.targets.find((item) => item.id === scope.target_id);
        const task = study.tasks.find((item) => item.id === scope.task_id);
        const entry = task?.entries.find((item) => item.target_id === scope.target_id);
        const assignment = assignmentKey(event.persona_id ?? '', scope.task_id, scope.target_id);
        const job = planned.get(assignment);
        if (persona && target && task && job && scope.scenario_id === task.scenario_id && scope.segment_id === job.segment_id && scope.access_scope === target.access_scope && scope.replicate_id === study.execution.replicate_id && event.poi_id === entry?.poi_id && typeof scope.reason === 'string' && (plan.collection !== 'shared_research' || scope.episode_id === job.episode_id)) {
          if (!unstarted.has(assignment)) unstarted.set(assignment, event);
          if (scope.outcome === 'not_attempted' && job.eligible) limitations.add(`Not attempted — ${target.name}, ${task.id}: ${scope.reason}`);
        }
      }
    }
  }
  const outcomeOf = (start: EventOf<'comparison.episode_started'>): ComparisonOutcome => {
    const finish = finishes.get(start.payload.episode_id);
    if (!finish) return 'incomplete';
    if (finish.payload.outcome === 'completed' && !finish.payload.evidence_seqs.some((seq) => {
      const source = sources.get(seq);
      return source && source.seq < finish.seq && sameScope(source.payload, start.payload);
    })) {
      limitations.add(`Completion for episode ${start.payload.episode_id} lacks captured success evidence; counted as incomplete.`);
      return 'incomplete';
    }
    return finish.payload.outcome;
  };
  const observedCriteria = new Set<string>();
  for (const event of ordered) {
    if (event.type !== 'comparison.assessment') continue;
    const assessment = event.payload;
    const start = starts.get(assessment.episode_id);
    const task = study.tasks.find((item) => item.id === assessment.task_id);
    const ownKey = key(assessment.episode_id, assessment.criterion_id);
    let reason = assessment.rejection;
    if (!matches(event, start) || !task?.criterion_ids.includes(assessment.criterion_id)) reason = 'Assessment identity does not match its frozen target, task, criterion and episode.';
    else if (!eligible(event.persona_id!, assessment.task_id, assessment.target_id) || ['invalid_task', 'not_applicable'].includes(outcomeOf(start!))) reason = 'The task or segment is invalid or ineligible; excluded from assessment.';
    else if (observedCriteria.has(ownKey)) reason = 'Duplicate assessment for the same persona task and criterion.';
    else if (!assessment.assessor?.model || !assessment.assessor.prompt_version || !assessment.assessor.rubric_version) reason = 'Missing semantic assessment provenance.';
    else if (!Array.isArray(assessment.evidence) || (assessment.assessment !== 'unknown' && assessment.assessment !== 'not_applicable' && assessment.evidence.length === 0)) reason = 'A positive or negative assessment requires captured evidence.';
    const evidence: ComparisonEvidence[] = [];
    if (!reason) for (const citation of assessment.evidence) {
      const source = sources.get(citation.event_seq);
      if (!source || source.seq >= event.seq || source.persona_id !== event.persona_id || !sameScope(source.payload, assessment) || source.payload.source !== citation.source || !normalized(citation.quote) || !normalized(source.payload.text).includes(normalized(citation.quote))) {
        reason = 'Citation is missing, fabricated, outside this episode or does not match its captured source.';
        break;
      }
      if (source.payload.interpretation === 'simulated' && assessment.basis !== 'simulated_inference') {
        reason = 'A simulated image interpretation must remain labeled as simulated inference.';
        break;
      }
      if (['vendor_claim', 'user_supplied_claim'].includes(assessment.basis) && source.payload.kind === 'action') {
        reason = 'An action/result log cannot establish a vendor or user-supplied product claim.';
        break;
      }
      evidence.push({ ...citation, assessment_seq: event.seq, episode_id: assessment.episode_id, persona_id: event.persona_id!, captured_at: source.payload.captured_at, screenshot: source.payload.screenshot, proposition: assessment.summary, basis: assessment.basis });
    }
    if (!reason && assessment.basis === 'observed_behavior' && !assessment.evidence.some((citation) => sources.get(citation.event_seq)?.payload.kind === 'action')) reason = 'Observed workflow behavior requires a captured action/result; a page or supplied asset alone cannot verify it.';
    if (reason) rejected.push({ seq: event.seq, reason });
    else { observedCriteria.add(ownKey); accepted.push({ event, evidence }); }
  }
  if (rejected.length) limitations.add(`${rejected.length} unsupported or invalid assessment(s) were excluded; inspect their recorded rejection reasons.`);
  const segments = [...new Set(plan.episodes.map((episode) => episode.segment_id))];
  const coverage: ComparisonCoverage[] = [];
  const cells: ComparisonCell[] = [];
  const fits: ComparisonFit[] = [];
  for (const task of study.tasks) for (const segment_id of segments) for (const target of study.targets) {
    const members = plan.episodes.filter((episode) => episode.task_id === task.id && episode.target_id === target.id && episode.segment_id === segment_id);
    if (!members.length) continue;
    const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<ComparisonOutcome, number>;
    const episodes: ComparisonEpisodeResult[] = [];
    let attempted = 0, scheduled = 0;
    for (const job of members) {
      const assignment = assignmentKey(job.persona_id, task.id, target.id);
      const start = assignments.get(assignment);
      const finish = start ? finishes.get(start.payload.episode_id) : unstarted.get(assignment);
      const outcome = !job.eligible ? 'not_applicable' : start ? outcomeOf(start) : 'not_attempted';
      if (job.eligible) scheduled++;
      if (start && !['not_attempted', 'not_applicable'].includes(outcome)) attempted++;
      outcomes[outcome]++;
      const reason = finish?.payload.outcome === 'completed' && outcome === 'incomplete' ? `Recorded completion lacked captured success evidence. ${finish.payload.reason}` : finish?.payload.reason ?? (!job.eligible ? 'Excluded by the frozen scenario or source eligibility.' : start ? 'No terminal outcome was recorded.' : 'The planned observation was not started.');
      episodes.push({ episode_id: start?.payload.episode_id ?? job.episode_id, persona_id: job.persona_id, outcome, reason, start_seq: start?.seq ?? null, finish_seq: finish?.seq ?? null, evidence_seqs: finish?.payload.evidence_seqs ?? [] });
    }
    const valid_attempts = outcomes.completed + outcomes.task_failed + outcomes.abandoned;
    const scope = { target_id: target.id, scenario_id: task.scenario_id, task_id: task.id, segment_id, access_scope: target.access_scope };
    coverage.push({ ...scope, scheduled, attempted, outcomes, valid_attempts, completion_rate: valid_attempts ? outcomes.completed / valid_attempts : null, unit: plan.collection === 'shared_research' ? 'source_review' : 'persona_task', episodes });
    for (const criterion_id of task.criterion_ids) {
      const records = accepted.filter(({ event }) => event.payload.target_id === target.id && event.payload.task_id === task.id && event.payload.segment_id === segment_id && event.payload.criterion_id === criterion_id);
      const labels = new Set(records.map(({ event }) => event.payload.assessment).filter((assessment) => assessment !== 'unknown'));
      const evidence = records.flatMap((record) => record.evidence);
      const notes: string[] = [];
      if (labels.size > 1) notes.push('Contradictory recorded assessments remain unresolved; inspect both contexts.');
      if (scheduled > records.length) notes.push(`Only ${records.length} of ${scheduled} eligible persona/task observations were assessed.`);
      if (outcomes.blocked_environment) notes.push(`${outcomes.blocked_environment} episode(s) were blocked by environment, permissions or setup; this is not evidence of product failure.`);
      if (outcomes.invalid_task) notes.push(`${outcomes.invalid_task} invalid task episode(s) were excluded.`);
      if (records.some(({ event }) => event.payload.basis === 'simulated_inference')) notes.push('Includes simulated inference; this is not independently verified capability evidence.');
      const assessment = scheduled === 0 ? 'not_applicable' : labels.size === 1 ? [...labels][0] : 'unknown';
      const summaries = [...new Set(records.map(({ event }) => normalized(event.payload.summary)))];
      const representative = records.find(({ event }) => event.payload.assessment === assessment)?.event.payload.summary ?? summaries[0] ?? '';
      const summary = normalized(representative).length > 280 ? `${normalized(representative).slice(0, 279)}…` : normalized(representative);
      cells.push({ ...scope, criterion_id, assessment, summary: labels.size > 1 ? 'Evidence conflicts under the same task and scope.' : summary || (scheduled ? 'No accepted evidence for this criterion.' : 'The frozen eligibility rule excludes this group.'), bases: [...new Set(records.map(({ event }) => event.payload.basis))], eligible: scheduled, assessed: records.length, distinct_sources: new Set(evidence.map((item) => item.source)).size, evidence, limitations: notes,
        observations: records.map(({ event }) => ({ assessment_seq: event.seq, persona_id: event.persona_id!, assessment: event.payload.assessment, basis: event.payload.basis, summary: event.payload.summary, evidence_seqs: event.payload.evidence.map((item) => item.event_seq) })) });
    }
    const own = cells.filter((cell) => cell.target_id === target.id && cell.task_id === task.id && cell.segment_id === segment_id);
    const supported = (cell: ComparisonCell) => cell.evidence.length > 0 && !cell.bases.includes('simulated_inference');
    const criteria = (assessment: string[]) => own.filter((cell) => assessment.includes(cell.assessment) && supported(cell)).map((cell) => study.criteria.find((criterion) => criterion.id === cell.criterion_id)!.name);
    const must = own.filter((cell) => study.criteria.find((criterion) => criterion.id === cell.criterion_id)?.importance === 'must_have');
    const fitStatus = must.some((cell) => cell.assessment === 'does_not_meet' && supported(cell)) ? 'not_suitable' : !own.some((cell) => cell.evidence.length && ['meets', 'partially_meets'].includes(cell.assessment)) ? 'insufficient_evidence' : must.every((cell) => cell.assessment === 'meets') && own.every((cell) => cell.assessed === cell.eligible && !cell.bases.includes('simulated_inference')) ? 'supported' : 'conditional';
    const unknowns = own.filter((cell) => cell.assessment === 'unknown' || (cell.assessment !== 'not_applicable' && !supported(cell))).map((cell) => study.criteria.find((criterion) => criterion.id === cell.criterion_id)!.name);
    fits.push({ target_id: target.id, scenario_id: task.scenario_id, task_id: task.id, segment_id, status: fitStatus, strengths: criteria(['meets']), gaps: criteria(['does_not_meet', 'partially_meets']), unknowns });
  }
  const pairs: ComparisonReport['pairs'] = [];
  if (plan.collection === 'persona_tasks') for (const task of study.tasks) for (const segment_id of segments) for (let a = 0; a < study.targets.length; a++) for (let b = a + 1; b < study.targets.length; b++) {
    const left = study.targets[a], right = study.targets[b];
    let matched = 0, difference = 0;
    if (left.access_scope === right.access_scope) for (const persona of config.personas.filter((item) => (item.segment_id ?? null) === segment_id)) {
      const x = assignments.get(assignmentKey(persona.id, task.id, left.id)), y = assignments.get(assignmentKey(persona.id, task.id, right.id));
      if (x && y && eligible(persona.id, task.id, left.id) && eligible(persona.id, task.id, right.id) && VALID.has(outcomeOf(x)) && VALID.has(outcomeOf(y))) { matched++; difference += Number(outcomeOf(x) === 'completed') - Number(outcomeOf(y) === 'completed'); }
    }
    pairs.push({ target_ids: [left.id, right.id], scenario_id: task.scenario_id, task_id: task.id, segment_id, matched, completion_difference: matched ? difference / matched : null });
    if (left.access_scope !== right.access_scope) limitations.add(`${left.name} and ${right.name} have different access scopes; their workflow performance is not compared.`);
  }
  if (coverage.some((row) => row.scheduled !== row.valid_attempts)) limitations.add('Unequal or incomplete valid coverage prevents an unconditional winner. Unmatched, blocked, invalid and interrupted episodes remain visible beside each rate.');
  if (coverage.some((row) => row.outcomes.blocked_environment)) limitations.add('Blocked access or missing prerequisites exclude observations; they do not establish absent features or product defects.');
  if (study.execution.mode === 'buyer_journey') limitations.add('Buyer-journey observations include declared prior-target carryover; choices are conditional on the recorded sequence and are not independent benchmarks.');
  const orders: ComparisonReport['orders'] = [];
  const orderKeys = new Set<string>();
  for (const start of starts.values()) {
    const id = key(start.persona_id, start.payload.task_id);
    if (!orderKeys.has(id)) { orderKeys.add(id); orders.push({ persona_id: start.persona_id!, task_id: start.payload.task_id, target_order: start.payload.target_order }); }
  }
  if (plan.collection === 'persona_tasks') for (const task of study.tasks) for (const segment of segments) {
    const rows = orders.filter((order) => order.task_id === task.id && (personas.get(order.persona_id)?.segment_id ?? null) === segment);
    for (let position = 0; position < study.targets.length; position++) {
      const counts = study.targets.map((target) => rows.filter((order) => order.target_order[position] === target.id).length);
      if (Math.max(...counts) - Math.min(...counts) > 1) limitations.add(`Target order is imbalanced for task ${task.id}, segment ${segment ?? 'built-in'}, position ${position + 1}.`);
    }
  }
  if (plan.collection === 'shared_research') limitations.add('Public information was collected once per target and assigned research task. Source reviews are shared company evidence, not independent persona attempts or human preference votes.');
  const { decision, tradeoffs, actions } = comparisonDecision(study, cells, coverage, fits);
  return { version: 1, study, decision, cells, coverage, fits, tradeoffs, actions, pairs, orders, limitations: [...limitations], rejected_assessments: rejected };
}
