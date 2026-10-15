import { runEpisode } from './agent/loop.ts';
import { BUILTIN_PERSONA } from './persona.ts';
import { buildReport } from './report/build.ts';
import { allowedHosts, productionDomain } from './safety.ts';
import type { BlobStore, BrowserPool, LlmGateway, ProjectStore, Recorder, SessionStore } from './seams.ts';
import type { EventPayloads, GnomiEvent, ProjectConfig, Report, RunConfig, SessionInfo } from './types.ts';

export interface RunDeps {
  store: ProjectStore;
  blobs: BlobStore;
  browsers: BrowserPool;
  llm: LlmGateway;
  record: Recorder;
  /** Where the role's storage state is loaded from; null when no session key has arrived. */
  sessions: SessionStore | null;
}

export interface RunHandle {
  run_id: string;
  /** Cancels the in-flight model call (a browser action already under way completes); the run then ends with run.stopped(user). */
  stop(): void;
  /** Continues a persona paused by persona.blocked, with the role's session as it is now; ignored when she is not paused. */
  resume(persona_id: string): void;
  /** Resolves with the final report after report.generated is recorded. Run failures never reject it: they end as run.stopped(error). */
  done: Promise<Report>;
}

export function createRecorder(store: ProjectStore, onEvent: (event: GnomiEvent) => void): Recorder {
  return (event, transcript) => {
    const stored = store.append(event);
    if (transcript) store.saveTranscript(stored.run_id, stored.seq, transcript.request, transcript.response);
    onEvent(stored);
    return stored;
  };
}

/** M0/M1 defaults (roadmap): the built-in persona, a Claude Haiku navigator, 40 steps, a $1 cap, screenshots on, 10-minute pauses. */
export function newRunConfig(project: ProjectConfig, opts: { session: SessionInfo | null; reset: boolean }): Omit<RunConfig, 'run_id'> {
  return {
    seed: Math.floor(Math.random() * 2 ** 31),
    project,
    persona: BUILTIN_PERSONA,
    model: { provider: 'anthropic', navigator: 'claude-haiku-5-5' },
    step_budget: 40,
    cost_budget_usd: 1,
    screenshots: true,
    session: opts.session,
    reset: opts.reset,
    pause_timeout_ms: 10 * 60_000,
    app_version: '0.0.0', // shortcut: fixed until packaging (M7) stamps a real version
  };
}

export function startRun(config: RunConfig, { store, blobs, browsers, llm, record, sessions }: RunDeps): RunHandle {
  const { run_id, persona } = config;
  const { poi } = config.project;
  const controller = new AbortController(); // aborted by stop() and by a tripwire
  let halted: EventPayloads['run.stopped'] | null = null; // a tripwire's reason, which outranks the abort it caused
  const paused = new Map<string, () => void>();
  // The budget reads spend from the log, so it counts every llm.call the gateway recorded, retries included.
  const spentUsd = () => store.events(run_id, { types: ['llm.call'] }).reduce((sum, e) => sum + (e.type === 'llm.call' ? e.payload.cost_usd : 0), 0);
  const base = { run_id, round: 1, persona_id: null, poi_id: null };
  const inPoi = { ...base, persona_id: persona.id, poi_id: poi.id };

  const tripwire = (kind: EventPayloads['containment.tripwire']['kind'], detail: string) => {
    if (halted) return;
    record({ ...inPoi, type: 'containment.tripwire', payload: { kind, detail } });
    halted = { reason: 'tripwire', detail };
    controller.abort();
  };

  // Loaded on every open, so a persona resumed after a re-recording logs in with the new session.
  const openPage = async () => {
    const role = config.session?.role;
    const saved = role ? await sessions?.load(role) : null;
    if (role && !saved) throw new Error(`The recorded "${role}" login is missing. Record it again, then start a new run.`);
    return browsers.newPage({
      device: persona.device,
      allowedHosts: allowedHosts(poi),
      blockedDomains: poi.production_domains,
      storageState: saved?.state ?? null,
      onBlockedRequest: ({ host, url, method, navigation }) => {
        record({ ...inPoi, type: 'containment.blocked_request', payload: { host, url, method } });
        const production = productionDomain(host, poi.production_domains);
        if (navigation && production) tripwire('production_host', `The persona tried to open ${url}, on the production domain ${production}.`);
      },
    });
  };

  const waitForResume = () =>
    new Promise<'resumed' | 'timeout' | 'stopped'>((resolve) => {
      if (controller.signal.aborted) return resolve('stopped');
      const end = (how: 'resumed' | 'timeout' | 'stopped') => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        paused.delete(persona.id);
        resolve(how);
      };
      const onAbort = () => end('stopped');
      const timer = setTimeout(() => end('timeout'), config.pause_timeout_ms);
      controller.signal.addEventListener('abort', onAbort);
      paused.set(persona.id, () => end('resumed'));
    });

  const resetStaging = async (url: string | null) => {
    if (!url) throw new Error('This project has no reset hook to call.');
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(url, { method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      status = res.status;
      await res.body?.cancel();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    record({ ...base, type: 'run.reset_called', payload: { url, status, error } });
    if (error !== null || status === null || status < 200 || status > 299) throw new Error(`The reset hook ${error ? `failed: ${error}` : `answered ${status}`}`);
  };

  const execute = async (): Promise<Report> => {
    record({ ...base, type: 'run.started', payload: { config } });
    let stopped: EventPayloads['run.stopped'] | null = null;
    try {
      if (config.reset) await resetStaging(poi.reset_hook_url);
      record({ ...base, persona_id: persona.id, type: 'persona.created', payload: { persona } });
      const end = await runEpisode({ config, openPage, llm, blobs, record, signal: controller.signal, spentUsd, tripwire, waitForResume });
      if (end === 'stopped') stopped = halted ?? { reason: 'user', detail: null };
      if (end === 'cost_budget') stopped = { reason: 'cost_budget', detail: `spent $${spentUsd().toFixed(4)} of the $${config.cost_budget_usd} budget` };
    } catch (err) {
      stopped = halted ?? (controller.signal.aborted ? { reason: 'user', detail: null } : { reason: 'error', detail: err instanceof Error ? err.message : String(err) });
    }

    record(stopped ? { ...base, type: 'run.stopped', payload: stopped } : { ...base, type: 'run.finished', payload: {} });
    const reason = stopped && (stopped.detail ? `${stopped.reason}: ${stopped.detail}` : stopped.reason);
    store.finishRun(run_id, stopped ? 'stopped' : 'finished', reason, spentUsd());
    // The report is a fold over the log alone, never over in-memory state (tech.md §5.1).
    const report = buildReport(store.events(run_id));
    const path = `runs/${run_id}/report.json`;
    await blobs.put(path, new TextEncoder().encode(JSON.stringify(report, null, 2)));
    record({ ...base, type: 'report.generated', payload: { path, friction_count: report.frictions.length } });
    return report;
  };

  return { run_id, stop: () => controller.abort(), resume: (persona_id) => paused.get(persona_id)?.(), done: execute() };
}
