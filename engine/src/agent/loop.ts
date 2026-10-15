import { InvalidOutputError } from '../llm/gateway.ts';
import type { BlobStore, LlmGateway, PageDriver, Recorder } from '../seams.ts';
import type { Action, ActionOutcome, EventPayloads, EventType, NewEvent, Persona, RunConfig, Segment, SessionInfo } from '../types.ts';
import { stepSchema, systemPrompt, userParts, type StepMemory, type StepOutput } from './prompt.ts';

export type EpisodeEnd = 'done' | 'abandoned' | 'budget_exceeded' | 'repeated_failure' | 'blocked' | 'stopped';

/** Steps a persona gets before giving up, from patience (tech.md §6.4); the engine enforces it, the prompt only mentions it. */
export function stepBudget(persona: Persona): number {
  return [12, 20, 30, 45, 60][persona.patience - 1] ?? 30;
}

export interface EpisodeDeps {
  config: RunConfig;
  persona: Persona;
  segment: Segment | null; // its segment, for the goal override and context; null for the built-in persona
  session: SessionInfo | null; // its role's login, which sets the start page and makes a login page a block
  /** A fresh page under containment with the role's current session; called again after a resume, as the login was likely re-recorded. */
  openPage: () => Promise<PageDriver>;
  llm: LlmGateway;
  blobs: BlobStore;
  record: Recorder;
  /** Aborted by stop() or a tripwire: the in-flight model call is cancelled. */
  signal: AbortSignal;
  /** Asks to start a step; false once a run-wide stop (user, tripwire, cost or wall clock) means no new step may begin. */
  beginStep: () => boolean;
  /** The step's model call is over, so its cost is in the log and no longer projected. */
  endStep: () => void;
  /** Records containment.tripwire and halts the run. */
  tripwire: (kind: EventPayloads['containment.tripwire']['kind'], detail: string) => void;
  /** Waits for RunHandle.resume, at most the pause timeout; stop() ends the wait. */
  waitForResume: () => Promise<'resumed' | 'timeout' | 'stopped'>;
}

/**
 * One persona's episode on the POI: snapshot → screenshot → model → execute → record → inspect, until done, abandon or an
 * engine-enforced stop. Budgets live here, not in the prompt, because asking simulated users to give up barely
 * changes their behaviour (tech.md §2.4, §6.7).
 */
export async function runEpisode(deps: EpisodeDeps): Promise<EpisodeEnd> {
  const { config, persona, segment, session, llm, blobs, record, signal } = deps;
  const { run_id } = config;
  const { settings } = config.project;
  const poi_id = config.project.poi.id;
  const step_budget = stepBudget(persona);
  const emit = <K extends EventType>(type: K, payload: EventPayloads[K]) =>
    record({ run_id, round: 1, persona_id: persona.id, poi_id, type, payload } as NewEvent);
  const system = systemPrompt(persona, config.project, segment, step_budget);
  const schema = stepSchema(persona);
  const memory: StepMemory[] = [];
  let failKey = '';
  let failStreak = 0;

  const startUrl = session?.start_url ?? config.project.poi.start_url;
  let lastGoodUrl = startUrl;
  let page = await deps.openPage();

  // The page checks of tech.md §9.1/§9.3 after every load. A blocked persona pauses until the user resumes it, then
  // continues on a fresh page at the last unblocked URL, memory intact. 'go' means carry on.
  const inspect = async (step_no: number, url: string): Promise<'go' | EpisodeEnd> => {
    for (;;) {
      const flags = await page.inspect();
      if (flags.live_key) {
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
      page = await deps.openPage();
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
    const user = userParts({ persona, stepNo: step_no, stepBudget: step_budget, memory, page: snapshot, screenshot: settings.screenshots ? shot : null });
    try {
      const { object } = await llm.call({ role: 'navigator', model: settings.routing.navigator, run_id, persona_id: persona.id, round: 1, system, user, schema, signal });
      return { snapshot, screenshot, output: object as StepOutput | null };
    } catch (err) {
      if (signal.aborted) return null;
      // A second invalid output is a failed step, not a crash (tech.md §10.6); any other model error ends the run.
      if (!(err instanceof InvalidOutputError)) throw err;
      return { snapshot, screenshot, output: null };
    }
  };

  try {
    await page.goto(startUrl);
    emit('persona.episode_started', { poi_id, device: persona.device, start_url: startUrl });
    const first = await inspect(0, startUrl);
    if (first !== 'go') return first;

    for (let step_no = 1; step_no <= step_budget; step_no++) {
      if (!deps.beginStep()) return 'stopped';
      const started = Date.now();
      let looked: Awaited<ReturnType<typeof look>>;
      try {
        looked = await look(step_no);
      } finally {
        deps.endStep();
      }
      if (!looked) return 'stopped';
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
      emit('persona.step', { step_no, action, target, result, thought, feeling: output?.feeling ?? 0, snapshot_hash: snapshot.hash, screenshot, duration_ms: Date.now() - started });
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
      if (output) memory.push({ step_no, action, target, result, thought, friction: friction?.what ?? null, text });

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
    emit('signal.budget_exceeded', { step_no: step_budget, budget: step_budget });
    return 'budget_exceeded';
  } finally {
    await page.close().catch(() => {});
  }
}
