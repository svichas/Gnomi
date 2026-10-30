// The report: a projection of the event log (tech.md §5.1), rebuilt by report/build.ts.
import type { InfluenceEdge } from '../social/influence.ts';
import type { AttributeValue, BuyerAnswers, CheckVerdict, Device, ModelChoice, Outcome, PoiType, ProfileAttribute, Routing, SignalKind, StepEvidence } from '../types.ts';

/** How much a finding rests on: no persona first-hand, one persona, a few, or a clear share of those who could meet it. */
export type EvidenceLevel = 'strong' | 'some' | 'single' | 'none';

/** k of n personas, with a 95% Wilson interval: what the share could plausibly be with this few personas. */
export interface Prevalence {
  personas: number; // k: personas with the finding
  exposed: number; // n: personas who could meet it: who reached its pages, or for buyer objections who answered a buyer survey
  share: number; // k ÷ n
  low: number;
  high: number;
  level: EvidenceLevel;
}

export type ReportFriction = {
  seq: number; // the friction event, so every finding links back to the log
  persona_id: string;
  persona_name: string;
  segment_id: string | null;
  step_no: number;
  severity: number;
  what: string;
  expected: string;
  url: string;
  quote: string; // the persona's think-aloud at that step
  screenshot: string | null;
} & StepEvidence;

export interface ReportPersona {
  id: string;
  name: string;
  job_title?: string; // omitted when disabled in the run's frozen profile schema
  segment_id: string | null;
  device: Device;
  outcome: Outcome; // done only when every non-competitor POI it was given ended done, else its worst POI's outcome
  outcome_text: string | null;
  pois?: Record<string, Outcome>; // per non-competitor POI it was given; only when the project has more than one
  steps: number;
  frictions: number;
  attributes?: Record<string, AttributeValue>; // enabled report dimensions only
}

export interface ReportDimension {
  id: string;
  name: string;
  type: ProfileAttribute['type'];
  values: { value: AttributeValue; personas: number; completion: number | null; with_friction: number | null; sentiment: number | null }[]; // rates null with nobody started
}

export interface ReportSegment {
  id: string | null; // null: the built-in persona of a run without an audience
  name: string;
  share: number; // percent, as the audience set it
  personas: number;
  outcomes: Record<Outcome, number>;
  completion: number | null; // done ÷ personas who started; null when none started
  with_friction: number | null; // personas with a self-report, survey friction or signal in a friction theme ÷ personas who started
  frictions: number;
  pois?: { poi_id: string; personas: number; completion: number | null }[]; // per non-competitor POI, of those who started it; only with more than one
}

/** Evidence trust within the simulation (tech.md §8.1): a self-report backed by a signal, a signal alone, a self-report alone. */
export type Trust = 'confirmed' | 'observed' | 'reported';

/** One member friction shown as evidence for a theme. */
export type ReportEvidence = {
  seq: number; // the self-report, survey or signal event
  step_seq: number | null; // the persona.step it happened at, for the inspector; null for survey answers
  persona_id: string;
  persona_name: string;
  segment_id: string | null;
  step_no: number | null;
  url: string | null;
  severity: number;
  trust: Trust;
  what: string;
  quote: string; // the persona's think-aloud at that step, or the survey's reason
  screenshot: string | null;
  signals: SignalKind[];
} & StepEvidence;

/** Frictions grouped into one problem, ranked by severity tier, then the low end of the first-hand share × trust (tech.md §8.2). */
export interface ReportTheme {
  id: string; // its group ids joined by '+'
  keys?: string[]; // each group's key, which unlike the id means the same in another run (report/match.ts); absent in older reports
  poi_id: string;
  rank: number; // 1 first, within the POI
  title: string;
  description: string;
  named_by: 'judge' | 'rules'; // rules: the judge did not run, failed or left the group out
  category?: 'friction' | 'objection'; // objection: a reason not to adopt, from the survey; absent before structured surveys
  prevalence?: Prevalence; // first-hand personas only (new_simulation.md §4); absent in reports written before it
  heard_first?: number; // personas who reported it only after a feed showed them a post about it; absent before echo counting
  first_hand?: string[]; // the persona ids counted in prevalence; absent before it was stored
  trust: Trust; // the highest among member frictions
  trust_counts?: Record<Trust, number>; // member frictions per trust; absent in older reports
  severity: number; // median over personas of each persona's highest member severity, 1–4
  score: number; // prevalence.low × the mean trust weight of its personas; ranked after the severity tier. Older reports used other formulas
  personas: number;
  frictions: number;
  pages: string[]; // page patterns, ids normalised out
  elements: string[]; // role "name"
  affected: { segment_id: string | null; name: string; affected: number; reached: number; rate: number }[]; // affected: first-hand personas
  evidence: ReportEvidence[]; // at most three, highest severity first
  seqs: number[]; // every member's events, so the theme always links to the log
  suggestion: { change: string; solution: string } | null; // generated by the author model; a suggestion, not a finding
  check?: { verdict: CheckVerdict; reason: string }; // a model's review of the evidence; absent when the check did not cover the theme
}

/** End-of-episode survey answers per segment (tech.md §8.2 step 8). */
export interface ReportSentiment {
  segment_id: string | null;
  name: string;
  surveyed: number; // answers from users, one per persona and POI; buyers are in ReportBuyers
  sentiment: number | null; // mean, −2…+2
  would_continue: number; // share of the answers
}

/** How the personas who used both compared a competitor's site with the team's product (tech.md §7), by segment. */
export interface ReportComparison {
  poi_id: string; // the competitor, an observe-only POI
  with_poi_id: string; // the team's product: the first web POI in full mode
  segments: { segment_id: string | null; name: string; compared: number; product: number; competitor: number; no_preference: number }[];
  answers: { seq: number; persona_id: string; persona_name: string; segment_id: string | null; prefers: 'product' | 'competitor' | 'no_preference'; reason: string }[];
}

/** A survey like and how many personas named it. */
export interface ReportLike {
  text: string; // the judge's title, else the words of the first answer
  count: number;
  personas: number;
  seqs: number[];
  description?: string; // what worked and where, when the judge merged and named the likes
  where?: string[]; // the parts of the product the answers name
  quotes?: { persona_id: string; persona_name: string; what: string }[]; // up to three, one per persona
  prevalence?: Prevalence; // in reports from structured surveys on
}

/** The buying survey of one segment about one POI (report/buyers.ts). */
export interface ReportBuyers {
  poi_id: string;
  segment_id: string | null;
  name: string; // the segment's
  surveyed: number;
  sentiment: number; // mean, −2…+2
  would_buy: number; // share of surveyed personas
  price: Record<BuyerAnswers['price'], number>; // personas per answer
  objections: ReportLike[];
  unclear: ReportLike[];
}

export interface Report {
  comparison?: import('../comparison/types.ts').ComparisonReport;
  run_id: string;
  status: 'running' | 'finished' | 'stopped';
  stop_reason: string | null;
  goal: string;
  pois: { id: string; type: PoiType; name: string; start_url: string | null; competitor?: true }[]; // in the project's order; start_url for web POIs only; competitor: observe-only
  personas: ReportPersona[]; // in start order
  segments: ReportSegment[];
  dimensions?: ReportDimension[]; // rebuilt from each run's frozen schema and persona values
  weighted: { completion: number | null; with_friction: number | null }; // Σ share × rate over segments: each segment counts by its share, not its persona count; null when none started
  steps: number; // all personas together
  frictions: ReportFriction[]; // in seq order
  // M3 friction pipeline; absent in reports written before it. Themes are ranked within each POI.
  themes?: ReportTheme[];
  set_aside?: ReportTheme[]; // themes the evidence check put down to a persona's mistake or the test setup: rank 0, outside the friction rate; only when there are some
  sentiment?: ReportSentiment[];
  went_well?: ReportLike[];
  comparisons?: ReportComparison[]; // competitor POIs compared with the team's product; only in runs with such answers
  spread?: ReportSpread[]; // M4 opinion spread per POI; only in runs with social posts
  buyers?: ReportBuyers[]; // M5 buying survey per POI and segment; only in runs where a buyer answered one
  cost_usd: number;
  llm_calls: number;
  unreported_usage_calls?: number; // explicit missing usage in new logs; absent in legacy reports
  input_tokens: number;
  output_tokens: number;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  banner: string; // the hypothesis banner, on every report
  methods: ReportMethods;
}

// The methods appendix (idea.md §6.5): what the run was allowed to do and what got in its way.
export interface ReportMethods {
  seed: number; // the audience seed, or the run seed without an audience
  roles: string[]; // the logins personas used
  models: Partial<Routing>; // the roles this run called, with their models
  check_model?: ModelChoice; // the model the evidence check called, which the judge role in models does not show; only in runs with a check call
  budgets: { cost_usd: number; wall_clock_min: number; concurrency: number };
  allowed_hosts: string[]; // start_url's host first, then the POI's allowed hosts
  blocked_requests: { host: string; count: number; reason?: 'observe_only' | 'robots' }[]; // distinct blocked requests per host and reason, most first
  blocked: { persona_id: string; step_no: number; reason: string; detail: string; resumed: boolean }[];
  tripwires: { kind: string; detail: string }[];
  reset: { url: string; status: number | null; error: string | null } | null;
  concurrency_changes: { concurrency: number; reason: string }[];
  signal_thresholds?: Record<string, unknown> | null; // as the run froze them; null when it did not
  undersized_targets?: { page: string; element: string | null; width: number; height: number; personas: number }[]; // an audit, not findings: the team's product's small_target signals, so only elements a mobile persona tapped, by page, element and size, most personas first; only in runs with one
  limitations?: string[]; // what the report's analysis could not do, in plain words
  homogeneity?: ReportHomogeneity; // M4; only in runs with social posts
}

/** The homogeneity guard (tech.md §6.6): a swarm that writes with one voice is not simulating a community. */
export interface ReportHomogeneity {
  posts: number | null; // mean pairwise TF-IDF cosine of the posts the models wrote, 0–1; null under two posts
  post_count: number;
  narratives: number | null; // the same over persona backgrounds
  threshold: number; // a mean at or above it sets the warning
  warning: string | null;
}

/** A post shown in the spread section. */
export interface ReportPost {
  seq: number;
  post_id: string;
  persona_id: string;
  persona_name: string;
  segment_id: string | null;
  round: number;
  text: string;
  injected: boolean; // put in the persona's name by the test harness, not written by a model
}

/** How talk about a POI, or one of its themes, travelled on the feed (tech.md §8.2 step 7, §6.6). */
export interface SpreadStats {
  posts: number; // posts about it, replies included
  seeds: ReportPost[]; // the first posts about it: those of the earliest round with one, at most three
  first_hand: string[]; // persona ids who met it first-hand, as the theme's prevalence counts them
  second_hand: string[]; // repeats: persona ids who posted about it without meeting it first-hand
  posters?: string[]; // persona ids who posted about it; absent in older reports
  readers?: string[]; // persona ids shown one of its posts in a feed or at a step; absent in older reports
  segments: { segment_id: string | null; name: string; personas: number; seed: boolean }[]; // where its readers are; older reports: posters and influenced personas
  influence: InfluenceEdge[]; // the shared rule in social/influence.ts, limited to its posts, one per (author, persona, change)
  heard?: InfluenceEdge[]; // changes of mind at a step handed one of its posts without citing it; not counted as influence
  sentiment: { round: number; mean: number | null; personas: number }[]; // mean latest opinion at each round's end, −2…+2
}

export interface ReportSpread extends SpreadStats {
  poi_id: string;
  name: string;
  themes: (SpreadStats & { theme_id: string; rank: number; title: string })[]; // themes with a tagged post, in rank order
}
