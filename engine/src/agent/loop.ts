import { InvalidOutputError } from '../llm/gateway.ts';
import type { BlobStore, LlmGateway, PageDriver, Recorder } from '../seams.ts';
import type { Action, ActionOutcome, EventPayloads, EventType, NewEvent, RunConfig } from '../types.ts';
import { stepSchema, systemPrompt, userParts, type StepMemory, type StepOutput } from './prompt.ts';

export type EpisodeEnd = 'done' | 'abandoned' | 'budget_exceeded' | 'repeated_failure' | 'blocked' | 'stopped' | 'cost_budget';

export interface EpisodeDeps {
  config: RunConfig;
  /** A fresh page under containment with the role's current session; called again after a resume, as the login was likely re-recorded. */
  openPage: () => Promise<PageDriver>;
  llm: LlmGateway;
  blobs: BlobStore;
  record: Recorder;
  /** Aborted by stop() or a tripwire: the in-flight model call is cancelled and no further step starts. */
  signal: AbortSignal;
  /** Spend so far, read from the log, so the llm.call events of any gateway count. */
  spentUsd: () => number;
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
  const { config, llm, blobs, record, signal, spentUsd } = deps;
  const { run_id, persona, step_budget } = config;
  const poi_id = config.project.poi.id;
  const emit = <K extends EventType>(type: K, payload: EventPayloads[K]) =>
    record({ run_id, round: 1, persona_id: persona.id, poi_id, type, payload } as NewEvent);
  const system = systemPrompt(persona, config.project, step_budget);
  const schema = stepSchema(persona);
  const memory: StepMemory[] = [];
  let lastStepCost = 0;
  let failKey = '';
  let failStreak = 0;

  const startUrl = config.session?.start_url ?? config.project.poi.start_url;
  let lastGoodUrl = startUrl;
  let page = await deps.openPage();

  // The page checks of tech.md §9.1/§9.3 after every load. A blocked persona pauses until the user resumes her, then
  // continues on a fresh page at the last unblocked URL, memory intact. 'go' means carry on.
  const inspect = async (step_no: number, url: string): Promise<'go' | EpisodeEnd> => {
    for (;;) {
      const flags = await page.inspect();
      if (flags.live_key) {
        deps.tripwire('live_payment_key', `A live payment key (${flags.live_key}…) is on ${url}, so this looks like production.`);
        return 'stopped';
      }
      const reason = flags.challenge ? 'captcha' : flags.login && config.session ? 'session_expired' : null;
      if (!reason) {
        lastGoodUrl = url;
        return 'go';
      }
      const detail =
        reason === 'captcha'
          ? `A ${flags.challenge} challenge is showing. Gnomi never solves challenges: turn it off on staging or use the provider's test keys, then resume.`
          : `The app asked to log in again. Re-record the "${config.session?.role}" login, then resume.`;
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

  try {
    await page.goto(startUrl);
    emit('persona.episode_started', { poi_id, device: persona.device, start_url: startUrl });
    const first = await inspect(0, startUrl);
    if (first !== 'go') return first;

    for (let step_no = 1; step_no <= step_budget; step_no++) {
      if (signal.aborted) return 'stopped';
      const spent = spentUsd();
      // Projected from the previous step, so the cap holds before a call rather than after it (tech.md §10.5).
      if (spent + lastStepCost > config.cost_budget_usd) return 'cost_budget';

      const started = Date.now();
      const snapshot = await page.snapshot();
      const shot = await page.screenshot();
      const screenshot = `runs/${run_id}/shots/${persona.id}-${String(step_no).padStart(4, '0')}.jpg`;
      await blobs.put(screenshot, shot);

      let output: StepOutput | null = null;
      try {
        const user = userParts({ persona, stepNo: step_no, stepBudget: step_budget, memory, page: snapshot, screenshot: config.screenshots ? shot : null });
        ({ object: output } = await llm.call({ role: 'navigator', model: config.model.navigator, run_id, persona_id: persona.id, round: 1, system, user, schema, signal }));
      } catch (err) {
        if (signal.aborted) return 'stopped';
        // A second invalid output is a failed step, not a crash (tech.md §10.6); any other model error ends the run.
        if (!(err instanceof InvalidOutputError)) throw err;
      }
      lastStepCost = spentUsd() - spent;

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
      // A step the model failed to answer is not something the persona did, so it stays out of her memory.
      if (output) memory.push({ step_no, action, target, result, thought, friction: friction?.what ?? null, text });

      const next = await inspect(step_no, result.url_after);
      if (next !== 'go') return next;

      if (result.ok) failStreak = 0;
      else {
        const key = JSON.stringify([action, result.error]);
        failStreak = key === failKey ? failStreak + 1 : 1;
        failKey = key;
        // A real user stops hammering a control that keeps failing. The engine ends the episode with a signal, kept
        // apart from persona.abandoned so abandonment counts only her own choices (tech.md §6.7).
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
