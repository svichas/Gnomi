import type { ComparisonReport } from '@gnomi/simulation/comparison/types.ts';

/** Fictional targets, recorded data only. Also used for local visual checks without model calls. */
export function comparisonFixture(): ComparisonReport {
  const targets = ['Harbor ATS', 'Orbit ATS', 'Northstar ATS', 'Sprout ATS'].map((name, i) => ({ id: `target-${i}`, name, poi_ids: [`poi-${i}`], access_scope: 'public_site' as const, session_role: null }));
  const scope = { scenario_id: 'small-team', task_id: 'evaluate', segment_id: 'seg-a', access_scope: 'public_site' as const };
  return {
    version: 1,
    study: {
      version: 1, purpose: 'choose_tool', focal_target_id: null, question: 'Which hiring tool fits a 25-person company?',
      assumptions: ['The company has 25 employees. Integration requirements need confirmation.'], targets,
      scenarios: [{ id: 'small-team', name: '25-person company', context: 'Hire three people this year.', segment_ids: ['seg-a'] }],
      tasks: [{ id: 'evaluate', scenario_id: 'small-team', instruction: 'Find the applicable plan, price and supported integrations.', success_rule: 'Capture the relevant terms or an explicit quote requirement.', prerequisites: [], criterion_ids: ['price', 'integration'], max_steps: 10, entries: targets.map((target, i) => ({ target_id: target.id, poi_id: `poi-${i}` })) }],
      criteria: [
        { id: 'price', name: 'Cost for this company size', question: 'Is the applicable plan within the stated budget?', importance: 'must_have', evidence_required: 'Visible price and company-size eligibility.', decision_rule: 'Applicable monthly plan is at most $400.' },
        { id: 'integration', name: 'Required integrations', question: 'Does the plan include the required HR integration?', importance: 'preference', evidence_required: 'Applicable integration documentation.', decision_rule: 'The required integration is explicitly included.' },
      ],
      execution: { mode: 'independent', carryover: 'none', social: 'off', order: 'balanced', replicate_id: 'replicate-1', analysis_reserve_fraction: 0.2 },
    },
    decision: { status: 'conditional_shortlist', summary: 'Harbor is a conditional candidate for the 25-person scenario. Verify integrations and resolve the other tools’ applicable prices before choosing.', shortlist: ['target-0'] },
    cells: targets.flatMap((target, i) => [
      { ...scope, target_id: target.id, criterion_id: 'price', assessment: i === 0 ? 'meets' as const : i === 2 ? 'does_not_meet' as const : 'unknown' as const,
        summary: ['The displayed plan is $300/month for up to 50 employees.', 'The applicable plan requires a quote; total cost is unknown.', 'The displayed plan is $600/month for this company size.', 'Pricing could not be observed because the pricing host was blocked.'][i],
        bases: i === 3 ? [] : ['vendor_claim' as const], eligible: 5, assessed: i === 3 ? 0 : 3, distinct_sources: i === 3 ? 0 : 1,
        evidence: i === 3 ? [] : [{ event_seq: 100 + i, assessment_seq: 200 + i, episode_id: `episode-${i}`, persona_id: 'p-1-0', captured_at: 0, source: `https://tool-${i}.example/pricing`, quote: ['Up to 50 employees: $300 per month.', 'Contact us for a quote.', 'Companies with 20–100 employees: $600 per month.'][i], screenshot: `shots/pricing-${i}.jpg`, proposition: 'The displayed terms apply to the 25-person scenario.', basis: 'vendor_claim' as const }],
        limitations: i === 3 ? ['Pricing host blocked by the configured access policy.'] : ['Displayed terms do not verify add-ons or contractual fees.'] },
      { ...scope, target_id: target.id, criterion_id: 'integration', assessment: 'unknown' as const, summary: 'The required integration was not verified on the visited pages.', bases: [], eligible: 5, assessed: 0, distinct_sources: 0, evidence: [], limitations: ['Check the applicable plan documentation.'] },
    ]),
    coverage: targets.map((target, i) => ({ ...scope, target_id: target.id, scheduled: 5, attempted: i === 1 ? 3 : 5, outcomes: { completed: i === 1 ? 2 : 3, task_failed: i === 1 ? 0 : 1, abandoned: i === 1 ? 1 : 0, blocked_environment: i === 1 ? 0 : 1, incomplete: i === 1 ? 2 : 0, invalid_task: 0, not_applicable: 0, not_attempted: 0 }, valid_attempts: i === 1 ? 3 : 4, completion_rate: i === 1 ? 2 / 3 : 3 / 4 })),
    fits: targets.map((target, i) => ({ ...scope, target_id: target.id, status: i === 0 ? 'conditional' as const : i === 2 ? 'not_suitable' as const : 'insufficient_evidence' as const, strengths: i === 0 ? ['Cost for this company size'] : [], gaps: i === 2 ? ['Cost for this company size'] : [], unknowns: i === 0 || i === 2 ? ['Required integrations'] : ['Cost for this company size', 'Required integrations'] })),
    tradeoffs: [],
    actions: [{ owner: 'buyer', target_id: 'target-1', ...scope, criterion_id: 'price', action: 'Request the applicable quote and total-cost terms.', rationale: 'The visible quote requirement leaves this must-have unresolved.', expected_benefit: 'A comparable quote could settle cost eligibility.', validation: 'Compare the quote with the same 25-person scenario, billing period and add-ons.', evidence_seqs: [101] }],
    pairs: [{ target_ids: ['target-0', 'target-1'], scenario_id: 'small-team', task_id: 'evaluate', segment_id: 'seg-a', matched: 2, completion_difference: 0 }],
    orders: [{ persona_id: 'p-1-0', task_id: 'evaluate', target_order: targets.map((target) => target.id) }],
    limitations: ['Unequal task coverage can change the apparent result. No unconditional winner is supported.', 'Preference collection was not performed.'],
    rejected_assessments: [{ seq: 321, reason: 'A candidate-profile quote does not support a pricing assessment.' }],
  };
}
