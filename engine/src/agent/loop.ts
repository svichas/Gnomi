import { InvalidOutputError } from '../llm/gateway.ts';
import { personaEnvironment } from '../audience/locations.ts';
import { sameOpinion } from '../opinion/index.ts';
import { DEFAULT_SIGNALS, detectSignals, isSubmit, type Step } from '../signals/index.ts';
import type { BlobStore, LlmGateway, PageDriver, Recorder } from '../seams.ts';
import type { Action, ActionOutcome, EventPayloads, EventType, NewEvent, Opinion, Persona, RunConfig, Segment, SessionInfo, WebPoi } from '../types.ts';
import { loginPoi } from '../poi/pois.ts';
import { stepSchema, systemPrompt, userParts, type StepMemory, type StepOutput } from './prompt.ts';

export type EpisodeEnd = 'done' | 'abandoned' | 'budget_exceeded' | 'repeated_failure' | 'blocked' | 'stopped';

/** Steps a persona gets before giving up, from patience (tech.md §6.4); the engine enforces it, the prompt only mentions it. */
export function stepBudget(persona: Persona): number {
  return [12, 20, 30, 45, 60][persona.patience - 1] ?? 30;
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
  /** A fresh page under the web POI's containment with the role's current session; called again after a resume, as the login was likely re-recorded. */
  openPage: (poi: WebPoi) => Promise<PageDriver>;
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
   * Social rounds: after every `steps` steps of the persona (counted across its POIs) the episode waits, page and memory intact, for
   * its next usage slice. next() resolves with the persona's opinion of this POI as the social phase left it, or null when the run
   * ended in between. Absent: one straight run.
   */
  slice?: { steps: number; next: () => Promise<{ opinion: Opinion | null } | null> };
}

/**
 * One persona's episode on a web POI: snapshot → screenshot → model → execute → record → inspect, until done, abandon or an
 * engine-enforced stop. Budgets live here, not in the prompt, because asking simulated users to give up barely
 * changes their behaviour (tech.md §2.4, §6.7).
 */
export async function runEpisode(poi: WebPoi, deps: EpisodeDeps): Promise<EpisodeEnd> {
  const { config, persona, segment, session, llm, blobs, record, signal, stepsBefore } = deps;
  const { run_id } = config;
  const { settings } = config.project;
  const poi_id = poi.id;
  const step_budget = deps.budget;
  const emit = <K extends EventType>(type: K, payload: EventPayloads[K]) =>
    record({ run_id, round: deps.round(), persona_id: persona.id, poi_id, type, payload } as NewEvent);
  const system = systemPrompt(persona, config.project, segment, step_budget, poi);
  const schema = stepSchema(persona);
  const memory: StepMemory[] = [];
  const history: Step[] = []; // every recorded step, for the signal detectors
  const thresholds = config.signals ?? DEFAULT_SIGNALS;
  let opinion: Opinion | null = null;
  let failKey = '';
  let failStreak = 0;

  // The recorded start page belongs to the POI the login was recorded on; the others start at their own.
  const startUrl = session && loginPoi(config.project.pois)?.id === poi.id ? session.start_url : poi.start_url;
  let lastGoodUrl = startUrl;
  let page = await deps.openPage(poi);

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
      if (signal.aborted) return 'stopped';
      page = await deps.openPage(poi);
      if (signal.aborted) return 'stopped';
      await page.goto(lastGoodUrl);
      url = lastGoodUrl;
      emit('persona.resumed', { step_no });
    }
  };

  // Looks at the page and asks the model what the persona does. output is null when the model twice failed to answer validly;
  // the whole result is null when stop() cancelled the call.
  const look = async (step_no: number) => {
    const snapshot = await page.snapshot();
    const shot = await page.screenshot();
    const screenshot = `runs/${run_id}/shots/${persona.id}-${String(step_no).padStart(4, '0')}.jpg`;
    await blobs.put(screenshot, shot);
    const user = userParts({ persona, stepNo: step_no - stepsBefore, stepBudget: step_budget, memory, opinion, page: snapshot, screenshot: settings.screenshots ? shot : null });
    if (signal.aborted) return null;
    try {
      const { object } = await llm.call({ role: 'navigator', model: settings.routing.navigator, run_id, persona_id: persona.id, round: deps.round(), system, user, schema, signal });
      return { snapshot, screenshot, output: object as StepOutput | null };
    } catch (err) {
      if (signal.aborted) return null;
      // A second invalid output is a failed step, not a crash (tech.md §10.6); any other model error ends the run.
      if (!(err instanceof InvalidOutputError)) throw err;
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
      if (deps.slice && step_no > 1 && (step_no - 1) % deps.slice.steps === 0) {
        const next = await deps.slice.next();
        if (!next) return 'stopped';
        opinion = next.opinion;
      }
      if (!deps.beginStep()) return 'stopped';
      const started = Date.now();
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
      const recordedStep = emit('persona.step', { step_no, action, target, result, thought, feeling: output?.feeling ?? 0, snapshot_hash: snapshot.hash, screenshot, duration_ms: Date.now() - started });
      // Objective signals right after their step (tech.md §8.1); a submit needs one more look to see what it made appear.
      const step: Step = { step_no, action, target, result, snapshot_hash: snapshot.hash };
      const afterSubmit = isSubmit(step) ? await page.snapshot().then((s) => s.text, () => null) : null;
      for (const s of detectSignals({ history, step, device: persona.device, errors: page.errors(), before: snapshot.text, after: afterSubmit, thresholds })) emit(s.type, s.payload);
      history.push(step);
      if (output?.opinion && !sameOpinion(opinion, output.opinion)) {
        const after = structuredClone(output.opinion);
        emit('persona.opinion_changed', { poi_id, before: opinion, after, cause: { step_ids: [recordedStep.seq], post_ids: [] } });
        opinion = structuredClone(after);
      }
      const friction = output?.friction ?? null;
      if (friction) emit('persona.friction_reported', { step_no, ...friction, where: { url: snapshot.url, ref: action.ref } });

      if (action.type === 'done') {
        emit('persona.goal_done', { step_no, summary: action.text ?? '' });
        return 'done';
      }
      if (action.type === 'abandon') {
        emit('persona.abandoned', { step_no, reason: action.text ?? '' });
        return 'abandoned';
      }
      // A step the model failed to answer is not something the persona did, so it stays out of the persona's memory.
      if (output) memory.push({ step_no: step_no - stepsBefore, action, target, result, thought, friction: friction?.what ?? null, text });

      const next = await inspect(step_no, result.url_after);
      if (next !== 'go') return next;

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
