import { createComparisonRuntime, comparisonSession, ComparisonEnvironmentError } from './comparison/runtime.ts';
import { effectiveComparisonPois, validateComparison } from './comparison/config.ts';
import type { ComparisonTarget, ComparisonTask } from './comparison/types.ts';
import { askBuyer } from './agent/buyer.ts';
import type { EpisodeEnd } from './agent/loop.ts';
import { HEARD_POSTS, socialParts, socialSchema, socialSystemPrompt, surveyedName, surveyItems, surveyParts, surveySchema, surveySystemPrompt, type HeardPost } from './agent/prompt.ts';
import { personaEnvironment } from './audience/locations.ts';
import { fnv1a, mulberry32 } from './audience/sample.ts';
import { InvalidOutputError } from './llm/gateway.ts';
import { costUsd, isPriced } from './llm/prices.ts';
import { foldOpinions, sameOpinion, type CurrentOpinion } from './opinion/index.ts';
import { comparisonFor } from './poi/compare.ts';
import { poiBudget, runnerFor } from './poi/index.ts';
import { logsIn, poisFor, webPois } from './poi/pois.ts';
import { getPersonaSchema } from './profile/schema.ts';
import { observeOptions } from './browser/observe.ts';
import { buildReport } from './report/build.ts';
import { runReportModels } from './report/models.ts';
import { allowedHosts, productionDomain } from './safety.ts';
import { socialRounds } from './settings.ts';
import { DEFAULT_SIGNALS } from './signals/index.ts';
import { readBoard, selectFeed, type Board, type FeedPost } from './social/feed.ts';
import { networkGraph } from './social/graph.ts';
import type { BlobStore, BrowserPool, LlmGateway, ProjectStore, Recorder, SessionStore } from './seams.ts';

import type { EventPayloads, GnomiEvent, Opinion, Persona, Poi, ProjectConfig, ProviderId, Report, RunConfig, Segment, SessionInfo, WebPoi } from './types.ts';

/** The run-scoped part of the project store: log/ implements the whole interface, the run needs only this. */
export type RunStore = Pick<ProjectStore, 'events' | 'append' | 'saveTranscript' | 'finishRun'>;

export interface RunDeps {
  store: RunStore;
  blobs: BlobStore;
  browsers: Pick<BrowserPool, 'newPage'>;
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

export function createRecorder(store: RunStore, onEvent: (event: GnomiEvent) => void): Recorder {
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

/** The login a persona uses: its segment's role, or the project's for the built-in persona; none when it opens no web app in full mode. */
export function roleOf(persona: Persona, project: ProjectConfig): string | null {
  const segment = segmentOf(persona, project);
  if (!logsIn(project.pois, segment)) return null;
  return persona.segment_id === null ? project.role : (segment?.role ?? null);
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
    signals: { ...DEFAULT_SIGNALS },
  };
}

export function startRun(config: RunConfig, { store, blobs, browsers, llm, record, sessions }: RunDeps): RunHandle {
  const { run_id, project } = config;
  const { settings } = project;
  const comparisonIssues = validateComparison(project);
  if (comparisonIssues.length) throw new Error(comparisonIssues.join(' '));
  const base = { run_id, round: 1, persona_id: null, poi_id: null }; // round moves on with social rounds
  // Each persona uses the POIs its segment is eligible for, one after another, in the project's order (tech.md §7).
  const assigned = new Map(config.personas.map((p) => [p.id, poisFor(project.pois, segmentOf(p, project))]));
  // Social rounds (tech.md §6.4): R usage slices, each followed by a social phase. 0 runs one straight slice, as before M4.
  const rounds = project.comparison ? 0 : socialRounds(settings, project.audience);
  const follows = rounds ? networkGraph(settings.network_policy ?? 'legacy', config.personas, config.seed) : null;
  const hard = new AbortController(); // observed cost cap, stop(), tripwire or error: cancel model calls in flight
  const drain = new AbortController(); // every run-wide stop: no step or persona starts, paused personas wake
  let halted: EventPayloads['run.stopped'] | null = null;
  let concurrency = Math.max(1, settings.concurrency); // 0 would wait forever for a slot
  let lastThrottle = 0;
  const paused = new Map<string, () => void>();

  // The first reason to stop is the one reported, except that a tripwire always is; any other reason joins its detail.
  const said = (stop: EventPayloads['run.stopped']) => (stop.detail ? `${stop.reason}: ${stop.detail}` : stop.reason);
  const halt = (stop: EventPayloads['run.stopped'], cancel: boolean) => {
    if (!halted) halted = stop;
    // A call cancelled by an earlier hard stop surfaces as a user stop: that is the earlier stop, not a new reason.
    else if (said(stop) !== said(halted) && !(stop.reason === 'user' && hard.signal.aborted)) {
      const [kept, extra] = stop.reason === 'tripwire' && halted.reason !== 'tripwire' ? [stop, `after ${said(halted)}`] : [halted, `then ${said(stop)}`];
      if (!kept.detail?.includes(extra)) halted = { ...kept, detail: kept.detail ? `${kept.detail}; ${extra}` : extra };
    }
    drain.abort();
    if (cancel) hard.abort();
  };

  // Spend comes from the log, read incrementally, so it counts every llm.call any gateway recorded, retries included.
  let spent = 0;
  let seen = 0;
  let navigationSpent = 0;
  const comparisonCosts = { navigation: { cost: 0, calls: 0 }, comparison_assessment: { cost: 0, calls: 0 }, comparison_verification: { cost: 0, calls: 0 } };
  const blockReservations = new Map<string, { total: number; navigation: number }>();
  let comparisonAdmissionReason: string | null = null;
  const spentUsd = () => {
    for (const e of store.events(run_id, { types: ['llm.call'], afterSeq: seen })) {
      seen = e.seq;
      if (e.type === 'llm.call') {
        spent += e.payload.cost_usd;
        if (project.comparison) {
          const cost = e.payload.cost_usd;
          const purpose = e.payload.purpose;
          const stage = purpose === 'comparison_assessment' || purpose === 'comparison_verification' ? purpose
            : e.payload.role === 'navigator' ? 'navigation' : e.payload.role === 'judge' ? 'comparison_assessment' : null;
          if (stage === 'navigation') navigationSpent += cost;
          if (stage) {
            comparisonCosts[stage].cost += cost;
            comparisonCosts[stage].calls++;
          }
          const reservation = blockReservations.get(e.persona_id ?? '');
          if (reservation) {
            reservation.total = Math.max(0, reservation.total - cost);
            if (stage === 'navigation') reservation.navigation = Math.max(0, reservation.navigation - cost);
          }
        }
      }
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
  // Outside comparisons whole cohorts, slices and phases are admitted (admit below), so no step is refused by who answered first.
  let inFlight = 0;
  let stepsDone = 0;
  const beginStep = (estimatedCost?: number) => {
    if (drain.signal.aborted) return false;
    checkRecordedBudget();
    if (drain.signal.aborted) return false;
    const now = spentUsd();
    const perStep = estimatedCost ?? (stepsDone ? now / stepsDone : 0);
    if (project.comparison && now + (inFlight + 1) * perStep >= settings.cost_budget_usd) {
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
  /** Before a usage slice or social phase: false, and a stop, when its `steps` at the average cost so far would reach the budget. */
  const admit = (steps: number, what: string) => {
    const now = spentUsd();
    if (now + steps * (stepsDone ? now / stepsDone : 0) < settings.cost_budget_usd) return true;
    halt({ reason: 'cost_budget', detail: `${what} was projected to reach the $${settings.cost_budget_usd} budget` }, false);
    return false;
  };

  // Admission reserves a minimum useful matched block: one observation and two evidence-review calls per target.
  // Observed costs per purpose replace the starting estimate. Longer tasks, retries and unknown billing can exceed it;
  // this improves coverage allocation, while the recorded-cost guard remains the run-wide stop policy.
  const comparisonCallCost = (stage: keyof typeof comparisonCosts) => {
    const observed = comparisonCosts[stage];
    if (observed.calls) return observed.cost / observed.calls;
    const role = stage === 'navigation' ? 'navigator' : stage === 'comparison_verification' ? project.comparison!.execution.verifier ?? 'judge' : 'judge';
    const model = settings.routing[role];
    if (!isPriced(model)) return null;
    return costUsd(model, { input_tokens: stage === 'navigation' ? 5000 : 1500, output_tokens: stage === 'navigation' ? 200 : 400, cache_read_tokens: 0, cache_write_tokens: 0 });
  };
  const beginComparisonBlock = (persona: Persona, task: ComparisonTask) => {
    if (drain.signal.aborted) return false;
    const now = spentUsd();
    const scenario = project.comparison!.scenarios.find((item) => item.id === task.scenario_id)!;
    if (scenario.segment_ids !== null && !scenario.segment_ids.includes(persona.segment_id ?? '')) return true;
    const targetCount = task.entries.filter((entry) => {
      const poi = project.pois.find((item) => item.id === entry.poi_id)!;
      return poi.segments === null || poi.segments.includes(persona.segment_id ?? '');
    }).length;
    // Unknown prices cannot support a dollar reservation. The comparison report discloses this explicitly;
    // observed charges take over once available, retaining the existing support for unpriced model routes.
    const navigatorCost = comparisonCallCost('navigation') ?? 0;
    const assessmentCost = comparisonCallCost('comparison_assessment') ?? 0, verifierCost = comparisonCallCost('comparison_verification') ?? 0;
    const needed = { navigation: targetCount * navigatorCost, total: targetCount * (navigatorCost + assessmentCost + verifierCost) };
    const reserved = [...blockReservations.values()].reduce((sum, value) => ({ total: sum.total + value.total, navigation: sum.navigation + value.navigation }), { total: 0, navigation: 0 });
    const navigationLimit = settings.cost_budget_usd * (1 - project.comparison!.execution.analysis_reserve_fraction);
    if (now + reserved.total + needed.total > settings.cost_budget_usd || navigationSpent + reserved.navigation + needed.navigation > navigationLimit) {
      comparisonAdmissionReason = 'The remaining allowance cannot admit another complete matched task block with evidence analysis; its targets were left unattempted.';
      return false;
    }
    blockReservations.set(persona.id, needed);
    return true;
  };

  const tripwire = (persona_id: string, poi_id: string) => (kind: EventPayloads['containment.tripwire']['kind'], detail: string) => {
    record({ ...base, persona_id, poi_id, type: 'containment.tripwire', payload: { kind, detail } });
    halt({ reason: 'tripwire', detail }, true);
  };

  const observe = observeOptions(hard.signal); // robots.txt once per run and observe-only POI
  // Loaded on every open, so a persona resumed after a re-recording logs in with the new session. Observe-only POIs are browsed logged out.
  const openPage = (persona: Persona, role: string | null, target?: ComparisonTarget) => async (poi: WebPoi) => {
    const login = poi.mode === 'full' ? role : null;
    const saved = login ? await sessions?.load(login) : null;
    if (target && saved && saved.info.target_id !== target.id) throw new ComparisonEnvironmentError(`The recorded session is not bound to ${target.name}; record its own test account.`);
    const observing = await observe(poi);
    if (target && observing && !observing.robots(new URL(poi.start_url))) throw new ComparisonEnvironmentError(`The configured entry page for ${target.name} is unavailable under robots.txt or its retrieval policy.`);
    hard.signal.throwIfAborted();
    if (target && login && !saved) throw new ComparisonEnvironmentError(`The recorded login for ${target.name} is missing; record its own test account.`);
    if (login && !saved) throw new Error(`The recorded "${login}" login is missing. Record it again, then start a new run.`);
    return browsers.newPage({
      device: persona.device,
      ...personaEnvironment(persona),
      allowedHosts: allowedHosts(poi),
      blockedDomains: poi.production_domains,
      storageState: saved?.state ?? null,
      observe: observing,
      onBlockedRequest: ({ host, url, method, navigation, reason }) => {
        record({ ...base, persona_id: persona.id, poi_id: poi.id, type: 'containment.blocked_request', payload: reason === 'host' ? { host, url, method } : { host, url, method, reason } });
        const production = productionDomain(host, poi.production_domains);
        if (navigation && production) tripwire(persona.id, poi.id)('production_host', `${persona.name} tried to open ${url}, on the production domain ${production}.`);
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

  // One survey per persona and POI once its episode has ended (tech.md §8.2), admitted like a step so a run-wide stop or
  // the cost cap prevents it. The navigator plays the persona, so it answers the persona's survey too.
  const survey = async (persona: Persona, poi: Poi, end: EpisodeEnd) => {
    // A model that could not answer the steps has nothing to say about the product either.
    if (end === 'blocked' || end === 'stopped' || end === 'model_failed' || !beginStep()) return;
    try {
      const own = store.events(run_id, { personaId: persona.id, types: ['persona.step', 'persona.friction_reported', 'persona.goal_done', 'persona.abandoned'] }).filter((e) => e.poi_id === poi.id);
      const segment = segmentOf(persona, project);
      // The survey answers from what the persona saw: its opinion of this POI and its latest thoughts, as the social phase does.
      const opinion = currentOpinion(persona.id, poi.id);
      if (segment?.kind === 'buyer') { // buyers answer the buying survey instead (agent/buyer.ts)
        const payload = await askBuyer({ llm: budgetedLlm, config, persona, segment, poi, end, own, opinion, round: base.round, signal: hard.signal });
        if (!hard.signal.aborted) record({ ...base, persona_id: persona.id, poi_id: poi.id, type: 'persona.survey', payload });
        return;
      }
      const ending = own.find((e) => e.type === 'persona.goal_done' || e.type === 'persona.abandoned');
      const steps = own.flatMap((e) => (e.type === 'persona.step' && e.payload.result.error !== 'invalid_output' ? [e.payload] : []));
      const compare = comparisonFor(project, persona, poi, store.events(run_id, { personaId: persona.id, types: ['persona.survey'] })); // competitor POIs only
      const { object } = await budgetedLlm.call(compare.ask({
        role: 'navigator',
        model: settings.routing.navigator,
        run_id,
        persona_id: persona.id,
        round: base.round,
        purpose: 'survey',
        poi_id: poi.id,
        system: surveySystemPrompt(persona, project, segmentOf(persona, project), poi),
        user: surveyParts({
          persona,
          product: surveyedName(project, poi),
          end,
          detail: ending?.type === 'persona.goal_done' ? ending.payload.summary : ending?.type === 'persona.abandoned' ? ending.payload.reason : null,
          steps: steps.length,
          frictions: own.flatMap((e) => (e.type === 'persona.friction_reported' ? [e.payload.what] : [])),
          thoughts: steps.slice(-5).flatMap((s) => (s.thought ? [s.thought] : [])),
          opinion,
        }),
        schema: surveySchema,
        signal: hard.signal,
        timeout_ms: 30_000,
      }));
      // A late answer after cancellation stays logged as llm.call but is not used, as with steps.
      if (hard.signal.aborted) return;
      const { sentiment, confidence, would_continue, reason } = object;
      const items = surveyItems(object);
      // The plain lists keep their old meaning for older readers: what was liked, and what would put the persona off.
      const likes = items.filter((i) => i.kind === 'like').map((i) => i.what);
      const frictions = items.filter((i) => i.kind !== 'like').map((i) => i.what);
      record({ ...base, persona_id: persona.id, poi_id: poi.id, type: 'persona.survey', payload: { poi_id: poi.id, sentiment, confidence, likes, frictions, items, would_continue, reason, ...compare.answer(object) } });
    } catch (err) {
      // An invalid or timed-out survey must not prevent reporting an episode that already ended.
      if (!(err instanceof InvalidOutputError) && !(err instanceof Error && err.name === 'TimeoutError') && !hard.signal.aborted) throw err;
    } finally {
      endStep();
    }
  };

  const ends = new Map<string, EpisodeEnd>(); // ended personas can join social phases while other episodes continue

  // The persona's own changes only: folding the whole run's for every persona at every slice grew with the square of the swarm.
  const currentOpinion = (persona_id: string, poi_id: string) =>
    foldOpinions(store.events(run_id, { personaId: persona_id, types: ['persona.opinion_changed'] })).find((o) => o.poi_id === poi_id)?.opinion ?? null;
  // What each persona read in its latest social phase, handed to its next step so word of mouth reaches the product (tech.md §6.1).
  const heard = new Map<string, HeardPost[]>();

  // With social rounds an episode runs on across slices, page and memory intact; between slices it waits here for its turn.
  const waiting = new Map<string, (go: boolean) => void>();
  const yielded = new Map<string, () => void>();
  const tasks = new Map<string, Promise<void>>();
  const between = (persona_id: string, poi_id: string) => () =>
    new Promise<{ opinion: Opinion | null; heard: HeardPost[] } | null>((resolve) => {
      waiting.set(persona_id, (go) => {
        const posts = heard.get(persona_id) ?? [];
        heard.delete(persona_id);
        resolve(go && !drain.signal.aborted ? { opinion: currentOpinion(persona_id, poi_id), heard: posts } : null);
      });
      yielded.get(persona_id)?.();
    });
  /** One persona's usage slice: starts its episode or wakes it, and settles when it has taken its steps or ended. */
  const turn = (persona: Persona) => {
    const gave = new Promise<void>((resolve) => yielded.set(persona.id, resolve));
    const wake = waiting.get(persona.id);
    waiting.delete(persona.id);
    if (wake) wake(true);
    else tasks.set(persona.id, episode(persona));
    return Promise.race([gave, tasks.get(persona.id)!]);
  };

  /** Steps a persona takes in one usage slice: its budgets over all its POIs, spread over the rounds. */
  const sliceOf = (persona: Persona) => Math.ceil(assigned.get(persona.id)!.reduce((sum, poi) => sum + poiBudget(persona, poi), 0) / rounds);

  /** The persona's POIs one after another, each with its own budget and survey; slices count steps across them. */
  const episode = async (persona: Persona) => {
    const role = roleOf(persona, project);
    const session = role ? (config.sessions.find((s) => s.role === role) ?? null) : null;
    if (role && !session) throw new Error(`No login for the "${role}" role was verified before the run.`);
    const pois = assigned.get(persona.id)!;
    const budgets = pois.map((poi) => poiBudget(persona, poi));
    const slice = rounds ? sliceOf(persona) : 0;
    let stepsBefore = 0;
    for (const [i, poi] of pois.entries()) {
      const end = await runnerFor(poi).episode(poi, {
        config,
        persona,
        segment: segmentOf(persona, project),
        session,
        budget: budgets[i],
        stepsBefore,
        opinion: currentOpinion(persona.id, poi.id),
        openPage: openPage(persona, role),
        llm: budgetedLlm,
        blobs,
        record,
        signal: hard.signal,
        beginStep,
        endStep,
        tripwire: tripwire(persona.id, poi.id),
        waitForResume: waitForResume(persona.id),
        round: () => base.round,
        slice: rounds ? { steps: slice, next: between(persona.id, poi.id) } : undefined,
      });
      const last = end === 'stopped' || i === pois.length - 1;
      if (last) ends.set(persona.id, end);
      await survey(persona, poi, end); // when the episode ends, whichever round that is
      if (last) return;
      const lastStep = store.events(run_id, { personaId: persona.id, types: ['persona.step'] }).at(-1);
      if (lastStep?.type === 'persona.step') stepsBefore = lastStep.payload.step_no;
    }
  };

  const names = new Map(config.personas.map((p) => [p.id, p.name]));
  const poiNames = new Map(project.pois.map((poi) => [poi.id, poi.name]));
  // One socialiser call per persona and phase (tech.md §6.6), admitted like a step so a stop or the cost cap prevents it.
  // Resolves with the validated answer's recording, staged for the phase to apply in population order, or null when silent.
  const socialise = async (persona: Persona, round: number, own: GnomiEvent[], feed: FeedPost[], board: Board, opinions: CurrentOpinion[]): Promise<(() => void) | null> => {
    if (!beginStep()) return null;
    try {
      const post_ids = feed.map((p) => p.post_id);
      const posts = new Map(board.posts.map((p) => [p.post_id, p]));
      // A reply shows its parent's text too, so the parent reached the persona as well.
      const parent_ids = [...new Set(feed.flatMap((p) => (p.parent_id && posts.has(p.parent_id) ? [p.parent_id] : [])))];
      record({ ...base, persona_id: persona.id, type: 'social.feed_viewed', payload: { post_ids, parent_ids } });
      const opinionOf = (poi_id: string) => opinions.find((o) => o.persona_id === persona.id && o.poi_id === poi_id)?.opinion ?? null;
      const pois = assigned.get(persona.id)!;
      const name = (id: string) => names.get(id) ?? id;
      const about = (poi_id: string | null) => (poi_id ? (poiNames.get(poi_id) ?? null) : null);
      const steps = own.filter((e) => e.type === 'persona.step' && e.payload.result.error !== 'invalid_output');
      heard.set(persona.id, feed.slice(0, HEARD_POSTS).map((p) => ({ post_id: p.post_id, author: name(p.author), text: p.text, about: about(p.about_poi_id) })));
      const { object } = await budgetedLlm.call({
        role: 'socialiser',
        model: settings.routing.socialiser,
        run_id,
        persona_id: persona.id,
        round,
        purpose: 'social',
        system: socialSystemPrompt(persona, project, segmentOf(persona, project), pois),
        user: socialParts({
          persona,
          project,
          round,
          rounds,
          end: ends.get(persona.id) ?? null,
          steps: steps.length,
          // A text's confusions keep the passage they are about, so a post can say which sentence is the problem.
          frictions: own.flatMap((e) => (e.type === 'persona.friction_reported' ? [{ what: e.payload.what, quote: e.payload.passage?.text ?? null }] : [])),
          thoughts: steps.slice(-2).flatMap((e) => (e.type === 'persona.step' && e.payload.thought ? [e.payload.thought] : [])),
          pois: pois.map((poi) => ({ name: poi.name, opinion: opinionOf(poi.id) })),
          posted: own.flatMap((e) => (e.type === 'social.post' ? [e.payload.text] : [])),
          feed: feed.map((p) => {
            const { post_id, author, text, agree, disagree, parent_id } = p;
            const parent = parent_id ? posts.get(parent_id) : undefined;
            return { post_id, author: name(author), about: about(p.about_poi_id), text, agree, disagree, parent: parent ? { author: name(parent.author), text: parent.text } : null };
          }),
        }),
        schema: socialSchema(post_ids, pois.map((poi) => poi.id) as [string, ...string[]]),
        signal: hard.signal,
      });
      const { action, post_id, text, reaction, about_poi_id, opinion_updates } = object;
      const mine = { ...base, persona_id: persona.id };
      return () => {
        // The schema guarantees the text, post and reaction each action needs. A persona writes at most one post a round.
        if (action === 'post' || action === 'reply') {
          record({ ...mine, poi_id: about_poi_id, type: 'social.post', payload: { post_id: `r${round}-${persona.id}`, parent_id: action === 'reply' ? post_id : null, text: text!, about_poi_id } });
        }
        if (action === 'react') record({ ...mine, type: 'social.reaction', payload: { post_id: post_id!, kind: reaction! } });
        for (const { poi_id, post_ids: cited, ...after } of opinion_updates) {
          const before = opinionOf(poi_id);
          if (sameOpinion(before, after)) continue;
          record({ ...mine, poi_id, type: 'persona.opinion_changed', payload: { poi_id, before, after, cause: { step_ids: [], post_ids: [...new Set(cited)] } } });
        }
      };
    } catch (err) {
      // Two invalid answers leave the persona silent for this phase (tech.md §10.6); any other model error ends the run.
      if (!(err instanceof InvalidOutputError) && !hard.signal.aborted) throw err;
      return null;
    } finally {
      endStep();
    }
  };

  const injectedIn = (round: number) => (config.injected_posts ?? []).filter((p) => p.round === round);

  /**
   * Who has something to do in this phase, from one snapshot of the log: a persona with an unseen post in its feed, or with use
   * since it last read the feed (steps, so something of its own to tell) while a later round is left for anyone to read what it
   * writes. Anyone else would read an empty feed with nothing new to say, the same prompt as last time, so it is not asked again:
   * mostly silent swarms stop paying for silence. A lone persona has nobody to talk to.
   */
  const planPhase = (round: number) => {
    // One snapshot for the phase: personas read side by side, so what they write now shows from the next round on.
    const events = store.events(run_id, { types: ['social.post', 'social.reaction', 'social.feed_viewed', 'persona.opinion_changed', 'persona.step', 'persona.friction_reported'] });
    const board = readBoard(events);
    const opinions = foldOpinions(events);
    const own = new Map<string, GnomiEvent[]>();
    const lastRead = new Map<string, number>();
    const lastStep = new Map<string, number>();
    for (const e of events) {
      if (!e.persona_id) continue;
      own.get(e.persona_id)?.push(e) ?? own.set(e.persona_id, [e]);
      if (e.type === 'social.feed_viewed') lastRead.set(e.persona_id, e.seq);
      if (e.type === 'persona.step') lastStep.set(e.persona_id, e.seq);
    }
    const due = new Map<Persona, { feed: FeedPost[]; own: GnomiEvent[] }>();
    for (const persona of config.personas.length > 1 ? config.personas : []) {
      const ties = mulberry32(fnv1a(`feed/${config.seed}/${persona.id}/${round}`));
      const feed = selectFeed(board, persona.id, follows?.get(persona.id) ?? [], ties, new Set(assigned.get(persona.id)!.map((poi) => poi.id)), settings.feed_policy);
      const used = (lastStep.get(persona.id) ?? 0) > (lastRead.get(persona.id) ?? 0);
      if (feed.length || (used && round < rounds)) due.set(persona, { feed, own: own.get(persona.id) ?? [] });
    }
    return { due, board, opinions };
  };

  const socialPhase = async (round: number) => {
    // Harness posts go in first, under ids no model post can have, so this round's feeds can show them.
    injectedIn(round).forEach((p, i) => {
      record({ ...base, persona_id: p.persona_id, poi_id: p.poi_id, type: 'social.post', payload: { post_id: `inj-r${round}-${i + 1}`, parent_id: null, text: p.text, about_poi_id: p.poi_id, injected: true } });
    });
    const { due, board, opinions } = planPhase(round);
    if (!admit(due.size, `the social phase of round ${round}`)) return;
    const staged = new Map<Persona, () => void>();
    await inParallel(mixed([...due.keys()]), async (persona) => {
      const { feed, own } = due.get(persona)!;
      const apply = await socialise(persona, round, own, feed, board, opinions);
      if (apply) staged.set(persona, apply);
    });
    // In population order once every call has settled, so response speed cannot decide whose post is newest (new_simulation.md §5).
    // A late answer after cancellation stays logged as llm.call but is not used, as with steps; the log says it was dropped.
    if (!hard.signal.aborted) for (const persona of due.keys()) staged.get(persona)?.();
    else for (const persona of staged.keys()) {
      const call_seq = store.events(run_id, { personaId: persona.id, types: ['llm.call'] }).at(-1)?.seq ?? null; // its social call: its last
      record({ ...base, persona_id: persona.id, type: 'social.discarded', payload: { call_seq } });
    }
  };

  // Personas start in a seeded order that mixes segments, so a stop part-way does not cut the population by segment.
  const startKey = new Map(config.personas.map((p) => [p.id, fnv1a(`order/${config.seed}/${p.id}`)]));
  const mixed = (personas: Persona[]) => personas.toSorted((a, b) => startKey.get(a.id)! - startKey.get(b.id)!);

  // At most `concurrency` personas in flight, each with its own page; a paused persona keeps its slot and its page.
  const inParallel = async (personas: Persona[], work: (persona: Persona) => Promise<void>) => {
    const running = new Set<Promise<void>>();
    for (const persona of personas) {
      while (running.size >= concurrency && !drain.signal.aborted) await Promise.race(running);
      if (drain.signal.aborted) break;
      const tracked: Promise<void> = work(persona)
        .catch((err) => halt(hard.signal.aborted ? { reason: 'user', detail: null } : { reason: 'error', detail: err instanceof Error ? err.message : String(err) }, true))
        .finally(() => running.delete(tracked));
      running.add(tracked);
    }
    await Promise.all(running);
  };

  const comparison = project.comparison ? createComparisonRuntime({
    config, llm: budgetedLlm, blobs, record, events: (opts) => store.events(run_id, opts), signal: hard.signal,
    openPage: (persona, target, poi) => openPage(persona, comparisonSession(config, target).session?.role ?? null, target)(poi),
    beginBlock: beginComparisonBlock,
    endBlock: (persona) => { spentUsd(); blockReservations.delete(persona.id); },
    beginUsageStep: () => { spentUsd(); return navigationSpent < settings.cost_budget_usd * (1 - project.comparison!.execution.analysis_reserve_fraction) && beginStep(comparisonCallCost('navigation') ?? undefined); },
    beginAnalysisStep: (purpose) => beginStep(comparisonCallCost(purpose) ?? undefined), endStep, stopped: () => drain.signal.aborted,
    stopReason: () => halted?.detail ?? (halted ? halted.reason : comparisonAdmissionReason ?? 'The navigation allowance was exhausted; remaining allowance is reserved for evidence analysis.'),
    tripwire,
  }) : null;

  const schedule = async () => {
    if (comparison) {
      await inParallel(config.personas, (persona) => comparison.runPersona(persona));
      comparison.finishUnscheduled();
      if (comparisonAdmissionReason && !halted) halt({ reason: 'cost_budget', detail: comparisonAdmissionReason }, false);
      return;
    }
    if (!rounds) {
      const steps = config.personas.reduce((sum, p) => sum + assigned.get(p.id)!.reduce((own, poi) => own + poiBudget(p, poi), 0), 0);
      return admit(steps, 'the cohort') ? inParallel(mixed(config.personas), episode) : undefined;
    }
    // Once every episode is over the swarm keeps talking, within the R rounds, while anyone has something to read or tell: a text
    // read in one sitting is still discussed, and what a persona found in its last stretch of use reaches the feed.
    for (let round = 1; round <= rounds && !drain.signal.aborted; round++) {
      const using = config.personas.filter((p) => !ends.has(p.id));
      if (!using.length && !injectedIn(round).length && !planPhase(round).due.size) break;
      if (using.length && !admit(using.reduce((sum, p) => sum + sliceOf(p), 0), `the usage slice of round ${round}`)) break;
      base.round = round;
      record({ ...base, type: 'run.round_started', payload: {} });
      if (using.length) await inParallel(mixed(using), turn);
      if (!drain.signal.aborted) await socialPhase(round);
      record({ ...base, type: 'run.round_ended', payload: {} });
    }
    // A stop leaves episodes waiting for a slice that will not come: they end now and close their pages.
    for (const wake of waiting.values()) wake(false);
    await Promise.allSettled(tasks.values());
  };

  const resetStaging = async (url: string) => {
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
      if (config.reset) {
        const hooks = [...new Set(webPois(effectiveComparisonPois(project)).flatMap((poi) => poi.reset_hook_url ?? []))];
        if (hooks.length === 0) throw new Error('This project has no reset hook to call.');
        for (const url of hooks) await resetStaging(url);
      }
      // The host's preflight catches this first; a run started some other way ends here, logged, rather than half-scheduled.
      const idle = !project.comparison && config.personas.find((p) => assigned.get(p.id)!.length === 0);
      if (idle) throw new Error(`${idle.name} has no point of interest to use.`);
      for (const persona of config.personas) record({ ...base, persona_id: persona.id, type: 'persona.created', payload: follows ? { persona, follows: follows.get(persona.id)! } : { persona } });
      await schedule();
    } catch (err) {
      halt(hard.signal.aborted ? { reason: 'user', detail: null } : { reason: 'error', detail: err instanceof Error ? err.message : String(err) }, true);
    } finally {
      comparison?.finishUnscheduled();
      if (!comparison) clearTimeout(clock);
    }
    // The judge and author run once the episodes are over, through the budgeted gateway: a stop or the cost cap skips them.
    try {
      if (!halted && !comparison) await runReportModels({ config, round: base.round, llm: budgetedLlm, record, events: () => store.events(run_id) });
    } finally {
      clearTimeout(clock); // Comparison analysis remains under the run's wall-clock allowance.
    }

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
