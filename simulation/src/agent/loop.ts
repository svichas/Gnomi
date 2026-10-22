import { InvalidOutputError } from '../llm/gateway.ts';
import { personaEnvironment } from '../audience/locations.ts';
import { sameOpinion } from '../opinion/index.ts';
import { DEFAULT_SIGNALS, detectSignals, failedAction, isSubmit, type Step } from '../signals/index.ts';
import { normaliseText } from '../report/friction.ts';
import type { BlobStore, LlmGateway, PageDriver, Recorder, StorageState } from '../seams.ts';
import type { Action, ActionOutcome, ActionTarget, EventPayloads, EventType, NewEvent, Opinion, Persona, RunConfig, Segment, SessionInfo, WebPoi } from '../types.ts';
import { loginPoi } from '../poi/pois.ts';
import { readsImages } from '../settings.ts';
import { stepSchema, systemPrompt, userParts, type HeardPost, type StepMemory, type StepOutput } from './prompt.ts';

// model_failed: the model gave no valid answer three steps running; the engine ends it, and it says nothing about the product.
export type EpisodeEnd = 'done' | 'abandoned' | 'budget_exceeded' | 'repeated_failure' | 'model_failed' | 'blocked' | 'stopped';

/** Steps a persona gets before giving up, from patience (tech.md §6.4); the engine enforces it, and the prompt does not show it. */
export function stepBudget(persona: Persona): number {
  return [12, 20, 30, 45, 60][persona.patience - 1] ?? 30;
}

/** The role and name of the element with this ref in a snapshot (browser/prune.ts lines), or null when it is not there. */
export function targetIn(snapshot: string, ref: string): ActionTarget | null {
  const line = snapshot.split('\n').find((l) => l.includes(`[ref=${ref}]`));
  const m = line && /- (\S+) "((?:[^"\\]|\\.)*)"/.exec(line);
  return m ? { role: m[1], name: m[2], box: null } : null;
}

/** What a POI runner (poi/index.ts) gets for one persona's episode on one POI. */
export interface EpisodeDeps {
  config: RunConfig;
  persona: Persona;
  segment: Segment | null; // its segment, for the goal override and context; null for the built-in persona
  session: SessionInfo | null; // its role's login, which makes a login page a block and, on the login POI, sets the start page
  /** This episode's step budget: the persona's patience budget as the POI's runner scales it (tech.md §6.4). */
  budget: number;
  /** Steps the persona took on its earlier POIs: step numbers run on across a persona's POIs, so each names one step of the run. */
  stepsBefore: number;
  /** The persona's opinion of this POI when the episode starts, from an earlier social phase; null or absent when it has none. */
  opinion?: Opinion | null;
  /**
   * A fresh page under the web POI's containment with the role's current session; called again after a resume, as the login was likely
   * re-recorded. Between slices it gets the `state` the persona's last page left with instead.
   */
  openPage: (poi: WebPoi, state?: StorageState) => Promise<PageDriver>;
  llm: LlmGateway;
  blobs: BlobStore;
  record: Recorder;
  /** Aborted by the recorded cost cap, stop(), a tripwire or an error; in-flight model calls are cancelled. */
  signal: AbortSignal;
  /** Asks to start a step; false once a run-wide stop (user, tripwire, cost or wall clock) means no new step may begin. */
  beginStep: () => boolean;
  /** The step's model call is over, so its cost is in the log and no longer projected. */
  endStep: () => void;
  /** Records containment.tripwire and halts the run. */
  tripwire: (kind: EventPayloads['containment.tripwire']['kind'], detail: string) => void;
  /** Waits for RunHandle.resume, at most the pause timeout; stop() ends the wait. */
  waitForResume: () => Promise<'resumed' | 'timeout' | 'stopped'>;
  /** The round the run is in, for every event and model call (tech.md §6.4). */
  round: () => number;
  /**
   * Social rounds: after every `steps` steps of the persona (counted across its POIs) the episode waits, memory intact, for its next
   * usage slice; a web episode closes its page meanwhile. next() resolves with the persona's opinion of this POI as the social phase left it and the posts it read
   * there (`heard`, for the next step's prompt), or null when the run ended in between. Absent: one straight run.
   */
  slice?: { steps: number; next: () => Promise<{ opinion: Opinion | null; heard?: HeardPost[] } | null> };
}

/** What every POI runner records the same way, each event stamped with the run, round, persona and this POI. */
export function episodeLog(deps: EpisodeDeps, poi_id: string) {
  const emit = <K extends EventType>(type: K, payload: EventPayloads[K]) =>
    deps.record({ run_id: deps.config.run_id, round: deps.round(), persona_id: deps.persona.id, poi_id, type, payload } as NewEvent);
  return {
    emit,
    /** The opinion after the step recorded as `seq`: `after`, recorded as a change, when the step gave one that differs from `before`. */
    opinion(before: Opinion | null, after: Opinion | null | undefined, seq: number): Opinion | null {
      if (!after || sameOpinion(before, after)) return before;
      emit('persona.opinion_changed', { poi_id, before, after: structuredClone(after), cause: { step_ids: [seq], post_ids: [] } });
      return structuredClone(after);
    },
    /** Records the persona's own end when the step's action is done or abandon; null when the episode goes on. */
    ended(step_no: number, action: Action): 'done' | 'abandoned' | null {
      if (action.type === 'done') {
        emit('persona.goal_done', { step_no, summary: action.text ?? '' });
        return 'done';
      }
      if (action.type === 'abandon') {
        emit('persona.abandoned', { step_no, reason: action.text ?? '' });
        return 'abandoned';
      }
      return null;
    },
  };
}

/** Whether this step starts a new usage slice, so the episode first waits for it (EpisodeDeps.slice). */
export const atSliceEnd = (deps: EpisodeDeps, step_no: number) => !!deps.slice && step_no > 1 && (step_no - 1) % deps.slice.steps === 0;

/**
 * One persona's episode on a web POI: snapshot → screenshot → model → execute → record → inspect, until done, abandon or an
 * engine-enforced stop. Budgets live here, not in the prompt, because asking simulated users to give up barely
 * changes their behaviour (tech.md §2.4, §6.7).
 */
export async function runEpisode(poi: WebPoi, deps: EpisodeDeps): Promise<EpisodeEnd> {
  const { config, persona, segment, session, llm, blobs, signal, stepsBefore } = deps;
  const { run_id } = config;
  const { settings } = config.project;
  const poi_id = poi.id;
  const step_budget = deps.budget;
  const log = episodeLog(deps, poi_id);
  const { emit } = log;
  const system = systemPrompt(persona, config.project, segment, poi);
  const schema = stepSchema(persona);
  const memory: StepMemory[] = [];
  const history: Step[] = []; // every recorded step, for the signal detectors
  const thresholds = config.signals ?? DEFAULT_SIGNALS;
  let opinion: Opinion | null = deps.opinion ?? null;
  let heard: HeardPost[] = []; // the last feed, for the next step only
  let failKey = '';
  let failStreak = 0;
  let invalidStreak = 0;
  const reported = new Set<string>(); // page and normalised text of each friction already recorded this episode
  // The gateway strips images for DeepSeek (llm/gateway.ts), so the prompt must not say there is a screenshot.
  const sendShots = settings.screenshots && readsImages(settings.routing.navigator);

  // The recorded start page belongs to the POI the login was recorded on; the others start at their own.
  const startUrl = session && !config.project.comparison && loginPoi(config.project.pois)?.id === poi.id ? session.start_url : poi.start_url;
  let lastGoodUrl = startUrl;
  let page = await deps.openPage(poi);
  // A fresh page at the last unblocked URL, logged in with `state` or else the role's current recorded session; false once the run is stopping.
  const reopen = async (state?: StorageState) => {
    if (signal.aborted) return false;
    page = await deps.openPage(poi, state);
    if (signal.aborted) return false;
    await page.goto(lastGoodUrl);
    page.errors(); // the reload's own errors are not something the persona did
    return true;
  };

  // The page checks of tech.md §9.1/§9.3 after every load. A blocked persona pauses until the user resumes it, then
  // continues on a fresh page at the last unblocked URL, memory intact. 'go' means carry on.
  const inspect = async (step_no: number, url: string): Promise<'go' | EpisodeEnd> => {
    for (;;) {
      if (signal.aborted) return 'stopped';
      const flags = await page.inspect();
      // A live key means production, which a competitor's site is: an observe-only POI writes nothing there.
      if (flags.live_key && poi.mode === 'full') {
        deps.tripwire('live_payment_key', `A live payment key (${flags.live_key}…) is on ${url}, so this looks like production.`);
        return 'stopped';
      }
      const reason = flags.challenge ? 'captcha' : flags.login && session ? 'session_expired' : null;
      if (!reason) {
        lastGoodUrl = url;
        return 'go';
      }
      const detail =
        reason === 'captcha'
          ? `A ${flags.challenge} challenge is showing. Gnomi never solves challenges: turn it off on staging or use the provider's test keys, then resume.`
          : `The app asked to log in again. Re-record the "${session?.role}" login, then resume.`;
      const waiting = deps.waitForResume(); // listening before the event goes out, so a prompt resume is not lost
      emit('persona.blocked', { step_no, reason, detail });
      const wake = await waiting;
      if (wake !== 'resumed') return wake === 'timeout' ? 'blocked' : 'stopped';
      await page.close().catch(() => {});
      if (!(await reopen())) return 'stopped';
      url = lastGoodUrl;
      emit('persona.resumed', { step_no });
    }
  };

  // Looks at the page and asks the model what the persona does. output is null when the model twice failed to answer validly;
  // the whole result is null when stop() cancelled the call.
  const look = async (step_no: number) => {
    // A redirect that lands after act()'s settle cap destroys the page's context under a read: the new page is read once more.
    const read = async () => ({ snapshot: await page.snapshot(), shot: await page.screenshot() });
    const { snapshot, shot } = await read().catch((err: unknown) => (String(err).includes('Execution context was destroyed') ? read() : Promise.reject(err)));
    const screenshot = `runs/${run_id}/shots/${persona.id}-${String(step_no).padStart(4, '0')}.jpg`;
    await blobs.put(screenshot, shot);
    const user = userParts({ persona, stepNo: step_no - stepsBefore, memory, opinion, heard, page: snapshot, screenshot: sendShots ? shot : null });
    heard = [];
    if (signal.aborted) return null;
    try {
      const { object } = await llm.call({ role: 'navigator', model: settings.routing.navigator, run_id, persona_id: persona.id, round: deps.round(), purpose: 'step', poi_id, system, user, schema, signal });
      return { snapshot, screenshot, output: object as StepOutput | null };
    } catch (err) {
      if (signal.aborted) return null;
      // A second invalid output or a timed-out call is a failed step, not a crash (tech.md §10.6); any other model error ends the run.
      if (!(err instanceof InvalidOutputError) && !(err instanceof Error && err.name === 'TimeoutError')) throw err;
      return { snapshot, screenshot, output: null };
    }
  };

  try {
    if (signal.aborted) return 'stopped';
    await page.goto(startUrl);
    emit('persona.episode_started', { poi_id, device: persona.device, start_url: startUrl, ...personaEnvironment(persona) });
    const first = await inspect(stepsBefore, startUrl);
    if (first !== 'go') return first;

    const last = stepsBefore + step_budget;
    for (let step_no = stepsBefore + 1; step_no <= last; step_no++) {
      if (atSliceEnd(deps, step_no)) {
        // A waiting persona holds no page, so open pages stay within the concurrency. Its cookies and local storage come back with it;
        // shortcut: unsaved input and session storage are lost between slices; keep the page open if a flow needs them.
        const kept = await page.storageState?.().catch(() => undefined);
        await page.close().catch(() => {});
        const next = await deps.slice!.next();
        if (!next) return 'stopped';
        opinion = next.opinion;
        heard = next.heard ?? [];
        if (!(await reopen(kept))) return 'stopped';
        const back = await inspect(step_no - 1, lastGoodUrl);
        if (back !== 'go') return back;
      }
      if (!deps.beginStep()) return 'stopped';
      const started = Date.now();
      const heard_post_ids = heard.map((h) => h.post_id); // look() hands them to the prompt and clears them
      let looked: Awaited<ReturnType<typeof look>>;
      try {
        looked = await look(step_no);
      } finally {
        deps.endStep();
      }
      // A provider may return successfully after cancellation. Its usage stays logged, but the answer must not act.
      if (!looked || signal.aborted) return 'stopped';
      const { snapshot, screenshot, output } = looked;

      const action: Action = output?.action ?? { type: 'wait', ref: null, text: null };
      const stay = { url_before: snapshot.url, url_after: snapshot.url, dom_changed: false, target: null, text: null };
      const outcome: ActionOutcome = !output
        ? { ok: false, error: 'invalid_output', ...stay }
        : action.type === 'done' || action.type === 'abandon'
          ? { ok: true, error: null, ...stay }
          : await page.act(action);
      const { target, text, ...result } = outcome;
      const thought = output?.thought ?? '';
      const recordedStep = emit('persona.step', { step_no, action, target, result, thought, feeling: output?.feeling ?? 0, snapshot_hash: snapshot.hash, screenshot, duration_ms: Date.now() - started, heard_post_ids });
      // Objective signals right after their step (tech.md §8.1); a submit needs one more look to see what it made appear.
      const step: Step = { step_no, action, target, result, snapshot_hash: snapshot.hash };
      const afterSubmit = isSubmit(step) ? await page.snapshot().then((s) => s.text, () => null) : null;
      for (const s of detectSignals({ history, step, device: persona.device, errors: page.errors(), before: snapshot.text, after: afterSubmit, thresholds })) emit(s.type, s.payload);
      history.push(step);
      opinion = log.opinion(opinion, output?.opinion, recordedStep.seq);
      const friction = output?.friction ?? null;
      const said = friction && JSON.stringify([snapshot.url, normaliseText(friction.what)]);
      // The same complaint again on the same page is one friction, not one per step; the step keeps its thought and feeling.
      if (friction && said && !reported.has(said)) {
        reported.add(said);
        const { about_ref, ...report } = friction;
        // What it is about: the element the persona names, else the last action when it failed or did nothing, else the next action's.
        const prev = history.at(-2);
        const about: { ref: string | null; target: ActionTarget | null } = about_ref ? { ref: about_ref, target: targetIn(snapshot.text, about_ref) }
          : prev && (!prev.result.ok || failedAction(prev, history.at(-3))) ? { ref: prev.action.ref, target: prev.target } : { ref: action.ref, target: null };
        emit('persona.friction_reported', { step_no, ...report, where: { url: snapshot.url, ref: about.ref }, heard_post_ids, ...(about.target && { about: about.target }) });
      }

      const own = log.ended(step_no, action);
      if (own) return own;
      // A step the model failed to answer is not something the persona did, so it stays out of the persona's memory.
      if (output) memory.push({ step_no: step_no - stepsBefore, action, target, result, thought, friction: friction?.what ?? null, text });

      const next = await inspect(step_no, result.url_after);
      if (next !== 'go') return next;

      // A model that keeps failing to answer is not the product failing: it ends apart from repeated_failure, with no survey.
      invalidStreak = output ? 0 : invalidStreak + 1;
      if (invalidStreak === 3) {
        emit('signal.repeated_failure', { step_no, action: action.type, error: 'invalid_output' });
        return 'model_failed';
      }
      if (!output) continue; // neither counts towards nor breaks a run of failed actions
      if (result.ok) failStreak = 0;
      else {
        const key = JSON.stringify([action, result.error]);
        failStreak = key === failKey ? failStreak + 1 : 1;
        failKey = key;
        // A real user stops hammering a control that keeps failing. The engine ends the episode with a signal, kept
        // apart from persona.abandoned so abandonment counts only the persona's own choices (tech.md §6.7).
        if (failStreak === 3) {
          emit('signal.repeated_failure', { step_no, action: action.type, error: result.error ?? 'unknown' });
          return 'repeated_failure';
        }
      }
    }
    emit('signal.budget_exceeded', { step_no: last, budget: step_budget });
    return 'budget_exceeded';
  } finally {
    await page.close().catch(() => {});
  }
}
