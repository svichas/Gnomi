import type { ZodType } from 'zod';
import type { ClientToEngine, EngineToClient } from './protocol.ts';
import type {
  Action,
  ActionOutcome,
  Device,
  EventType,
  GnomiEvent,
  LlmRole,
  NewEvent,
  PageSnapshot,
  ProjectConfig,
  RunConfig,
  RunRow,
  RunStatus,
} from './types.ts';

// Seams (tech.md §16.2): engine code reaches disk, keys, browsers, models and clients only through
// these interfaces, so a headless or cloud runner swaps implementations, not logic.

/** One project folder: project.sqlite (config, runs, append-only event log) plus blobs. */
export interface ProjectStore {
  readonly dir: string;
  getProject(): ProjectConfig | null;
  saveProject(project: ProjectConfig): void;
  /** Assigns the next run id ('r-0001', …) and stores the frozen snapshot with status 'running'. */
  createRun(snapshot: Omit<RunConfig, 'run_id'>): RunConfig;
  finishRun(run_id: string, status: Exclude<RunStatus, 'running'>, stop_reason: string | null, cost_usd: number): void;
  /** Newest first. */
  listRuns(): RunRow[];
  /** Assigns seq (monotonic per run, from 1) and ts; durable when it returns. */
  append(event: NewEvent): GnomiEvent;
  /** In seq order. */
  events(run_id: string, opts?: { afterSeq?: number; personaId?: string; types?: EventType[]; limit?: number }): GnomiEvent[];
  saveTranscript(run_id: string, seq: number, request: unknown, response: unknown): void;
  transcripts(run_id: string): { seq: number; request_json: string; response_json: string }[];
  close(): void;
}

/** Screenshots and exports, addressed by paths relative to the project folder. */
export interface BlobStore {
  put(path: string, data: Uint8Array): Promise<void>;
  get(path: string): Promise<Uint8Array>;
}

export type SecretName = 'anthropic_api_key';

export interface SecretsStore {
  get(name: SecretName): string | null;
}

/** Appends to the log, saves the transcript when given, notifies clients; returns the stored event. */
export type Recorder = (event: NewEvent, transcript?: { request: unknown; response: unknown }) => GnomiEvent;

export interface BrowserPool {
  /** A fresh isolated context and page. `navigate` may only reach `origin`. */
  newPage(opts: { device: Device; origin: string }): Promise<PageDriver>;
  close(): Promise<void>;
}

export interface PageDriver {
  goto(url: string): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  /** JPEG of the viewport, password inputs masked. */
  screenshot(): Promise<Uint8Array>;
  /** Browse actions only; done/abandon never reach the page. A bad ref returns ok=false, never throws. */
  act(action: Action): Promise<ActionOutcome>;
  close(): Promise<void>;
}

export type UserPart = { type: 'text'; text: string } | { type: 'image'; data: Uint8Array; mediaType: 'image/jpeg' };

export interface LlmRequest<T> {
  role: LlmRole;
  model: string;
  run_id: string;
  persona_id: string | null;
  round: number;
  system: string; // stable prefix, marked as a cache breakpoint
  user: UserPart[]; // volatile suffix
  schema: ZodType<T>;
  signal?: AbortSignal;
}

export interface LlmResult<T> {
  object: T;
  cost_usd: number;
}

export interface LlmGateway {
  /** Records one llm.call event (with its transcript) per attempt; retries once on invalid output, then throws. */
  call<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

export interface Transport {
  send(msg: EngineToClient): void;
  onMessage(handler: (msg: ClientToEngine) => void): void;
}
