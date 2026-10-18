/** Frozen comparison inputs. Ownership never grants browsing or write permission. */
export type ComparisonAccess = 'public_site' | 'documentation' | 'prototype' | 'authenticated_workflow';
export type ComparisonAssessment = 'meets' | 'partially_meets' | 'does_not_meet' | 'unknown' | 'not_applicable';
export type ComparisonBasis = 'observed_behavior' | 'vendor_claim' | 'user_supplied_claim' | 'simulated_inference';
export type ComparisonOutcome = 'completed' | 'task_failed' | 'abandoned' | 'blocked_environment' | 'incomplete' | 'invalid_task' | 'not_applicable' | 'not_attempted';

export interface ComparisonStudy {
  version: 1;
  purpose: 'improve_own_product' | 'choose_tool';
  focal_target_id: string | null;
  question: string;
  assumptions: string[];
  targets: ComparisonTarget[];
  scenarios: ComparisonScenario[];
  tasks: ComparisonTask[];
  criteria: ComparisonCriterion[];
  execution: {
    mode: 'independent' | 'buyer_journey';
    carryover: 'none' | 'prior_observations';
    social: 'off';
    order: 'balanced';
    replicate_id: string;
    analysis_reserve_fraction: number;
  };
}

export interface ComparisonTarget {
  id: string;
  name: string;
  poi_ids: string[];
  access_scope: ComparisonAccess;
  session_role: string | null;
}
export interface ComparisonScenario {
  id: string;
  name: string;
  context: string;
  segment_ids: string[] | null;
}
export interface ComparisonTask {
  id: string;
  scenario_id: string;
  instruction: string;
  success_rule: string;
  prerequisites: string[];
  requires_fixture?: boolean;
  criterion_ids: string[];
  max_steps: number;
  entries: { target_id: string; poi_id: string; start_url?: string; fixture?: string }[];
}
export interface ComparisonCriterion {
  id: string;
  name: string;
  question: string;
  importance: 'must_have' | 'preference';
  evidence_required: string;
  decision_rule: string;
}

/** Included on every semantic record so replay can validate identity before using it. */
export interface ComparisonScope {
  episode_id: string;
  replicate_id: string;
  target_id: string;
  scenario_id: string;
  task_id: string;
  segment_id: string | null;
  access_scope: ComparisonAccess;
}
export interface ComparisonEpisodeStarted extends ComparisonScope {
  order: number; // zero-based realized target position within this persona/task block
  target_order: string[];
  poi_id: string;
}
export interface ComparisonEpisodeFinished extends ComparisonScope {
  outcome: ComparisonOutcome;
  reason: string;
  evidence_seqs: number[];
}
export interface ComparisonCitation {
  event_seq: number;
  source: string; // URL or asset: identifier, recorded on the cited event
  quote: string; // captured excerpt; not a model-memory fact
}
export interface ComparisonSource extends ComparisonScope {
  source_id: string;
  poi_id: string;
  source: string; // URL or asset: identifier
  captured_at: number;
  step_seq: number;
  step_no: number;
  screenshot: string | null;
  text: string;
  kind: 'page' | 'asset' | 'action';
  interpretation?: 'simulated'; // e.g. a navigator's description of an image
}
/** The assessment is a recorded semantic judgment, not a deterministic fact. */
export interface ComparisonRecordedAssessment extends ComparisonScope {
  criterion_id: string;
  assessment: ComparisonAssessment;
  basis: ComparisonBasis;
  summary: string;
  evidence: ComparisonCitation[];
  assessor: { provider: string; model: string; prompt_version: string; rubric_version: string };
  rejection: string | null;
}

export interface ComparisonEvidence extends ComparisonCitation {
  assessment_seq: number;
  episode_id: string;
  persona_id: string;
  captured_at: number;
  screenshot: string | null;
  proposition: string;
  basis: ComparisonBasis;
}
export interface ComparisonCell {
  target_id: string;
  scenario_id: string;
  task_id: string;
  criterion_id: string;
  segment_id: string | null;
  access_scope: ComparisonAccess;
  assessment: ComparisonAssessment;
  summary: string;
  bases: ComparisonBasis[];
  eligible: number;
  assessed: number;
  distinct_sources: number;
  evidence: ComparisonEvidence[];
  limitations: string[];
}
export interface ComparisonCoverage {
  target_id: string;
  scenario_id: string;
  task_id: string;
  segment_id: string | null;
  access_scope: ComparisonAccess;
  scheduled: number;
  attempted: number;
  outcomes: Record<ComparisonOutcome, number>;
  valid_attempts: number;
  completion_rate: number | null;
}
export interface ComparisonFit {
  target_id: string;
  scenario_id: string;
  task_id: string;
  segment_id: string | null;
  status: 'supported' | 'conditional' | 'not_suitable' | 'insufficient_evidence';
  strengths: string[];
  gaps: string[];
  unknowns: string[];
}
export interface ComparisonAction {
  owner: 'product_team' | 'buyer' | 'study_owner';
  target_id: string;
  scenario_id: string;
  task_id: string;
  segment_id: string | null;
  criterion_id: string | null;
  action: string;
  rationale: string;
  expected_benefit: string;
  validation: string;
  evidence_seqs: number[];
}
export interface ComparisonReport {
  version: 1;
  study: ComparisonStudy;
  decision: { status: 'conditional_shortlist' | 'insufficient_evidence' | 'no_suitable_tool'; summary: string; shortlist: string[] };
  cells: ComparisonCell[];
  coverage: ComparisonCoverage[];
  fits: ComparisonFit[];
  tradeoffs: { focal_target_id: string; other_target_id: string; scenario_id: string; task_id: string; segment_id: string | null; criterion_id: string; result: 'advantage' | 'gap' | 'parity' | 'unresolved'; summary: string; evidence_seqs: number[] }[];
  actions: ComparisonAction[];
  pairs: { target_ids: [string, string]; scenario_id: string; task_id: string; segment_id: string | null; matched: number; completion_difference: number | null }[];
  orders: { persona_id: string; task_id: string; target_order: string[] }[];
  limitations: string[];
  rejected_assessments: { seq: number; reason: string }[];
}
