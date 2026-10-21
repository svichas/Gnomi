import type { ZodType } from 'zod';
import type {
  Action,
  ActionOutcome,
  Device,
  EventType,
  EventPayloads,
  GnomiEvent,
  LlmRole,
  ModelChoice,
  NewEvent,
  PageFlags,
  PageSnapshot,
  ProjectConfig,
  RunConfig,
  RunRow,
  RunStatus,
  Persona,
  SessionInfo,
  SetupCall,
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
  /** For model work after the run ended, such as a rejudge, so the run's row counts what its log does. */
  setRunCost(run_id: string, cost_usd: number): void;
  /** Newest first. */
  listRuns(): RunRow[];
  /** Assigns seq (monotonic per run, from 1) and ts; durable when it returns. */
  append(event: NewEvent): GnomiEvent;
  /** In seq order. */
  events(run_id: string, opts?: { afterSeq?: number; personaId?: string; types?: EventType[]; limit?: number }): GnomiEvent[];
  saveTranscript(run_id: string, seq: number, request: unknown, response: unknown): void;
  transcripts(run_id: string): { seq: number; request_json: string; response_json: string }[];
  listSessions(): SessionInfo[];
  /** Insert or replace by role. Metadata only: the storage state goes through SessionStore. */
  putSession(info: SessionInfo): void;
  /** The current editable population, in segment then slot order. Runs freeze a copy in their snapshot. */
  listPersonas(): Persona[];
  /** Count setting used by the last successful population generation. Individual edits do not change it. */
  getGeneratedPersonaCount(): number | null;
  /** Swaps the whole population and, when supplied, its generated count in one transaction. */
  replacePersonas(personas: Persona[], personaCount?: number): void;
  /** Insert or replace by id. */
  putPersona(persona: Persona): void;
  deletePersona(id: string): void;
  getPersonaDraft(key: string): unknown;
  putPersonaDraft(key: string, value: unknown): void;
  clearPersonaDrafts(): void;
  recordSetupCall(context: Pick<SetupCall, 'task_id' | 'persona_id' | 'purpose'>, attempt: LlmAttempt): void;
  /** Most recent setup task, in attempt completion order; no transcripts sent to the renderer. */
  listSetupCalls(): SetupCall[];
  close(): void;
}

/** Screenshots and exports, addressed by paths relative to the project folder. */
export interface BlobStore {
  put(path: string, data: Uint8Array): Promise<void>;
  get(path: string): Promise<Uint8Array>;
}

/** Provider keys, the Figma token, and session_key: 64 hex chars (AES-256) that encrypt recorded sessions. Main keeps all of them in the OS keychain. */
export type SecretName = 'anthropic_api_key' | 'openai_api_key' | 'google_api_key' | 'deepseek_api_key' | 'figma_token' | 'session_key';

export interface SecretsStore {
  get(name: SecretName): string | null;
}

/** Appends to the log, saves the transcript when given, notifies clients; returns the stored event. */
export type Recorder = (event: NewEvent, transcript?: { request: unknown; response: unknown }) => GnomiEvent;

/** A Playwright storage state (cookies, local storage). Opaque outside the browser module; plaintext only in memory. */
export type StorageState = Record<string, unknown>;

/** Recorded logins: metadata in the project database, storage state AES-256-GCM-encrypted under sessions/ with the session key. */
export interface SessionStore {
  list(): SessionInfo[];
  save(info: SessionInfo, state: StorageState): Promise<void>;
  load(role: string): Promise<{ info: SessionInfo; state: StorageState } | null>;
  markVerified(role: string, at: number): void;
}

export interface PageOptions {
  device: Device;
  locale?: string; // browser locale; falls back to en-US outside a persona run
  timezone?: string; // IANA timezone; UTC when unspecified
  languages?: string[]; // ordered browser and Accept-Language preferences
  /** Hostnames that requests and `navigate` may reach, start_url's host first; every other request is aborted. */
  allowedHosts: string[];
  /** Never reachable, subdomains included, even when listed in allowedHosts. */
  blockedDomains: string[];
  /** A recorded session to start from, or null to browse logged out. */
  storageState: StorageState | null;
  /** Called once per distinct method + host + path the page tried to reach and was refused; navigation = a page load, not a subresource. */
  onBlockedRequest(request: { host: string; url: string; method: string; navigation: boolean; reason: BlockReason }): void;
  /**
   * Observe-only (tech.md §9.3): only GET and HEAD reach the network, no WebSocket opens, page loads are paced one per two seconds,
   * and a page load `robots` refuses is blocked. Absent in full mode.
   */
  observe?: { robots: (url: URL) => boolean };
}

/** Why containment refused a request: an unlisted or production host, a write in observe-only mode, or a path robots.txt disallows. */
export type BlockReason = 'host' | 'observe_only' | 'robots';

export interface LoginRecording {
  /** What the human's login left behind: cookies and storage, the current page as start page, and the hosts seen. Closes the browser. */
  finish(): Promise<{ storageState: StorageState; start_url: string; hosts: string[]; expires_at: number | null }>;
  cancel(): Promise<void>;
  /** The recorder's Playwright page, for tests that log in the way a human would. */
  readonly page: unknown;
}

export interface BrowserPool {
  /** A fresh isolated context and page under containment. */
  newPage(opts: PageOptions): Promise<PageDriver>;
  /** A visible browser on url for a human to log in (tech.md §9.1): no form field is ever read and no model runs. */
  record(url: string, opts?: { headless?: boolean }): Promise<LoginRecording>;
  /** Loads startUrl with the session, under containment, and says whether it stayed off a login page. */
  checkSession(opts: {
    storageState: StorageState;
    startUrl: string;
    allowedHosts: string[];
    blockedDomains: string[];
  }): Promise<{ ok: boolean; url: string; reason: string | null }>;
  close(): Promise<void>;
}

export type PageError = Pick<EventPayloads['signal.error'], 'kind' | 'status' | 'message'>;

export interface PageDriver {
  goto(url: string): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  /** JPEG of the viewport, password inputs masked. */
  screenshot(): Promise<Uint8Array>;
  /** Browse actions only; done/abandon never reach the page. A bad ref returns ok=false, never throws. */
  act(action: Action): Promise<ActionOutcome>;
  /** Login page, bot challenge and live-payment-key checks on the current page, run after every step. */
  inspect(): Promise<PageFlags>;
  /** Console errors, uncaught exceptions and 4xx/5xx document/XHR/fetch responses from allowed hosts since the last call. */
  errors(): PageError[];
  /** The cookies and local storage the page holds now, so a page reopened later carries on as the same visitor. */
  storageState?(): Promise<StorageState>;
  close(): Promise<void>;
}

export type UserPart = { type: 'text'; text: string } | { type: 'image'; data: Uint8Array; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' };

/** One provider attempt, including failed/invalid answers. Transcripts are credential-redacted. */
export interface LlmAttempt {
  payload: EventPayloads['llm.call'];
  transcript: { request: unknown; response: unknown };
}

export interface LlmRequest<T> {
  role: LlmRole;
  model: ModelChoice;
  run_id: string | null; // null for setup calls (proposing an audience, writing personas): priced, but not logged as run events
  persona_id: string | null;
  round: number;
  purpose?: string; // a label for logs and scripted responders, e.g. 'propose_audience'
  poi_id?: string; // the POI the call is about, recorded on the llm.call event so cost can be attributed per POI
  /**
   * A prefix many personas send unchanged, such as the text of a text POI: it goes before `system` with a cache breakpoint of its
   * own, so every persona reading it shares one cached copy instead of each paying for it in full.
   */
  shared?: string;
  system: string; // stable prefix, marked as a cache breakpoint
  user: UserPart[]; // volatile suffix
  schema: ZodType<T>;
  signal?: AbortSignal;
  effort?: 'none' | 'low' | 'medium' | 'high';
  max_output_tokens?: number;
  /** Total call deadline, including queueing and retries. */
  timeout_ms?: number;
  /** Synchronous notification after recording each attempt, before returning or retrying; also runs for setup calls. */
  onAttempt?(attempt: LlmAttempt): void;
}

/** A scripted model's answer to one request (tests and GNOMI_FAKE_LLM). */
export type Responder = (req: LlmRequest<unknown>) => unknown;

export interface LlmResult<T> {
  object: T;
  cost_usd: number;
}

export interface LlmGateway {
  /** Records one llm.call event (with its transcript) per attempt; retries once on invalid output, then throws. */
  call<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}
