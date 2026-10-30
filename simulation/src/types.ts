// Shared domain types. The event log is the source of truth (tech.md §5.1): everything here is
// configuration frozen into a run snapshot, an event payload, or a projection of the log.
export type { EvidenceLevel, Prevalence, ReportFriction, ReportPersona, ReportDimension, ReportSegment, Trust, ReportBox, ReportEvidence, ReportDriver, ReportTheme, ReportReach, ReportCoverage, ReportSentiment, ReportComparison, ReportLike, ReportBuyers, ReportFlow, ReportFlowPage, ThemeValidation, StudyCount, ReportStudyPlan, Report, ReportMethods, ReportHomogeneity, ReportPost, SpreadStats, ReportSpread } from './report/types.ts';

export type Device = 'desktop' | 'mobile';

export type AccessibilityNeed = 'none' | 'low_vision' | 'colour_blind' | 'screen_reader' | 'motor';

/** What code limits about what a persona perceives (agent/prompt.ts perceptionOf): a Chromium vision emulation, or no screenshots. */
export type Perception = 'deuteranopia' | 'blurredVision' | 'screen_reader';

export type AttributeValue = string | number | boolean | string[];
export type ProfileGroup = 'identity' | 'work' | 'capability' | 'context' | 'psychology' | 'intent' | 'voice' | 'biography';
export type AttributeSamplingRule =
  | { kind: 'fixed'; value: AttributeValue }
  | { kind: 'range'; min: number; max: number; integer: boolean }
  | { kind: 'choices'; choices: { value: string | boolean; weight: number }[] };

/** Built-in fields retain their existing source when sampling is null. Custom fields always have a rule. */
export interface ProfileAttribute {
  id: string;
  name: string;
  group: ProfileGroup;
  type: 'text' | 'number' | 'choice' | 'boolean' | 'list';
  description: string;
  core: boolean;
  enabled: boolean;
  show_on_card: boolean;
  use_in_prompt: boolean;
  report_dimension: boolean;
  choices?: string[];
  sampling: { default: AttributeSamplingRule; by_segment: Record<string, AttributeSamplingRule> } | null;
}

export interface PersonaSchema {
  version: 1;
  attributes: ProfileAttribute[];
}

// One simulated person (idea.md §8.2). Traits are sampled in code from the segment's ranges first; the
// written fields (name, job title, background, context, goal interpretation, voice) come from the model after.
export interface Persona {
  id: string; // stable per slot, e.g. 'p-2-07' (segment 2, persona 7), so edits keep identities
  segment_id: string | null; // null for the built-in persona of M0/M1
  name: string;
  pronouns: 'she' | 'he' | 'they'; // sampled, so the prompt never assumes one
  job_title: string;
  seniority: 'junior' | 'mid' | 'senior' | 'lead';
  company_size: number;
  industry: string;
  tech_skill: number; // 1–5
  patience: number; // 1–5
  familiarity_with_category: 'low' | 'medium' | 'high';
  device: Device;
  language: string; // first language, BCP 47
  country?: string; // ISO 3166-1 alpha-2; absent on personas created before country sampling
  city?: string;
  timezone?: string; // IANA timezone, e.g. Europe/Berlin
  languages?: string[]; // ordered BCP 47 preferences, first is also the browser locale
  employer?: string; // sampled from the segment's optional employer list
  accessibility_needs: AccessibilityNeed;
  context_of_use: string;
  background: string; // a short narrative of who this person is, written from the sampled traits
  goal_interpretation: string;
  motivation: number; // 1–5
  voice: string;
  seed: number;
  attributes?: Record<string, AttributeValue>; // custom and additional default fields, sampled from persona_schema
  profile_signature?: string; // writer input identity; stale biographies must be regenerated after profile changes
  posting_propensity?: number; // 0–1, sampled: how readily this persona posts in social rounds (tech.md §6.6); absent before M4
}

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'openai_compatible';

export interface ModelChoice {
  provider: ProviderId;
  model: string;
}

export type LlmRole = 'navigator' | 'socialiser' | 'persona_writer' | 'judge' | 'author';

export type Routing = Record<LlmRole, ModelChoice>; // tech.md §10.2

/** Setup diagnostics are separate from run evidence and never affect run budgets. */
export interface SetupCall {
  id: number;
  ts: number;
  task_id: string;
  persona_id: string | null;
  purpose: string;
  payload: EventPayloads['llm.call'];
}

export interface PersonaProgress {
  done: number;
  total: number;
  stage?: 'sketching' | 'repairing_names' | 'writing' | 'saving';
  sketched?: number;
  recent?: string[]; // names of the latest written personas, newest first
  calls?: number;
  failed_attempts?: number;
  elapsed_ms?: number;
}

export interface RunSettings {
  routing: Routing;
  local_base_url: string | null; // the OpenAI-compatible endpoint behind provider 'openai_compatible', e.g. http://localhost:11434/v1
  concurrency: number; // personas in flight, each with its own browser context (default 12, at most 32)
  persona_concurrency?: number; // independent writer pool, 1–32; old projects default to 32
  cost_budget_usd: number;
  wall_clock_budget_min: number;
  screenshots: boolean; // send each step's screenshot to the navigator; always stored as evidence
  social?: boolean; // social rounds between usage slices (tech.md §6.4); absent before M4, which is off
  rounds?: number; // R when social rounds are on, 1–10, default 5
  network_policy?: NetworkPolicy; // which follow graph (social/graph.ts); absent means 'legacy'
  feed_policy?: FeedPolicy; // how feeds are chosen (social/feed.ts); absent means 'ranked'
  finding_check?: boolean; // review friction themes against their evidence before the author writes (report/models.ts); absent means off
  check_model?: ModelChoice; // the model for that review, which may be another family; absent means the judge's route
  accessibility_checks?: boolean; // the page scan, and what accessibility needs do in code: vision emulation and no screenshots for screen readers; absent means off
}

// The null and alternative networks are evaluation controls for the segment-biased legacy graph (new_simulation.md §4).
export type NetworkPolicy = 'legacy' | 'rewired' | 'random' | 'clustered';

// 'chronological' is the evaluation control for the ranked feed (new_simulation.md §4).
export type FeedPolicy = 'ranked' | 'chronological';

export type UsageFrequency = 'daily' | 'weekly' | 'monthly' | 'rarely' | 'never';

// A type of user with a share of the population (idea.md §8.1). Segments drive behaviour; job titles are flavour.
export interface Segment {
  id: string; // stable across edits, e.g. 'seg-2'
  name: string;
  description: string; // who these people are, in a sentence or two, for the persona writer
  share: number; // percent of the population; an audience's shares sum to 100
  role: string | null; // the recorded login its personas use; null browses logged out
  usage_frequency: UsageFrequency;
  typical_goals: string[];
  mobile_share: number; // 0–1, the share of its personas on a phone
  patience: [min: number, max: number]; // 1–5, sampled per persona
  tech_skill: [min: number, max: number]; // 1–5, sampled per persona
  account_state: 'empty' | 'populated';
  entry: 'direct' | 'email_link' | 'shared_link';
  goal_override: string | null; // replaces the project goal for this segment
  employers?: string[]; // optional organisations to spread this segment's personas across
  kind?: 'user' | 'buyer'; // absent: 'user'. Buyers only perceive, so by default they see text and designs, not web apps (tech.md §7)
  countries?: Record<string, number>; // as Audience.countries, for this segment alone (from an analytics export); replaces the audience's
  languages?: Record<string, number>; // as Audience.languages, for this segment alone; replaces the audience's
  grounding?: Grounding; // real data behind this segment; source files are read once and never kept
}

export interface GroundingSource {
  name: string; // the file's basename
  sha256: string; // of the file as read, so a team can tell which version was used
}

export interface Grounding {
  facts: string[]; // the segment's goals, vocabulary, objections and tools, in general terms
  remarks: string[]; // verbatim from the redacted sources; real people's words, shown to personas as quoted material
  sources: GroundingSource[];
}

export interface Audience {
  seed: number; // fixes every persona's sampled traits
  persona_count: number; // 20–200, default 50; each segment with a share gets at least 3
  segments: Segment[];
  company_size: [min: number, max: number]; // employees at the companies the product sells to
  // Population-wide distributions the user can see (idea.md §11, "Bias in personas"); each sums to 1.
  languages: Record<string, number>; // first language → share
  countries?: Record<string, number>; // supported ISO country code → weight; replaces language-only sampling when set
  accessibility: Record<AccessibilityNeed, number>;
}

// How alike the written personas are (tech.md §6.6): TF-IDF cosine over backgrounds, no embeddings.
export interface DiversityReport {
  mean_similarity: number; // 0–1
  max_similarity: number;
  most_similar: [persona_id: string, persona_id: string] | null;
  duplicate_names: string[];
  warning: string | null; // set when the population reads as too alike
}

export interface RunEstimate {
  calls: number;
  cost_usd: [low: number, high: number];
  minutes: [low: number, high: number];
  unpriced: string[]; // models in the routing with no price, so the cost is a floor
}

/** What every point of interest has; the type adds what its runner needs (simulation/src/poi/, docs/pois.md). */
interface PoiBase {
  id: string;
  name: string;
  segments: string[] | null; // the segment ids that engage with it, in any order; null: the default for each segment's kind (poi/pois.ts)
}

export interface WebPoi extends PoiBase {
  type: 'web';
  mode: 'full' | 'observe_only'; // observe_only: a competitor's site, browsed without writes or a login (tech.md §7, docs/pois.md)
  start_url: string; // where the login recorder opens and where logged-out personas begin
  allowed_hosts: string[]; // hosts personas may reach besides start_url's own; every other request is blocked (tech.md §9.3)
  production_domains: string[]; // never reachable, subdomains included; a run never starts against them
  reset_hook_url: string | null; // POSTed before a run when the user ticks it in the pre-run summary
}

/** Copy to read and rate: pasted, .md or .txt, stored in the project's assets/ folder. */
export interface TextPoi extends PoiBase {
  type: 'text';
  asset: string; // an asset id (simulation/src/assets.ts)
}

/** One image or an ordered sequence of frames, shown one at a time (tech.md §7). */
export interface DesignPoi extends PoiBase {
  type: 'design';
  frames: { asset: string; name: string | null }[];
}

export type Poi = WebPoi | TextPoi | DesignPoi;
export type PoiType = Poi['type'];

export interface ProjectConfig {
  comparison?: import('./comparison/types.ts').ComparisonStudy | null;
  name: string;
  description: string; // one sentence about the product
  pois: Poi[]; // in the order personas use them; projects and runs saved with one `poi` load as [poi] (poi/pois.ts)
  goal: string;
  role: string | null; // the login the built-in persona uses when there is no audience; segments carry their own
  audience: Audience | null; // null runs the single built-in persona, as in M0 and M1
  settings: RunSettings;
  persona_schema?: PersonaSchema; // absent on older projects: use the shipped default schema
}

// A recorded login (tech.md §9.1). The cookies and storage themselves stay in the engine and are encrypted on disk.
export interface SessionInfo {
  target_id?: string; // comparison sessions belong to one explicitly configured target
  role: string;
  start_url: string; // the page the user marked in the recorder: where personas in this role begin
  hosts: string[]; // hosts seen while recording, offered for the allowlist
  recorded_at: number;
  verified_at: number | null; // last time a check reached start_url without landing on a login page
  expires_at: number | null; // earliest expiry among the session's cookies; null when all are session cookies
}

// Page-content checks after every step (tech.md §9.1, §9.3).
export interface PageFlags {
  login: boolean; // a login-like URL or a visible password field
  challenge: string | null; // the CAPTCHA or bot challenge showing, e.g. 'recaptcha'
  live_key: string | null; // a live payment-provider key prefix found in the page, e.g. 'pk_live_'
}

// Everything a run depends on, frozen at start (tech.md §5.3). Runs logged before M2 have `persona`,
// `model`, `step_budget`, `cost_budget_usd`, `screenshots` and `session` instead of the fields below.
export interface RunConfig {
  run_id: string;
  seed: number;
  project: ProjectConfig; // includes the audience and the settings (routing, budgets, concurrency)
  personas: Persona[]; // the population, in start order
  sessions: SessionInfo[]; // one per role the population logs in with, as they were when the run started
  reset: boolean; // POST the POI's reset hook before the run
  pause_timeout_ms: number; // how long a blocked persona waits for the user before its episode ends
  app_version: string;
  signals?: SignalThresholds; // frozen per run, so an older run keeps its own (small_target_px was 40). Absent only on logs older than the detectors, which hold no signals
  injected_posts?: InjectedPost[]; // test harness only: posted for a persona before that round's social phase
  repeat?: { group: string; index: number; of: number }; // one run of a repeat set (report/repeats.ts), index from 1; absent on a lone run
}

/** A post the harness puts in a persona's name, e.g. the seeded complaint of the M4 spread acceptance. */
export interface InjectedPost {
  round: number;
  persona_id: string;
  poi_id: string;
  text: string;
}

/** Objective-signal thresholds (tech.md §8.1), frozen per run so a report can cite what was detected. */
export interface SignalThresholds {
  loop_visits: number; // the same page state seen this many times…
  loop_window: number; // …within this many steps is a loop
  back_count: number; // this many `back` actions…
  back_window: number; // …within this many steps is a backtrack
  revisit_window: number; // so is returning to a page acted on in this many previous steps
  small_target_px: number; // a mobile tap target narrower or shorter than this, in CSS pixels
  interference_s?: number; // a failed action on what another persona changed this many seconds before may be theirs; absent on older runs, which keep no such tag
}

export type RunStatus = 'running' | 'finished' | 'stopped' | 'interrupted';

export interface RunRow {
  run_id: string;
  status: RunStatus;
  stop_reason: string | null;
  cost_usd: number;
  started_at: number;
  ended_at: number | null;
  config: RunConfig;
}

export const ACTION_TYPES = ['click', 'hover', 'type', 'select', 'scroll', 'press', 'back', 'navigate', 'read', 'wait', 'done', 'abandon'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
// The keys press sends, as a person uses them on a form or a widget: Enter submits, Escape closes, Tab moves on, Space and the
// arrows set a slider or pick up a sortable item.
export const PRESS_KEYS = ['Enter', 'Escape', 'Tab', 'Shift+Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace'];

// One flat action shape from model output to event payload (tech.md §6.3, §10.6). `text` is the
// typed text (type), option label (select), 'up' | 'down' (scroll), one of PRESS_KEYS (press), URL (navigate), summary (done)
// or reason (abandon).
export interface Action {
  type: ActionType;
  ref: string | null;
  text: string | null;
}

export interface ActionTarget {
  role: string;
  name: string;
  box: [x: number, y: number, width: number, height: number] | null;
}

/** What a screenshot spans, in the CSS pixels of an ActionTarget's box: not always the image's size, as a phone zooms out to fit a page with no viewport tag. */
export type Viewport = [x: number, y: number, width: number, height: number];

export interface ActionResult {
  ok: boolean;
  url_before: string;
  url_after: string;
  dom_changed: boolean;
  error: string | null; // 'ref_not_found' | 'not_editable' (disabled) | 'readonly' | 'not_a_field' | 'invalid_value' | 'unreadable_date' | 'host_not_allowed' | 'timeout' | message; older logs may contain 'password_field'
  pending?: boolean; // a request the action started was still in flight, or it opened a tab: no change yet is not no effect
}

export interface ActionOutcome extends ActionResult {
  target: ActionTarget | null;
  text: string | null; // read: the region's text; an upload: the file chosen
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string; // pruned accessibility snapshot, one node per line, with [ref=eN]
  hash: string;
  viewport?: Viewport;
}

/** The persona's self-reported view of one POI, distinct from a momentary step feeling. */
export interface Opinion {
  sentiment: number; // integer −2…+2
  confidence: number; // 0…1, self-reported certainty, not calibrated confidence
  likes: string[];
  frictions: string[];
}

/** Every objective signal names the step, page and element it is about, so the report can group it with self-reports. */
export interface SignalBase {
  step_no: number;
  url: string; // the page the step acted on
  ref: string | null; // the step's target element, if any
}

/** What axe-core reports for one rule on a page. It holds no page text: the rule's own wording, and elements by tag and position. */
export interface AccessibilityViolation {
  rule: string; // axe's rule id, e.g. color-contrast
  impact: 'critical' | 'serious' | 'moderate' | 'minor';
  category: string; // axe's category of the rule, e.g. color
  help: string; // axe's one-line statement of the rule
  elements: number; // how many elements on the page break it
  selectors: string[]; // the first few of them
}

/** Where a step or friction happened on a POI without pages: the frame of a design, the passage of a text. */
export interface StepEvidence {
  frame?: number; // design POIs: the frame's index in DesignPoi.frames
  passage?: { start: number; end: number; text?: string }; // text POIs: character offsets into the text, end exclusive; a friction's carries the quoted span
}

export interface EventPayloads {
  'comparison.episode_started': import('./comparison/types.ts').ComparisonEpisodeStarted;
  'comparison.episode_finished': import('./comparison/types.ts').ComparisonEpisodeFinished;
  'comparison.assessment': import('./comparison/types.ts').ComparisonRecordedAssessment;
  'comparison.source': import('./comparison/types.ts').ComparisonSource;
  'run.started': { config: RunConfig };
  'run.reset_called': { url: string; status: number | null; error: string | null };
  'run.finished': Record<string, never>;
  'run.stopped': { reason: 'user' | 'cost_budget' | 'wall_clock' | 'tripwire' | 'error'; detail: string | null };
  // Rounds (tech.md §6.4): the envelope's `round` says which; each round is a usage slice then a social phase.
  'run.round_started': Record<string, never>;
  'run.round_ended': Record<string, never>;
  'run.concurrency_changed': { concurrency: number; reason: string }; // e.g. backing off after a provider's rate limit
  'persona.created': { persona: Persona; follows?: string[] }; // follows: persona ids from the run's follow graph (M4)
  'persona.episode_started': { poi_id: string; device: Device; start_url: string; locale?: string; timezone?: string; languages?: string[]; perception?: Perception };
  'persona.step': {
    step_no: number;
    action: Action;
    target: ActionTarget | null;
    result: ActionResult;
    thought: string;
    feeling: number; // −2…+2
    snapshot_hash: string;
    screenshot: string | null; // blob path, relative to the project folder
    viewport?: Viewport; // what the screenshot spans; absent in older logs and on texts and designs
    duration_ms: number;
    heard_post_ids: string[]; // the feed posts handed to this step's prompt; empty when none
  } & StepEvidence;
  'persona.friction_reported': {
    step_no: number;
    severity: number; // 1–4
    what: string;
    expected: string;
    where: { url: string; ref: string | null }; // ref: the element it is about, as the persona named it or the failed action before; older logs: the step's own action
    heard_post_ids: string[]; // the feed posts handed to the step it was raised in
    about?: ActionTarget; // the element it is about, when the persona named one or the action before it failed; absent in older logs
    quote_unverified?: true; // text POIs: the quote was too short or not found in the text, so no passage is linked
  } & StepEvidence;
  'persona.opinion_changed': {
    poi_id: string;
    before: Opinion | null;
    after: Opinion;
    cause: { step_ids: number[]; post_ids: string[] }; // step event seqs within this run and persona
  };
  'persona.goal_done': { step_no: number; summary: string };
  'persona.abandoned': { step_no: number; reason: string };
  'persona.blocked': { step_no: number; reason: 'captcha' | 'session_expired'; detail: string }; // paused, waiting for the user
  'persona.resumed': { step_no: number };
  // The swarm feed (tech.md §6.6). A reply is a post with a parent; `injected` marks a harness post, not a model's.
  'social.feed_viewed': { post_ids: string[]; parent_ids?: string[] }; // in the order shown: a post's feed position is its index here; parent_ids: the replies' parents it quoted, absent in older logs
  'social.discarded': { call_seq: number | null }; // a paid social answer a hard stop left unapplied; call_seq: its llm.call
  'social.post': { post_id: string; parent_id: string | null; text: string; about_poi_id: string | null; injected?: boolean };
  'social.reaction': { post_id: string; kind: 'agree' | 'disagree' };
  'containment.blocked_request': { host: string; url: string; method: string; reason?: 'observe_only' | 'robots' }; // no reason: an unlisted or production host
  'containment.tripwire': { kind: 'live_payment_key' | 'production_host'; detail: string };
  'signal.budget_exceeded': { step_no: number; budget: number };
  'signal.repeated_failure': { step_no: number; action: ActionType; error: string }; // the engine ended the episode, not the persona
  // Objective signals (tech.md §8.1), written right after the step they describe, never recomputed.
  'signal.failed_action': SignalBase & { action: ActionType; error: string }; // 'ref_not_found' | 'no_effect' | 'not_editable' | 'timeout' | message
  'signal.loop': SignalBase & { snapshot_hash: string; visits: number };
  'signal.backtrack': SignalBase & { kind: 'repeated_back' | 'revisit' };
  'signal.error': SignalBase & { kind: 'console' | 'exception' | 'http'; status: number | null; message: string };
  'signal.validation_error': SignalBase & { message: string };
  'signal.small_target': SignalBase & { box: [x: number, y: number, width: number, height: number] };
  // About the page, not the persona: on the step of whoever reached that page state first, at most once per rule and page pattern (signals/index.ts).
  'signal.accessibility': SignalBase & AccessibilityViolation;
  // One per page state per run. audit: its moderate and minor violations, which are no signals; error: why that state went unscanned.
  'accessibility.scanned': { step_no: number; url: string; snapshot_hash: string; audit: AccessibilityViolation[]; error: string | null };
  // End-of-episode survey per POI (tech.md §8.2); `reason` renders like a think-aloud line.
  'persona.survey': {
    poi_id: string;
    sentiment: number; // integer −2…+2
    confidence: number; // 0…1, self-reported
    likes: string[];
    frictions: string[]; // the friction and objection items' `what`, so readers of older logs keep working
    items?: SurveyItem[]; // structured answers, from this release on; absent in older logs and in buyers' answers
    buyer?: BuyerAnswers; // segments of kind buyer answer the buying survey (agent/buyer.ts)
    would_continue: boolean; // buyers: would buy or recommend buying
    reason: string;
    comparison?: { with_poi_id: string; prefers: 'product' | 'competitor' | 'no_preference'; reason: string }; // an observe-only POI against the team's product (poi/compare.ts)
  };
  'llm.call': {
    role: LlmRole;
    purpose?: string | null; // the request's label (step, survey, social, ...); absent in older logs
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number;
    latency_ms: number;
    reasoning_tokens?: number; // included in output_tokens, never charged twice
    queue_ms?: number;
    http_status?: number;
    usage_reported?: boolean; // false means provider usage was absent/incomplete; cost may understate billing
    status: 'ok' | 'error' | 'invalid_output';
    error: string | null;
    temperature?: number | null; // the sampling temperature sent; null when the route takes none
    seed?: number | null; // the provider seed sent; null when the provider takes none
    response_model?: string | null; // the model id the provider reported in its response, the fact behind `model`, the intent
  };
  // The report's model steps (tech.md §8.2), recorded after the episodes end and only when the model answered, so the
  // report rebuilds from the log alone. buildReport checks both against the group and theme ids each time it folds.
  'report.started': { pois: string[] }; // after the surveys: the POIs the judge and author will run for, so the app can show progress
  // keys: each friction group's id → its grouping key when the judge ran, so a rebuild under changed grouping rules drops stale answers; absent in older logs
  'report.themes': { poi_id: string; themes: JudgeTheme[]; posts?: JudgePostTag[]; likes?: JudgeLike[]; keys?: Record<string, string> }; // the judge's semantic merge and naming of friction groups; posts only when the POI had posts (M4)
  // keys: as in report.themes, when the check ran; a check older than the newest report.themes is not used
  'report.checks': { poi_id: string; checks: ThemeCheck[]; keys: Record<string, string> }; // the evidence check's verdicts on friction themes
  'report.suggestions': { poi_id: string; suggestions: AuthorSuggestion[] }; // the author's generated suggestions
  'report.generated': { path: string; friction_count: number };
  // A study plan's model answer with what it was asked about, in full, so the plan rebuilds from this event alone (report/study.ts).
  'report.study': {
    answer: { screener: string[]; themes: { theme_id: string; tasks: string[]; observe: string[] }[] };
    themes: { id: string; keys: string[]; poi_id: string; title: string; description: string; quotes: string[] }[]; // the findings covered, as they stood
    left_out: { objections: number; competitors: number; set_aside: number; scan_only: number; lower_ranked: number };
  };
  // What a team's own study with real people found, never a model's. keys: theme ids change after a rejudge. The envelope's poi_id is the theme's.
  'finding.validated': { keys: string[]; category?: 'friction' | 'objection'; title: string; status: StudyStatus; note: string | null; study_date: string }; // title: at the time; study_date: YYYY-MM-DD
}

/** The human outcome words of docs/interpreting-simulations.md. */
export const STUDY_STATUSES = ['supported', 'contradicted', 'unresolved'] as const;
export type StudyStatus = (typeof STUDY_STATUSES)[number];

/**
 * One structured survey answer (tech.md §8.2): a friction got in the way of the task, an objection is a reason to doubt or
 * not adopt the product, a like is something that worked. `where` names the page, screen, section or feature it is about.
 */
export interface SurveyItem {
  kind: 'friction' | 'objection' | 'like';
  where: string;
  what: string;
  severity: number | null; // 1–4 for frictions and objections; null for likes
}

/** A buyer's answers beyond the shared survey fields (tech.md §7: buyers answer a buying survey). */
export interface BuyerAnswers {
  would_buy: boolean; // would buy it, or recommend that whoever decides buys it
  price: 'low' | 'fair' | 'high' | 'unclear';
  objections: string[]; // what would stop the purchase, most important first
  unclear: string[]; // what the buyer could not work out
}

export interface JudgeTheme {
  title: string;
  description: string;
  group_ids: string[]; // deterministic friction groups this theme merges
}

/** The judge's merge and naming of survey likes (ids l1, l2, …), in the same call as the friction themes. */
export type JudgeLike = JudgeTheme;

/** The judge's tag of one post about the POI with the friction groups it talks about (tech.md §8.2 step 7). */
export interface JudgePostTag {
  post_id: string;
  group_ids: string[];
}

/** What a model's review of a theme's evidence points to: the product, the persona, the test setup, or nothing it can decide. */
export type CheckVerdict = 'product' | 'agent_mistake' | 'environment' | 'unclear';

/** The evidence check's answer on one theme (report/models.ts). */
export interface ThemeCheck {
  theme_id: string;
  verdict: CheckVerdict;
  reason: string;
}

export interface AuthorSuggestion {
  theme_id: string;
  change: string; // one sentence
  solution: string; // a short possible solution
}

export type EventType = keyof EventPayloads;

type Envelope = {
  run_id: string;
  round: number; // M0 runs a single round: 1
  persona_id: string | null;
  poi_id: string | null;
};

export type NewEvent = { [K in EventType]: Envelope & { type: K; payload: EventPayloads[K] } }[EventType];
export type GnomiEvent = NewEvent & { seq: number; ts: number };
export type EventOf<K extends EventType> = Extract<GnomiEvent, { type: K }>;

// not_started: the run never got to the persona (no step, no episode); it is left out of every rate.
// model_failed: the model gave no valid answer three steps running, which says nothing about the product.
export type Outcome = 'done' | 'abandoned' | 'budget_exceeded' | 'repeated_failure' | 'model_failed' | 'blocked' | 'incomplete' | 'not_started';
/** Neither says anything about the product, so the completion and friction rates leave them out. */
export const isUnrated = (outcome: Outcome) => outcome === 'not_started' || outcome === 'model_failed';

export type SignalKind = 'failed_action' | 'loop' | 'backtrack' | 'error' | 'validation_error' | 'small_target' | 'accessibility';
