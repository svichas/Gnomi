import { runEpisode } from './agent/loop.ts';
import { personaEnvironment } from './audience/locations.ts';
import { getPersonaSchema } from './profile/schema.ts';
import { buildReport } from './report/build.ts';
import { runReportModels } from './report/models.ts';
import { allowedHosts, productionDomain } from './safety.ts';
import type { BlobStore, BrowserPool, LlmGateway, ProjectStore, Recorder, SessionStore } from './seams.ts';
import type { EventPayloads, GnomiEvent, Persona, ProjectConfig, ProviderId, Report, RunConfig, Segment, SessionInfo } from './types.ts';

export interface RunDeps {
  store: ProjectStore;
  blobs: BlobStore;
  browsers: BrowserPool;
  llm: LlmGateway;
  record: Recorder;
  /** Where each role's storage state is loaded from; null when no session key has arrived. */
  sessions: SessionStore | null;
}

export interface RunHandle {
  run_id: string;
  /** Stops every persona: model calls in flight are cancelled (browser actions under way complete); the run ends with run.stopped(user). */
  stop(): void;
  /** Continues a persona paused by persona.blocked, with its role's session as it is now; ignored when it is not paused. */
  resume(persona_id: string): void;
  /** A provider answered 429: halve the concurrency, never below 2 (tech.md §9.5). */
  throttle(provider: ProviderId): void;
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

/** The segment a persona was sampled from; null for the built-in persona. */
export function segmentOf(persona: Persona, project: ProjectConfig): Segment | null {
  return project.audience?.segments.find((s) => s.id === persona.segment_id) ?? null;
}

/** The login a persona uses: its segment's role, or the project's for the built-in persona. */
export function roleOf(persona: Persona, project: ProjectConfig): string | null {
  return persona.segment_id === null ? project.role : (segmentOf(persona, project)?.role ?? null);
}

/** The run snapshot: the population in start order, the verified logins of the roles it uses, and the project's settings. */
export function newRunConfig(project: ProjectConfig, opts: { personas: Persona[]; sessions: SessionInfo[]; reset: boolean }): Omit<RunConfig, 'run_id'> {
  return {
    seed: project.audience?.seed ?? Math.floor(Math.random() * 2 ** 31),
    project: structuredClone({ ...project, persona_schema: getPersonaSchema(project.persona_schema) }),
    personas: structuredClone(opts.personas),
    sessions: structuredClone(opts.sessions),
    reset: opts.reset,
    pause_timeout_ms: 10 * 60_000,
    app_version: '0.0.0', // shortcut: fixed until packaging (M7) stamps a real version
  };
}

export function startRun(config: RunConfig, { store, blobs, browsers, llm, record, sessions }: RunDeps): RunHandle {
  const { run_id, project } = config;
  const { poi, settings } = project;
  const base = { run_id, round: 1, persona_id: null, poi_id: null };
  const hard = new AbortController(); // observed cost cap, stop(), tripwire or error: cancel model calls in flight
  const drain = new AbortController(); // every run-wide stop: no step or persona starts, paused personas wake
  let halted: EventPayloads['run.stopped'] | null = null;
  let concurrency = Math.max(1, settings.concurrency); // 0 would wait forever for a slot
  let lastThrottle = 0;
  const paused = new Map<string, () => void>();

  // The first reason to stop is the one reported, except that a tripwire always is.
  const halt = (stop: EventPayloads['run.stopped'], cancel: boolean) => {
    if (!halted || (stop.reason === 'tripwire' && halted.reason !== 'tripwire')) halted = stop;
    drain.abort();
    if (cancel) hard.abort();
  };

  // Spend comes from the log, read incrementally, so it counts every llm.call any gateway recorded, retries included.
  let spent = 0;
  let seen = 0;
  const spentUsd = () => {
    for (const e of store.events(run_id, { types: ['llm.call'], afterSeq: seen })) {
      seen = e.seq;
      if (e.type === 'llm.call') spent += e.payload.cost_usd;
    }
    return spent;
  };
  const checkRecordedBudget = () => {
    if (spentUsd() < settings.cost_budget_usd) return;
    halt({ reason: 'cost_budget', detail: `the $${settings.cost_budget_usd} recorded-cost budget was reached` }, true);
  };
  const budgetedLlm: LlmGateway = {
    call(req) {
      hard.signal.throwIfAborted();
      return llm.call({
        ...req,
        signal: req.signal ? AbortSignal.any([req.signal, hard.signal]) : hard.signal,
        onAttempt(attempt) {
          // The gateway has committed this attempt before notifying us; paid retries pass through here too.
          checkRecordedBudget();
          req.onAttempt?.(attempt);
        },
      });
    },
  };
  // This estimate can stop admission before the recorded cap. It is a precaution, not a bound on provider billing.
  // Reaching the recorded cap above cancels all model work; browser actions already dispatched still settle and log.
  let inFlight = 0;
  let stepsDone = 0;
  const beginStep = () => {
    if (drain.signal.aborted) return false;
    checkRecordedBudget();
    if (drain.signal.aborted) return false;
    const now = spentUsd();
    const perStep = stepsDone ? now / stepsDone : 0;
    if (now + (inFlight + 1) * perStep >= settings.cost_budget_usd) {
      halt({ reason: 'cost_budget', detail: `the next steps were projected to reach the $${settings.cost_budget_usd} budget` }, false);
      return false;
    }
    inFlight++;
    return true;
  };
  const endStep = () => {
    inFlight--;
    stepsDone++;
    checkRecordedBudget(); // Also protects callers supplying a custom gateway without per-attempt notifications.
  };

  const tripwire = (persona_id: string) => (kind: EventPayloads['containment.tripwire']['kind'], detail: string) => {
    record({ ...base, persona_id, poi_id: poi.id, type: 'containment.tripwire', payload: { kind, detail } });
    halt({ reason: 'tripwire', detail }, true);
  };

  // Loaded on every open, so a persona resumed after a re-recording logs in with the new session.
  const openPage = (persona: Persona, role: string | null) => async () => {
    const saved = role ? await sessions?.load(role) : null;
    hard.signal.throwIfAborted();
    if (role && !saved) throw new Error(`The recorded "${role}" login is missing. Record it again, then start a new run.`);
    return browsers.newPage({
      device: persona.device,
      ...personaEnvironment(persona),
      allowedHosts: allowedHosts(poi),
      blockedDomains: poi.production_domains,
      storageState: saved?.state ?? null,
      onBlockedRequest: ({ host, url, method, navigation }) => {
        record({ ...base, persona_id: persona.id, poi_id: poi.id, type: 'containment.blocked_request', payload: { host, url, method } });
        const production = productionDomain(host, poi.production_domains);
        if (navigation && production) tripwire(persona.id)('production_host', `${persona.name} tried to open ${url}, on the production domain ${production}.`);
      },
    });
  };

  const waitForResume = (persona_id: string) => () =>
    new Promise<'resumed' | 'timeout' | 'stopped'>((resolve) => {
      if (drain.signal.aborted) return resolve('stopped');
      const end = (how: 'resumed' | 'timeout' | 'stopped') => {
        clearTimeout(timer);
        drain.signal.removeEventListener('abort', onDrain);
        paused.delete(persona_id);
        resolve(how);
      };
      const onDrain = () => end('stopped');
      const timer = setTimeout(() => end('timeout'), config.pause_timeout_ms);
      drain.signal.addEventListener('abort', onDrain);
      paused.set(persona_id, () => end('resumed'));
    });

  const episode = async (persona: Persona) => {
    const role = roleOf(persona, project);
    const session = role ? (config.sessions.find((s) => s.role === role) ?? null) : null;
    if (role && !session) throw new Error(`No login for the "${role}" role was verified before the run.`);
    await runEpisode({
      config,
      persona,
      segment: segmentOf(persona, project),
      session,
      openPage: openPage(persona, role),
      llm: budgetedLlm,
      blobs,
      record,
      signal: hard.signal,
      beginStep,
      endStep,
      tripwire: tripwire(persona.id),
      waitForResume: waitForResume(persona.id),
    });
  };

  // At most `concurrency` personas in flight, each with its own page; a paused persona keeps its slot and its page.
  const schedule = async () => {
    const running = new Set<Promise<void>>();
    for (const persona of config.personas) {
      while (running.size >= concurrency && !drain.signal.aborted) await Promise.race(running);
      if (drain.signal.aborted) break;
      const tracked: Promise<void> = episode(persona)
        .catch((err) => halt(hard.signal.aborted ? { reason: 'user', detail: null } : { reason: 'error', detail: err instanceof Error ? err.message : String(err) }, true))
        .finally(() => running.delete(tracked));
      running.add(tracked);
    }
    await Promise.all(running);
  };

  const resetStaging = async (url: string | null) => {
    if (!url) throw new Error('This project has no reset hook to call.');
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(url, { method: 'POST', signal: AbortSignal.any([hard.signal, AbortSignal.timeout(10_000)]) });
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
    const clock = setTimeout(() => halt({ reason: 'wall_clock', detail: `the ${settings.wall_clock_budget_min}-minute limit was reached` }, false), settings.wall_clock_budget_min * 60_000);
    try {
      if (config.reset) await resetStaging(poi.reset_hook_url);
      for (const persona of config.personas) record({ ...base, persona_id: persona.id, type: 'persona.created', payload: { persona } });
      await schedule();
    } catch (err) {
      halt(hard.signal.aborted ? { reason: 'user', detail: null } : { reason: 'error', detail: err instanceof Error ? err.message : String(err) }, true);
    } finally {
      clearTimeout(clock);
    }
    // The judge and author run once the episodes are over, through the budgeted gateway: a stop or the cost cap skips them.
    await runReportModels({ config, llm: budgetedLlm, record, events: () => store.events(run_id) });

    const stopped = halted as EventPayloads['run.stopped'] | null;
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

  return {
    run_id,
    stop: () => halt({ reason: 'user', detail: null }, true),
    resume: (persona_id) => paused.get(persona_id)?.(),
    throttle(provider) {
      // shortcut: concurrency only ever drops; the raise to 32 when memory allows (tech.md §9.5) waits for a measured need.
      // One halving per burst: a dozen calls in flight all get the same 429 within a second or two.
      if (concurrency <= 2 || Date.now() - lastThrottle < 5_000) return;
      lastThrottle = Date.now();
      concurrency = Math.max(2, Math.floor(concurrency / 2));
      record({ ...base, type: 'run.concurrency_changed', payload: { concurrency, reason: `${provider} is rate-limiting requests` } });
    },
    done: execute(),
  };
}
