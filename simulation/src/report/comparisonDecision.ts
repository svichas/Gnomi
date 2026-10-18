import type { ComparisonAction, ComparisonCell, ComparisonCoverage, ComparisonFit, ComparisonReport, ComparisonScenarioDecision, ComparisonStudy } from '../comparison/types.ts';

const key = (...parts: unknown[]) => JSON.stringify(parts);
const unique = <T>(values: T[]) => [...new Set(values)];
const rank = (cell: ComparisonCell) => ['does_not_meet', 'partially_meets', 'meets'].indexOf(cell.assessment);
const known = (cell: ComparisonCell) => rank(cell) >= 0 && cell.evidence.length > 0 && !cell.bases.includes('simulated_inference');
const evidence = (cells: ComparisonCell[]) => unique(cells.flatMap((cell) => cell.evidence.map((item) => item.event_seq)));
const sameQuestion = (a: ComparisonCell, b: ComparisonCell) => a.scenario_id === b.scenario_id && a.segment_id === b.segment_id && a.task_id === b.task_id && a.criterion_id === b.criterion_id;

/** Rules, not a score: a lead needs complete comparable evidence and explicit dominance or disqualification. */
export function comparisonDecision(study: ComparisonStudy, cells: ComparisonCell[], coverage: ComparisonCoverage[], fits: ComparisonFit[]): Pick<ComparisonReport, 'decision' | 'tradeoffs' | 'actions'> {
  const name = (id: string) => study.targets.find((target) => target.id === id)!.name;
  const criterion = (id: string) => study.criteria.find((item) => item.id === id)!;
  const tradeoffs: ComparisonReport['tradeoffs'] = [];
  for (let i = 0; i < study.targets.length; i++) {
    const left = study.targets[i];
    if (study.purpose === 'improve_own_product' && left.id !== study.focal_target_id) continue;
    for (const focal of cells.filter((cell) => cell.target_id === left.id && cell.eligible > 0)) {
      for (const other of cells.filter((cell) => cell.target_id !== left.id && cell.eligible > 0 && sameQuestion(focal, cell))) {
        if (study.purpose === 'choose_tool' && study.targets.findIndex((target) => target.id === other.target_id) <= i) continue;
        const comparable = focal.access_scope === other.access_scope && known(focal) && known(other);
        const result = !comparable ? 'unresolved' : rank(focal) === rank(other) ? 'parity' : rank(focal) > rank(other) ? 'advantage' : 'gap';
        tradeoffs.push({ focal_target_id: left.id, other_target_id: other.target_id, scenario_id: focal.scenario_id, task_id: focal.task_id, segment_id: focal.segment_id, criterion_id: focal.criterion_id, result,
          summary: `${criterion(focal.criterion_id).name}: ${name(left.id)} — ${focal.summary} ${name(other.target_id)} — ${other.summary}${comparable ? '' : ' A comparative conclusion is unresolved.'}`, evidence_seqs: evidence([focal, other]) });
      }
    }
  }
  const scenarios: ComparisonScenarioDecision[] = [];
  for (const scope of unique(cells.filter((cell) => cell.eligible > 0).map((cell) => key(cell.scenario_id, cell.segment_id)))) {
    const [scenario_id, segment_id] = JSON.parse(scope) as [string, string | null];
    const scoped = cells.filter((cell) => cell.scenario_id === scenario_id && cell.segment_id === segment_id);
    const tasks = study.tasks.filter((task) => task.scenario_id === scenario_id);
    const groups = study.targets.map((target) => {
      const own = scoped.filter((cell) => cell.target_id === target.id);
      const rows = coverage.filter((row) => row.scenario_id === scenario_id && row.segment_id === segment_id && row.target_id === target.id);
      const must = own.filter((cell) => criterion(cell.criterion_id).importance === 'must_have');
      const fit = fits.filter((item) => item.scenario_id === scenario_id && item.segment_id === segment_id && item.target_id === target.id && rows.some((row) => row.task_id === item.task_id && row.scheduled > 0));
      return { target, own, must, rejected: must.some((cell) => cell.assessment === 'does_not_meet' && known(cell)),
        candidate: fit.length > 0 && fit.every((item) => ['supported', 'conditional'].includes(item.status)),
        complete: rows.length === tasks.length && rows.every((row) => row.scheduled > 0 && row.valid_attempts === row.scheduled) && own.every((cell) => cell.eligible > 0 && cell.assessed === cell.eligible),
        mustSupported: must.every((cell) => cell.assessment === 'meets' && known(cell)) };
    });
    const comparable = unique(groups.map((group) => group.target.access_scope)).length === 1 && groups.every((group) => group.complete);
    const dominates = (left: typeof groups[number], right: typeof groups[number]) => {
      if (right.rejected) return true;
      const contrasts = left.own.map((a) => ({ a, b: right.own.find((b) => sameQuestion(a, b)) }));
      return contrasts.length > 0 && contrasts.every(({ a, b }) => b && known(a) && known(b) && rank(a) >= rank(b)) && contrasts.some(({ a, b }) => b && rank(a) > rank(b));
    };
    const leaders = comparable ? groups.filter((group) => group.candidate && group.mustSupported && groups.every((other) => other === group || dominates(group, other))) : [];
    const leader = leaders.length === 1 ? leaders[0] : null;
    const allRejected = groups.every((group) => group.rejected);
    const parity = comparable && groups.every((group) => group.mustSupported && group.own.every(known)) && groups.slice(1).every((group) => group.own.every((cell) => {
      const first = groups[0].own.find((other) => sameQuestion(cell, other)); return first && first.assessment === cell.assessment;
    }));
    const shortlist = groups.filter((group) => group.candidate && !group.rejected).map((group) => group.target.id);
    const status = allRejected ? 'no_suitable_tool' : leader ? 'leading_candidate' : parity ? 'parity' : shortlist.length ? 'conditional_shortlist' : 'insufficient_evidence';
    const scenario = study.scenarios.find((item) => item.id === scenario_id)!;
    const access = unique(groups.map((group) => group.target.access_scope.replaceAll('_', ' '))).join(', ');
    const summary = leader ? `${leader.target.name} is the leading candidate for ${scenario.name} in this ${access} evaluation. ${leader.must.length ? 'It meets the evidenced must-haves; each alternative is ruled out by a must-have or offers no better supported result on the tested criteria.' : 'It has no worse supported outcome on any tested criterion and a better supported outcome than each alternative on at least one.'}`
      : parity ? `${shortlist.map(name).join(' and ')} ${groups[0].must.length ? 'meet the tested must-haves with' : 'have'} equal supported criterion outcomes for ${scenario.name}. This evidence supports parity; it does not distinguish a best tool.`
      : allRejected ? `No tool meets every recorded must-have for ${scenario.name}. The evidenced mismatches below rule out the tested options under these requirements.`
      : shortlist.length ? `${shortlist.map(name).join(', ')} ${shortlist.length === 1 ? 'is a conditional candidate' : 'are conditional candidates'} for ${scenario.name}. Resolve the decision-changing unknowns before choosing.`
      : `Insufficient evidence to choose a tool for ${scenario.name}. Complete the missing comparable requirements below.`;
    const relevant = tradeoffs.filter((item) => item.scenario_id === scenario_id && item.segment_id === segment_id && ['advantage', 'gap'].includes(item.result) && (!leader || [item.focal_target_id, item.other_target_id].includes(leader.target.id)))
      .toSorted((a, b) => Number(criterion(b.criterion_id).importance === 'must_have') - Number(criterion(a.criterion_id).importance === 'must_have'));
    const reasons = unique(relevant.map((item) => key(item.task_id, item.criterion_id))).slice(0, 3).map((question) => {
      const [task_id, criterion_id] = JSON.parse(question) as [string, string];
      const contrasts = relevant.filter((item) => item.task_id === task_id && item.criterion_id === criterion_id);
      const target_ids = unique(contrasts.flatMap((item) => [item.focal_target_id, item.other_target_id]));
      const observations = scoped.filter((cell) => cell.task_id === task_id && cell.criterion_id === criterion_id && target_ids.includes(cell.target_id));
      return { text: `${criterion(criterion_id).name}: ${observations.map((cell) => `${name(cell.target_id)} — ${cell.summary}`).join(' ')}`, criterion_ids: [criterion_id], target_ids, evidence_seqs: evidence(observations) };
    });
    if (parity) reasons.push({ text: `The same supported results were recorded for ${unique(scoped.map((cell) => criterion(cell.criterion_id).name)).join(', ')}.`, criterion_ids: unique(scoped.map((cell) => cell.criterion_id)), target_ids: shortlist, evidence_seqs: evidence(scoped) });
    if (!comparable) reasons.push({ text: 'Access scopes or completed coverage differ. Those differences prevent a supported lead.', criterion_ids: [], target_ids: groups.map((group) => group.target.id), evidence_seqs: [] });
    const unresolved = study.criteria.flatMap((item) => {
      const missing = scoped.filter((cell) => cell.eligible > 0 && cell.criterion_id === item.id && (!known(cell) || cell.assessment === 'partially_meets') && !groups.find((group) => group.target.id === cell.target_id)?.rejected);
      if (!missing.length) return [];
      const target_ids = unique(missing.map((cell) => cell.target_id));
      return [{ criterion_id: item.id, target_ids, summary: `${item.name}: ${target_ids.map(name).join(', ')} need comparable evidence. ${unique(missing.map((cell) => cell.summary)).join(' ')}`,
        changes_choice: item.importance === 'must_have' ? `Evidence that ${item.name.toLowerCase()} does not meet the frozen rule would exclude the affected tool; evidence that it meets would keep it eligible.` : `A supported difference in ${item.name.toLowerCase()} can distinguish otherwise eligible candidates; equal results leave that choice unresolved.` }];
    });
    const alternatives = groups.filter((group) => group !== leader).map((group) => {
      const gaps = group.must.filter((cell) => cell.assessment === 'does_not_meet' && known(cell));
      const unknown = unresolved.filter((item) => item.target_ids.includes(group.target.id)).map((item) => criterion(item.criterion_id).name);
      return { target_id: group.target.id, condition: gaps.length ? `Excluded by must-have: ${gaps.map((cell) => criterion(cell.criterion_id).name).join(', ')}. Reconsider only if applicable new evidence changes that mismatch.`
        : unknown.length ? `Keep under evaluation if ${unknown.join(', ')} can be supported for this scenario.` : group.candidate ? 'Suitable on the supported requirements; compare the evidenced differences against your stated priorities.' : 'Collect comparable evidence for the assigned tasks before considering this option.', evidence_seqs: evidence(gaps.length ? gaps : group.own) };
    });
    scenarios.push({ scenario_id, segment_id, status, summary, leading_target_id: leader?.target.id ?? null, shortlist, reasons, alternatives, unresolved });
  }
  const statuses = unique(scenarios.map((item) => item.status));
  const shortlist = unique(scenarios.flatMap((item) => item.shortlist));
  const status = scenarios.length === 1 ? scenarios[0].status : statuses.length === 1 && statuses[0] !== 'leading_candidate' ? statuses[0] : shortlist.length ? 'conditional_shortlist' : 'insufficient_evidence';
  const summary = scenarios.length === 1 ? scenarios[0].summary : scenarios.length ? 'Recommendations depend on the scenario below. Compare each company’s requirements and evidence separately.' : 'Insufficient evidence: no eligible comparison observations were scheduled.';
  const actions = nextActions(study, cells, scenarios, name);
  return { decision: { status, summary, shortlist, scenarios }, tradeoffs, actions };
}

function nextActions(study: ComparisonStudy, cells: ComparisonCell[], scenarios: ComparisonScenarioDecision[], name: (id: string) => string): ComparisonAction[] {
  const grouped = new Map<string, ComparisonCell[]>();
  for (const cell of cells) {
    if (cell.eligible === 0 || cell.assessment === 'not_applicable' || (cell.assessment === 'meets' && known(cell))) continue;
    const improve = study.purpose === 'improve_own_product' && cell.target_id === study.focal_target_id && ['does_not_meet', 'partially_meets'].includes(cell.assessment) && known(cell);
    // A known disqualifier is already a decision, not a missing-information check.
    if (study.purpose === 'choose_tool' && cell.assessment === 'does_not_meet' && known(cell)) continue;
    if (study.purpose === 'choose_tool' && cells.some((other) => other.target_id === cell.target_id && other.scenario_id === cell.scenario_id && other.segment_id === cell.segment_id && study.criteria.find((item) => item.id === other.criterion_id)?.importance === 'must_have' && other.assessment === 'does_not_meet' && known(other))) continue;
    const id = key(cell.scenario_id, cell.criterion_id, improve ? cell.target_id : 'research');
    grouped.set(id, [...(grouped.get(id) ?? []), cell]);
  }
  const priority = (group: ComparisonCell[]) => {
    const first = group[0], criterion = study.criteria.find((item) => item.id === first.criterion_id)!;
    const resolves = scenarios.some((scenario) => scenario.scenario_id === first.scenario_id && scenario.unresolved.some((item) => item.criterion_id === first.criterion_id));
    const contrast = cells.some((cell) => cell.scenario_id === first.scenario_id && cell.criterion_id === first.criterion_id && cell.assessment === 'meets' && known(cell));
    return Number(criterion.importance === 'must_have') * 8 + Number(resolves) * 4 + Number(contrast) * 2 + Number(group.some((cell) => cell.target_id === study.focal_target_id));
  };
  return [...grouped.values()].toSorted((a, b) => priority(b) - priority(a)).slice(0, 3).map((group) => {
    const cell = group[0], criterion = study.criteria.find((item) => item.id === cell.criterion_id)!;
    const target_ids = unique(group.map((item) => item.target_id));
    const improve = study.purpose === 'improve_own_product' && cell.target_id === study.focal_target_id && ['does_not_meet', 'partially_meets'].includes(cell.assessment) && known(cell);
    const rivals = improve ? cells.filter((other) => other.target_id !== cell.target_id && sameQuestion(cell, other) && cell.access_scope === other.access_scope && other.assessment === 'meets' && known(other)) : [];
    const changes = scenarios.flatMap((scenario) => scenario.unresolved).find((item) => item.criterion_id === cell.criterion_id && item.target_ids.some((id) => target_ids.includes(id)))?.changes_choice;
    return { owner: improve ? 'product_team' : study.purpose === 'choose_tool' ? 'buyer' : 'study_owner', target_id: cell.target_id, target_ids,
      scenario_id: cell.scenario_id, task_id: cell.task_id, segment_id: cell.segment_id, criterion_id: cell.criterion_id,
      scopes: unique(group.map((item) => key(item.scenario_id, item.task_id, item.segment_id))).map((scope) => { const [scenario_id, task_id, segment_id] = JSON.parse(scope) as [string, string, string | null]; return { scenario_id, task_id, segment_id }; }),
      action: improve ? `Improve ${criterion.name.toLowerCase()} in ${name(cell.target_id)}.` : `Resolve ${criterion.name.toLowerCase()} for ${target_ids.map(name).join(', ')}.`,
      rationale: unique([...group, ...rivals].map((item) => `${name(item.target_id)}: ${item.summary}`)).join(' '),
      expected_benefit: improve ? 'Hypothesis: resolving the evidenced gap improves suitability for the stated requirement.' : 'Comparable evidence will clarify which tools remain suitable.',
      changes_choice: changes ?? 'Re-evaluate the affected tool against the same frozen requirements after collecting the new evidence.',
      validation: `${criterion.question} Apply the same scenario and rule: ${criterion.decision_rule} Required evidence: ${criterion.evidence_required}`,
      evidence_seqs: evidence([...group, ...rivals]) };
  });
}
