import type { EventOf, GnomiEvent } from '../types.ts';
import type { ComparisonAction, ComparisonCell, ComparisonCoverage, ComparisonEvidence, ComparisonFit, ComparisonOutcome, ComparisonReport, ComparisonScope } from '../comparison/types.ts';
import { admits, EVIDENCE_FREE_UNKNOWN, inScenario, validateComparison } from '../comparison/config.ts';
import { isPriced } from '../llm/prices.ts';

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
  const starts = new Map<string, EventOf<'comparison.episode_started'>>();
  const assignments = new Map<string, EventOf<'comparison.episode_started'>>();
  const finishes = new Map<string, EventOf<'comparison.episode_finished'>>();
  const sources = new Map<number, EventOf<'comparison.source'>>();
  const accepted: { event: EventOf<'comparison.assessment'>; evidence: ComparisonEvidence[] }[] = [];
  const rejected: ComparisonReport['rejected_assessments'] = [];
  const limitations = new Set<string>([
    'Synthetic observations describe this study, not human purchase likelihood or market share. No overall score is calculated.',
    'Public and supplied sources establish claims; they do not verify live workflow performance or undisclosed pricing terms.',
    'Steps and execution latency measure simulator effort, not human time-to-value. Counts from this run are descriptive.',
    ...study.assumptions,
  ]);
  const verifierRole = study.execution.verifier ?? 'judge';
  const verifier = config.project.settings.routing[verifierRole];
  limitations.add(`Configured semantic verifier: ${verifierRole} model (${verifier.provider}/${verifier.model}). Assessment proposals use the judge model. Verifier agreement is not human validation.`);
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
  // The study's own rule, not poi/pois.ts isEligible: a segment's kind does not matter, and any explicit list leaves out the built-in persona.
  const eligible = (personaId: string, taskId: string, targetId: string) => {
    const persona = personas.get(personaId);
    const task = study.tasks.find((item) => item.id === taskId);
    const entry = task?.entries.find((item) => item.target_id === targetId);
    const poi = config.project.pois.find((item) => item.id === entry?.poi_id);
    return !!persona && !!task && !!poi && inScenario(study, task.scenario_id, persona.segment_id) && admits(poi, persona.segment_id);
  };
  const lookup = (personaId: string | null, scope: ComparisonScope) => {
    const task = study.tasks.find((item) => item.id === scope.task_id);
    return { persona: personas.get(personaId ?? ''), target: study.targets.find((item) => item.id === scope.target_id), task, entry: task?.entries.find((item) => item.target_id === scope.target_id) };
  };
  for (const event of ordered) {
    if (event.type !== 'comparison.episode_started') continue;
    const scope = event.payload;
    const { persona, target, task, entry } = lookup(event.persona_id, scope);
    const assignment = assignmentKey(event.persona_id ?? '', scope.task_id, scope.target_id);
    if (!persona || !target || task?.scenario_id !== scope.scenario_id || entry?.poi_id !== event.poi_id || scope.poi_id !== event.poi_id || scope.segment_id !== (persona.segment_id ?? null) || scope.access_scope !== target.access_scope || scope.replicate_id !== study.execution.replicate_id || starts.has(scope.episode_id) || assignments.has(assignment)) {
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
      else if (!starts.has(event.payload.episode_id) && event.payload.outcome === 'not_attempted') {
        const scope = event.payload;
        const { persona, target, task, entry } = lookup(event.persona_id, scope);
        if (persona && target && task && scope.scenario_id === task.scenario_id && scope.segment_id === (persona.segment_id ?? null) && scope.access_scope === target.access_scope && scope.replicate_id === study.execution.replicate_id && event.poi_id === entry?.poi_id && typeof scope.reason === 'string' && eligible(persona.id, task.id, target.id)) limitations.add(`Not attempted — ${target.name}, ${task.id}, segment ${scope.segment_id ?? 'built-in'}: ${scope.reason}`);
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
  const setAside = new Map<string, string[]>(); // each cell's rejection reasons, so an unknown can say why
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
    if (reason) {
      rejected.push({ seq: event.seq, reason });
      const cell = key(assessment.target_id, assessment.task_id, assessment.segment_id, assessment.criterion_id);
      setAside.set(cell, [...(setAside.get(cell) ?? []), reason]);
    } else { observedCriteria.add(ownKey); accepted.push({ event, evidence }); }
  }
  if (rejected.length) limitations.add(`${rejected.length} unsupported or invalid assessment(s) were excluded; inspect their recorded rejection reasons.`);
  const segments = [...new Set(config.personas.map((persona) => persona.segment_id ?? null))];
  const coverage: ComparisonCoverage[] = [];
  const cells: ComparisonCell[] = [];
  const fits: ComparisonFit[] = [];
  for (const task of study.tasks) for (const segment_id of segments) for (const target of study.targets) {
    const members = config.personas.filter((persona) => (persona.segment_id ?? null) === segment_id);
    const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<ComparisonOutcome, number>;
    let attempted = 0, scheduled = 0;
    for (const persona of members) {
      if (!eligible(persona.id, task.id, target.id)) { outcomes.not_applicable++; continue; }
      scheduled++;
      const start = assignments.get(assignmentKey(persona.id, task.id, target.id));
      const outcome = start ? outcomeOf(start) : 'not_attempted';
      if (start && !['not_attempted', 'not_applicable'].includes(outcome)) attempted++;
      outcomes[outcome]++;
    }
    const valid_attempts = outcomes.completed + outcomes.task_failed + outcomes.abandoned;
    const scope = { target_id: target.id, scenario_id: task.scenario_id, task_id: task.id, segment_id, access_scope: target.access_scope };
    coverage.push({ ...scope, scheduled, attempted, outcomes, valid_attempts, completion_rate: valid_attempts ? outcomes.completed / valid_attempts : null });
    for (const criterion_id of task.criterion_ids) {
      const records = accepted.filter(({ event }) => event.payload.target_id === target.id && event.payload.task_id === task.id && event.payload.segment_id === segment_id && event.payload.criterion_id === criterion_id);
      const labels = new Set(records.map(({ event }) => event.payload.assessment).filter((assessment) => assessment !== 'unknown'));
      const evidence = records.flatMap((record) => record.evidence);
      const notes: string[] = [];
      // With nothing accepted, the summary says why in one line, so the notes on accepted evidence stay out.
      if (records.length) {
        if (labels.size > 1) notes.push('Contradictory recorded assessments remain unresolved; inspect both contexts.');
        if (scheduled > records.length) notes.push(`Only ${records.length} of ${scheduled} eligible persona/task observations were assessed.`);
        if (outcomes.blocked_environment) notes.push(`${outcomes.blocked_environment} episode(s) were blocked by environment, permissions or setup; this is not evidence of product failure.`);
        if (outcomes.invalid_task) notes.push(`${outcomes.invalid_task} invalid task episode(s) were excluded.`);
        if (records.some(({ event }) => event.payload.basis === 'simulated_inference')) notes.push('Includes simulated inference; this is not independently verified capability evidence.');
      }
      const assessment = scheduled === 0 ? 'not_applicable' : labels.size === 1 ? [...labels][0] : 'unknown';
      const summaries = [...new Set(records.map(({ event }) => normalized(event.payload.summary)))];
      const summary = summaries.slice(0, 3).join(' ').slice(0, 1200);
      if (summaries.length > 3 || summaries.join(' ').length > 1200) notes.push('The concise summary is abbreviated; all accepted propositions remain in the evidence links.');
      const reasons = setAside.get(key(target.id, task.id, segment_id, criterion_id)) ?? [];
      const failed = [...new Set(reasons.filter((reason) => reason !== EVIDENCE_FREE_UNKNOWN))];
      const unassessed = !scheduled ? 'The frozen eligibility rule excludes this group.'
        : !attempted ? 'Not attempted in this run.'
        : failed.length ? `No assessment was accepted. ${failed.slice(0, 3).join(' ')}`.slice(0, 1200) // all of them are under the coverage's exclusions
        : reasons.length ? 'The assessor could not settle this from the captured pages and cited nothing.'
        : outcomes.blocked_environment === attempted ? 'Not assessed: access, permissions or setup blocked every attempt. This is not evidence of a product failure.'
        : 'No assessment was recorded for this criterion.';
      cells.push({ ...scope, criterion_id, assessment, summary: labels.size > 1 ? 'Evidence conflicts under the same task and scope.' : summary || unassessed, bases: [...new Set(records.map(({ event }) => event.payload.basis))], eligible: scheduled, assessed: records.length, distinct_sources: new Set(evidence.map((item) => item.source)).size, evidence, limitations: notes });
    }
    const own = cells.filter((cell) => cell.target_id === target.id && cell.task_id === task.id && cell.segment_id === segment_id);
    const criteria = (assessment: string[]) => own.filter((cell) => assessment.includes(cell.assessment)).map((cell) => study.criteria.find((criterion) => criterion.id === cell.criterion_id)!.name);
    const must = own.filter((cell) => study.criteria.find((criterion) => criterion.id === cell.criterion_id)?.importance === 'must_have');
    const fitStatus = must.some((cell) => cell.assessment === 'does_not_meet') ? 'not_suitable' : !own.some((cell) => cell.evidence.length && ['meets', 'partially_meets'].includes(cell.assessment)) ? 'insufficient_evidence' : must.every((cell) => cell.assessment === 'meets') && own.every((cell) => cell.assessed === cell.eligible && !cell.bases.includes('simulated_inference')) ? 'supported' : 'conditional';
    fits.push({ target_id: target.id, scenario_id: task.scenario_id, task_id: task.id, segment_id, status: fitStatus, strengths: criteria(['meets']), gaps: criteria(['does_not_meet', 'partially_meets']), unknowns: criteria(['unknown']) });
  }
  const pairs: ComparisonReport['pairs'] = [];
  for (const task of study.tasks) for (const segment_id of segments) for (let a = 0; a < study.targets.length; a++) for (let b = a + 1; b < study.targets.length; b++) {
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
  for (const task of study.tasks) for (const segment of segments) {
    const rows = orders.filter((order) => order.task_id === task.id && (personas.get(order.persona_id)?.segment_id ?? null) === segment);
    for (let position = 0; position < study.targets.length; position++) {
      const counts = study.targets.map((target) => rows.filter((order) => order.target_order[position] === target.id).length);
      if (Math.max(...counts) - Math.min(...counts) > 1) limitations.add(`Target order is imbalanced for task ${task.id}, segment ${segment ?? 'built-in'}, position ${position + 1}.`);
    }
  }
  const name = (id: string) => study.targets.find((target) => target.id === id)!.name;
  const tradeoffs: ComparisonReport['tradeoffs'] = [];
  if (study.focal_target_id) for (const focal of cells.filter((cell) => cell.target_id === study.focal_target_id)) {
    const criterion = study.criteria.find((item) => item.id === focal.criterion_id)!;
    for (const other of cells.filter((cell) => cell.target_id !== focal.target_id && cell.scenario_id === focal.scenario_id && cell.task_id === focal.task_id && cell.segment_id === focal.segment_id && cell.criterion_id === focal.criterion_id)) {
      const known = ['meets', 'partially_meets', 'does_not_meet'];
      const comparable = focal.access_scope === other.access_scope && known.includes(focal.assessment) && known.includes(other.assessment) && !focal.bases.includes('simulated_inference') && !other.bases.includes('simulated_inference');
      const result = !comparable ? 'unresolved' : focal.assessment === other.assessment ? 'parity' : known.indexOf(focal.assessment) < known.indexOf(other.assessment) ? 'advantage' : 'gap';
      tradeoffs.push({ focal_target_id: focal.target_id, other_target_id: other.target_id, scenario_id: focal.scenario_id, task_id: focal.task_id, segment_id: focal.segment_id, criterion_id: focal.criterion_id, result,
        summary: `${criterion.name}: ${name(focal.target_id)} — ${focal.summary} ${name(other.target_id)} — ${other.summary}${!comparable ? ' A comparative conclusion is unresolved.' : ' This contrast is limited to the tested scope and accepted evidence.'}`,
        evidence_seqs: [...new Set([...focal.evidence, ...other.evidence].map((item) => item.event_seq))] });
    }
  }
  // A favorable task cannot erase a failed must-have in another task of the same scenario/segment.
  const fitGroups = [...new Set(fits.map((fit) => key(fit.target_id, fit.scenario_id, fit.segment_id)))].map((group) => fits.filter((fit) => key(fit.target_id, fit.scenario_id, fit.segment_id) === group && coverage.some((row) => row.target_id === fit.target_id && row.task_id === fit.task_id && row.segment_id === fit.segment_id && row.scheduled > 0))).filter((group) => group.length > 0);
  const shortlistedGroups = fitGroups.filter((group) => group.every((fit) => ['supported', 'conditional'].includes(fit.status)));
  const shortlist = [...new Set(shortlistedGroups.map((group) => group[0].target_id))];
  const allRejected = fitGroups.length > 0 && fitGroups.every((group) => group.some((fit) => fit.status === 'not_suitable'));
  const status = shortlist.length ? 'conditional_shortlist' : allRejected ? 'no_suitable_tool' : 'insufficient_evidence';
  const scopeText = [...new Set(study.targets.map((target) => target.access_scope.replaceAll('_', ' ')))].join(', ');
  const shortlistText = shortlistedGroups.map((group) => `${name(group[0].target_id)} (${study.scenarios.find((scenario) => scenario.id === group[0].scenario_id)!.name}; ${config.project.audience?.segments.find((segment) => segment.id === group[0].segment_id)?.name ?? group[0].segment_id ?? 'built-in persona'})`).join('; ');
  const summary = shortlist.length ? `Conditional shortlist for ${scopeText}: ${shortlistText}. Suitability requires all tested tasks in each named scenario and segment; resolve unknown must-haves before choosing. Evidence does not establish an overall winner.` : allRejected ? `No tool meets all recorded must-have requirements in the tested ${scopeText} scopes. Inspect the evidenced gaps and validate alternatives.` : `The ${scopeText} study has insufficient accepted evidence to choose a tool. Complete the missing comparable observations and resolve must-have requirements before deciding.`;
  const actions: ComparisonAction[] = [];
  const actionPriority = (cell: ComparisonCell) => Number(study.criteria.find((criterion) => criterion.id === cell.criterion_id)?.importance === 'must_have') * 2 + Number(cell.target_id === study.focal_target_id) * 4 + Number(cell.assessment === 'does_not_meet' && cell.evidence.length > 0);
  const candidates = cells.toSorted((a, b) => actionPriority(b) - actionPriority(a));
  for (const cell of candidates) {
    if (actions.length >= 3) break;
    if (cell.assessment === 'meets' || cell.assessment === 'not_applicable') continue;
    const criterion = study.criteria.find((item) => item.id === cell.criterion_id)!;
    const rival = cells.find((other) => other.target_id !== cell.target_id && other.scenario_id === cell.scenario_id && other.task_id === cell.task_id && other.segment_id === cell.segment_id && other.access_scope === cell.access_scope && other.criterion_id === cell.criterion_id && other.assessment === 'meets');
    const improve = study.purpose === 'improve_own_product' && cell.target_id === study.focal_target_id && ['does_not_meet', 'partially_meets'].includes(cell.assessment) && cell.evidence.length > 0;
    // A competitor gap becomes diligence, never a request to edit the competitor's product.
    const owner = improve ? 'product_team' : study.purpose === 'choose_tool' ? 'buyer' : 'study_owner';
    const evidence_seqs = [...new Set([...cell.evidence, ...(improve && rival ? rival.evidence : [])].map((item) => item.event_seq))];
    actions.push({ owner, target_id: cell.target_id, scenario_id: cell.scenario_id, task_id: cell.task_id, segment_id: cell.segment_id, criterion_id: cell.criterion_id,
      action: improve ? `Improve ${criterion.name.toLowerCase()} in ${name(cell.target_id)} for this task and segment.` : `Verify ${criterion.name.toLowerCase()} for ${name(cell.target_id)} under the stated scenario.`,
      rationale: improve ? `${cell.summary}${rival ? ` Comparable evidence for ${name(rival.target_id)}: ${rival.summary}` : ' No supported competitor advantage is inferred.'}` : `${cell.summary} ${cell.limitations.join(' ')}`.trim(),
      expected_benefit: improve ? 'Hypothesis: addressing this evidenced gap will improve suitability for the stated requirement.' : 'Hypothesis: comparable evidence will resolve this decision uncertainty.',
      validation: `Repeat the same task with valid access and fixtures, then check: ${criterion.question} Use the frozen rule: ${criterion.decision_rule}`,
      evidence_seqs });
  }
  return { version: 1, study, decision: { status, summary, shortlist }, cells, coverage, fits, tradeoffs, actions, pairs, orders, limitations: [...limitations], rejected_assessments: rejected };
}
