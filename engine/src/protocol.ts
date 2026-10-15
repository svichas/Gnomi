import type { SecretName } from './seams.ts';
import type { GnomiEvent, Persona, ProjectConfig, Report, RunRow } from './types.ts';

// Engine ⇄ client messages over a MessagePort (tech.md §11). Main and the renderer are both clients.
// Every request gets exactly one response; events stream to every client as they are appended.

export interface ProjectInfo {
  dir: string;
  project: ProjectConfig | null;
  persona: Persona; // the built-in persona every M0 run uses
  runs: RunRow[];
}

export interface Api {
  set_secret: { params: { name: SecretName; value: string | null }; result: null };
  open_project: { params: { dir: string }; result: ProjectInfo };
  get_project: { params: Record<string, never>; result: ProjectInfo };
  save_project: { params: { project: ProjectConfig }; result: null };
  test_key: { params: Record<string, never>; result: { ok: boolean; error: string | null } };
  start_run: { params: Record<string, never>; result: { run_id: string } };
  stop_run: { params: { run_id: string }; result: null };
  get_events: { params: { run_id: string; after_seq: number | null }; result: GnomiEvent[] };
  get_report: { params: { run_id: string }; result: Report };
  get_blob: { params: { path: string }; result: { mime: string; base64: string } };
}

export type Method = keyof Api;

export type ClientToEngine = {
  [M in Method]: { kind: 'request'; id: number; method: M; params: Api[M]['params'] };
}[Method];

export type EngineToClient =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }
  | { kind: 'event'; event: GnomiEvent };
