import type { ZodType } from 'zod';
import type { ClientToEngine, EngineToClient } from './protocol.ts';
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
  listSessions(): SessionInfo[];
  /** Insert or replace by role. Metadata only: the storage state goes through SessionStore. */
  putSession(info: SessionInfo): void;
  /** The current editable population, in segment then slot order. Runs freeze a copy in their snapshot. */
  listPersonas(): Persona[];
  /** Swaps the whole population in one transaction. */
  replacePersonas(personas: Persona[]): void;
  /** Insert or replace by id. */
  putPersona(persona: Persona): void;
  deletePersona(id: string): void;
  close(): void;
}

/** Screenshots and exports, addressed by paths relative to the project folder. */
export interface BlobStore {
  put(path: string, data: Uint8Array): Promise<void>;
  get(path: string): Promise<Uint8Array>;
}

/** Provider keys, plus session_key: 64 hex chars (AES-256) that encrypt recorded sessions. Main keeps all of them in the OS keychain. */
export type SecretName = 'anthropic_api_key' | 'openai_api_key' | 'google_api_key' | 'session_key';

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
  onBlockedRequest(request: { host: string; url: string; method: string; navigation: boolean }): void;
}

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

export interface PageDriver {
  goto(url: string): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  /** JPEG of the viewport, password inputs masked. */
  screenshot(): Promise<Uint8Array>;
  /** Browse actions only; done/abandon never reach the page. A bad ref returns ok=false, never throws. */
  act(action: Action): Promise<ActionOutcome>;
  /** Login page, bot challenge and live-payment-key checks on the current page, run after every step. */
  inspect(): Promise<PageFlags>;
  close(): Promise<void>;
}

export type UserPart = { type: 'text'; text: string } | { type: 'image'; data: Uint8Array; mediaType: 'image/jpeg' };

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
  system: string; // stable prefix, marked as a cache breakpoint
  user: UserPart[]; // volatile suffix
  schema: ZodType<T>;
  signal?: AbortSignal;
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

export interface Transport {
  send(msg: EngineToClient): void;
  onMessage(handler: (msg: ClientToEngine) => void): void;
}
