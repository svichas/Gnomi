// Shared domain types. The event log is the source of truth (tech.md §5.1): everything here is
// configuration frozen into a run snapshot, an event payload, or a projection of the log.

export type Device = 'desktop' | 'mobile';

export interface Persona {
  id: string;
  name: string;
  job_title: string;
  seniority: 'junior' | 'mid' | 'senior' | 'lead';
  company_size: number;
  industry: string;
  tech_skill: number; // 1–5
  patience: number; // 1–5
  familiarity_with_category: 'low' | 'medium' | 'high';
  device: Device;
  language: string;
  accessibility_needs: 'none' | 'low_vision' | 'colour_blind' | 'screen_reader' | 'motor';
  context_of_use: string;
  goal_interpretation: string;
  motivation: number; // 1–5
  voice: string;
  seed: number;
}

export interface WebPoi {
  id: string;
  type: 'web';
  name: string;
  start_url: string; // its origin is the only host personas may reach in M0
}

export interface ProjectConfig {
  name: string;
  description: string; // one sentence about the product
  poi: WebPoi;
  goal: string;
}

export interface RunConfig {
  run_id: string;
  seed: number;
  project: ProjectConfig;
  persona: Persona;
  model: { provider: 'anthropic'; navigator: string };
  step_budget: number;
  cost_budget_usd: number;
  screenshots: boolean; // send each step's screenshot to the model; always stored as evidence
  app_version: string;
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

export const ACTION_TYPES = ['click', 'type', 'select', 'scroll', 'back', 'navigate', 'read', 'wait', 'done', 'abandon'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

// One flat action shape from model output to event payload (tech.md §6.3, §10.6). `text` is the
// typed text (type), option label (select), 'up' | 'down' (scroll), URL (navigate), summary (done)
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

export interface ActionResult {
  ok: boolean;
  url_before: string;
  url_after: string;
  dom_changed: boolean;
  error: string | null; // 'ref_not_found' | 'not_editable' | 'password_field' | 'host_not_allowed' | 'timeout' | message
}

export interface ActionOutcome extends ActionResult {
  target: ActionTarget | null;
  text: string | null; // read: the region's text
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string; // pruned accessibility snapshot, one node per line, with [ref=eN]
  hash: string;
}

export type LlmRole = 'navigator' | 'socialiser' | 'persona_writer' | 'judge' | 'author';

export interface EventPayloads {
  'run.started': { config: RunConfig };
  'run.finished': Record<string, never>;
  'run.stopped': { reason: 'user' | 'cost_budget' | 'error'; detail: string | null };
  'persona.created': { persona: Persona };
  'persona.episode_started': { poi_id: string; device: Device; start_url: string };
  'persona.step': {
    step_no: number;
    action: Action;
    target: ActionTarget | null;
    result: ActionResult;
    thought: string;
    feeling: number; // −2…+2
    snapshot_hash: string;
    screenshot: string | null; // blob path, relative to the project folder
    duration_ms: number;
  };
  'persona.friction_reported': {
    step_no: number;
    severity: number; // 1–4
    what: string;
    expected: string;
    where: { url: string; ref: string | null };
  };
  'persona.goal_done': { step_no: number; summary: string };
  'persona.abandoned': { step_no: number; reason: string };
  'signal.budget_exceeded': { step_no: number; budget: number };
  'signal.repeated_failure': { step_no: number; action: ActionType; error: string }; // the engine ended the episode, not the persona
  'llm.call': {
    role: LlmRole;
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number;
    latency_ms: number;
    status: 'ok' | 'error' | 'invalid_output';
    error: string | null;
  };
  'report.generated': { path: string; friction_count: number };
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

export interface ReportFriction {
  seq: number; // the friction event, so every finding links back to the log
  step_no: number;
  severity: number;
  what: string;
  expected: string;
  url: string;
  quote: string; // the persona's think-aloud at that step
  screenshot: string | null;
}

export interface Report {
  run_id: string;
  status: 'running' | 'finished' | 'stopped';
  stop_reason: string | null;
  goal: string;
  poi: { name: string; start_url: string };
  persona: { id: string; name: string; job_title: string; device: Device };
  outcome: 'done' | 'abandoned' | 'budget_exceeded' | 'repeated_failure' | 'incomplete';
  outcome_text: string | null;
  steps: number;
  frictions: ReportFriction[]; // in step order
  cost_usd: number;
  llm_calls: number;
  input_tokens: number;
  output_tokens: number;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  banner: string; // the hypothesis banner, on every report
}
