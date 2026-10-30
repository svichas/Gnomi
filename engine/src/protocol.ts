import type { AssetInfo } from '@gnomi/simulation/assets.ts';
import type { FigmaFile, FigmaFrameRef, FigmaImport } from './figma/frames.ts';
import type { ReportDiff } from '@gnomi/simulation/report/diff.ts';
import type { RepeatSet } from '@gnomi/simulation/report/repeats.ts';
import type { StudyOutcome } from './workspace.ts';
import type { SecretName } from '@gnomi/simulation/seams.ts';
import type {
  Audience,
  DiversityReport,
  GnomiEvent,
  Persona,
  ProjectConfig,
  ProviderId,
  Report,
  RunEstimate,
  RunRow,
  SessionInfo,
  SetupCall,
  PersonaProgress,
} from '@gnomi/simulation/types.ts';

// Engine ⇄ client messages over a MessagePort (tech.md §11). Main and the renderer are both clients.
// Every request gets exactly one response; events stream to every client as they are appended.

export interface ProjectInfo {
  dir: string;
  project: ProjectConfig | null;
  persona: Persona; // the built-in persona, used when the project has no audience
  personas: Persona[]; // the current population, empty until personas are generated
  generated_persona_count?: number | null; // count setting used by the last successful population generation
  diversity: DiversityReport | null; // of the current population
  runs: RunRow[];
  sessions: SessionInfo[];
  setup_calls?: SetupCall[];
}

/** Lightweight, in-memory history for this engine session. Run IDs are only unique within a project. */
export interface SessionRun {
  project_id?: string;
  project_dir: string;
  project_name: string;
  run_id: string;
  started_at: number;
  ended_at: number | null;
  status: RunRow['status'];
  phase: 'starting' | 'exploring' | 'discussing' | 'reporting' | 'saving';
  waiting: number;
  stop_reason: string | null;
}

export interface Api {
  set_secret: { params: { name: SecretName; value: string | null }; result: null };
  open_project: { params: { dir: string; project_id?: string }; result: ProjectInfo };
  /** Detaches the current project for folder operations. Refuses work on the target directory. */
  close_project: { params: { dir?: string }; result: null };
  get_session_runs: { params: Record<string, never>; result: SessionRun[] };
  get_project: { params: Record<string, never>; result: ProjectInfo };
  save_project: { params: { project: ProjectConfig }; result: null };
  /** Checks the provider's saved key, or for 'openai_compatible' that the project's local endpoint answers. */
  test_key: { params: { provider: ProviderId }; result: { ok: boolean; error: string | null } };
  /** Copies a local .md, .txt, .png, .jpg or .webp file, or pasted text, into the project's assets/ folder; POIs refer to it by id. */
  import_asset: { params: { path: string } | { text: string; name?: string }; result: AssetInfo };
  /** Asks Figma whether it accepts the saved Figma token. */
  figma_test: { params: Record<string, never>; result: { ok: boolean; error: string | null } };
  /** The top-level frames of a pasted Figma file or frame link (name, page, size). Needs the Figma token, no project. */
  figma_frames: { params: { link: string }; result: FigmaFile };
  /** Small previews of frames as data URLs, by frame id; frames that could not be rendered are missing. */
  figma_previews: { params: { file: string; version: string | null; frames: FigmaFrameRef[] }; result: Record<string, string> };
  /** Exports frames as PNG, downloads them and stores each in the project's assets/ folder; frames that failed are listed with why. */
  figma_import: { params: { file: string; version: string | null; frames: (FigmaFrameRef & { name: string })[] }; result: FigmaImport };
  /** Records on an explicit comparison target, or the legacy first full web POI when no target is supplied. */
  record_session: { params: { role: string; target_id?: string }; result: null };
  /** Saves the open recording under its role; the page the user is on becomes the role's start page. */
  save_session: { params: Record<string, never>; result: SessionInfo };
  cancel_recording: { params: Record<string, never>; result: null };
  check_session: { params: { role: string }; result: { ok: boolean; url: string; reason: string | null } };
  /** Proposes segments from the product sentence, the POI and the goal (persona_writer model). Not saved. */
  propose_audience: { params: Record<string, never>; result: { audience: Audience; cost_usd: number } };
  /** Brings the population in line with the saved audience: unchanged slots keep their persona, new or changed slots are sampled and written. Progress streams as 'progress' messages. */
  generate_personas: { params: Record<string, never>; result: { personas: Persona[]; diversity: DiversityReport; cost_usd: number } };
  /** A new seed for one persona: traits re-sampled and re-written. */
  regenerate_persona: { params: { id: string }; result: { persona: Persona; cost_usd: number } };
  add_persona: { params: { segment_id: string }; result: { persona: Persona; cost_usd: number } };
  remove_persona: { params: { id: string }; result: null };
  /** Saves hand edits to a persona's written fields; sampled traits stay as they were. */
  edit_persona: { params: { persona: Persona }; result: null };
  /** With `repeats`, the whole set: the estimate of every run together. With `run_id`, of running that finished run again. */
  estimate_run: { params: { repeats?: number; run_id?: string }; result: RunEstimate };
  /**
   * Refuses (as an error) a production target, an unconfirmed non-staging host, or a missing or expired login for any role in use.
   * With `repeats` it answers with the first run; the rest of the set follow one after another, each with its logins checked again and
   * its share of the cost budget. A run that stops ends the set; a repeat that cannot start sends 'repeat_failed'.
   */
  start_run: { params: { reset: boolean; repeats?: number }; result: { run_id: string } };
  /**
   * Runs a finished run again with its frozen config and personas and a new run id, through start_run's path and refusals. `urls` moves
   * web POIs to a new address by POI id, and each new host joins that POI's allowed hosts. Refuses a run that did not finish.
   */
  duplicate_run: { params: { run_id: string; reset: boolean; repeats?: number; urls?: Record<string, string> }; result: { run_id: string } };
  /** Also ends the project's repeat set, even when the run has already logged its end and so stays finished. */
  stop_run: { params: { run_id: string; project_dir?: string }; result: null };
  /** Continues blocked personas after the user re-recorded their login or fixed staging. */
  resume_personas: { params: { run_id: string; persona_ids: string[] }; result: null };
  get_events: { params: { run_id: string; after_seq: number | null; persona_id: string | null }; result: GnomiEvent[] };
  get_report: { params: { run_id: string }; result: Report };
  /** What a repeat set's runs have in common, computed when read. Each run keeps its own report. */
  get_repeats: { params: { group: string }; result: RepeatSet };
  /** What changed from `base` to `run`, computed when read. A run of a repeat set stands for that set's finished runs. */
  compare_runs: { params: { base: string; run: string }; result: ReportDiff };
  /** What plan_study would cost: one call on the run's own author model. `cost_usd[1]` is the most it can spend. */
  estimate_study: { params: { run_id: string }; result: RunEstimate };
  /** Spends money, so only a person's click calls it, for at most estimate_study's high end. Refuses a run that has not ended and a comparison study. The new plan reaches the report through report.generated. */
  plan_study: { params: { run_id: string }; result: null };
  /** What a team's own study found about a finding, by theme id as the report shows it. Makes no model call. The report reloads on report.generated. */
  record_outcome: { params: StudyOutcome; result: null };
  /** A run's screenshot (runs/…) or a project asset (assets/<id>). */
  get_blob: { params: { path: string }; result: { mime: string; base64: string } };
}

export type Method = keyof Api;

export type ClientToEngine = {
  [M in Method]: { kind: 'request'; id: number; method: M; params: Api[M]['params'] };
}[Method];

export type EngineToClient =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }
  | { kind: 'event'; event: GnomiEvent; project_dir?: string }
  | { kind: 'session_run'; run: SessionRun }
  | { kind: 'repeat_failed'; error: string }
  | ({ kind: 'progress'; task: 'generate_personas' } & PersonaProgress);

export interface Transport {
  send(msg: EngineToClient): void;
  onMessage(handler: (msg: ClientToEngine) => void): void;
}
