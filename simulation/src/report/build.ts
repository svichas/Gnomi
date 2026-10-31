import { createHash } from 'node:crypto';
import { poisFor, webPois, withPois, type SavedProject } from '../poi/pois.ts';
import { DEFAULT_SETTINGS, readsImages } from '../settings.ts';
import { isAttributeEnabled } from '../profile/schema.ts';
import { buildComparisons, competitorIds } from './compare.ts';
import { buildComparison } from './comparison.ts';
import { buildCoverage } from './coverage.ts';
import { buildDimensions, reportAttributes, themeDrivers } from './dimensions.ts';
import { buildFlow } from './flow.ts';
import { buildSpread, homogeneity } from './spread.ts';
import { foldStudy } from './study.ts';
import { buyerResults } from './buyers.ts';
import { stepEvidence, stepReader } from './friction.ts';
import { analyseFrictions, sentimentBySegment, wentWell, type Context } from './themes.ts';
import type {
  Audience,
  EventOf,
  EventType,
  GnomiEvent,
  Outcome,
  Persona,
  ProjectConfig,
  ProviderId,
  Report,
  ReportFriction,
  ReportMethods,
  ReportPersona,
  ReportSegment,
  Routing,
  RunConfig,
  SessionInfo,
} from '../types.ts';
import { isUnrated } from '../types.ts';

export const HYPOTHESIS_BANNER =
  'These findings come from simulated users. Treat them as hypotheses and validate the top items with real users before committing to changes.';

const OUTCOMES: Outcome[] = ['done', 'abandoned', 'budget_exceeded', 'repeated_failure', 'model_failed', 'blocked', 'incomplete', 'not_started'];
// Events only an episode the persona began can log.
const EPISODE = new Set<EventType>(['persona.episode_started', 'persona.step', 'persona.goal_done', 'persona.abandoned']);
// A persona with several POIs ends as its worst: the first of these that one of its POIs ended with.
const WORST: Outcome[] = ['blocked', 'repeated_failure', 'budget_exceeded', 'abandoned', 'model_failed', 'incomplete'];

// Runs logged before M2 froze one `persona`, a top-level budget, and no audience or settings; before M5, one `poi`.
type LoggedConfig = Omit<RunConfig, 'personas' | 'sessions' | 'project'> & {
  project: Omit<SavedProject, 'audience' | 'settings'> & Partial<Pick<ProjectConfig, 'audience' | 'settings'>>;
  personas?: Persona[];
  persona?: Persona;
  sessions?: SessionInfo[];
  session?: SessionInfo | null;
  cost_budget_usd?: number;
  signals?: Record<string, unknown>; // the signal thresholds, frozen from M3 on (RunConfig.signals)
};

type Ending = Pick<ReportPersona, 'outcome' | 'outcome_text'>;

function ofType<K extends EventType>(events: GnomiEvent[], type: K): EventOf<K>[] {
  return events.filter((e): e is EventOf<K> => e.type === type);
}

// A rate over nobody is unknown, not 0%: a segment the run never reached would read as a total failure.
const rate = (count: number, total: number) => (total === 0 ? null : count / total);

// A block is resumed when its persona resumed after it.
const resumedAfter = (own: GnomiEvent[], block: EventOf<'persona.blocked'>) =>
  ofType(own, 'persona.resumed').some((r) => r.seq > block.seq);

// One persona's episode ends as the first matching rule below, lowest priority first, so each later line overrides.
function endingOf(own: GnomiEvent[]): Ending {
  const goalDone = ofType(own, 'persona.goal_done').at(0);
  const abandoned = ofType(own, 'persona.abandoned').at(0);
  const stuck = ofType(own, 'signal.repeated_failure').at(0);
  const budget = ofType(own, 'signal.budget_exceeded').at(0);
  const lastBlock = ofType(own, 'persona.blocked').at(-1);
  let ending: Ending = { outcome: 'incomplete', outcome_text: null };
  if (budget) ending = { outcome: 'budget_exceeded', outcome_text: null };
  if (lastBlock && !resumedAfter(own, lastBlock)) ending = { outcome: 'blocked', outcome_text: lastBlock.payload.detail };
  if (stuck) {
    ending = stuck.payload.error === 'invalid_output'
      ? { outcome: 'model_failed', outcome_text: 'The model gave no valid answer, so the persona could not go on; this says nothing about the product' }
      : { outcome: 'repeated_failure', outcome_text: `The same ${stuck.payload.action} failed three times in a row (${stuck.payload.error})` };
  }
  if (abandoned) ending = { outcome: 'abandoned', outcome_text: abandoned.payload.reason };
  if (goalDone) ending = { outcome: 'done', outcome_text: goalDone.payload.summary };
  return ending;
}

/** Each POI the persona was given ends on its own; the persona is done only when all of them are, else as its worst. */
function endingsOf(own: GnomiEvent[], given: string[], defaultPoi: string): Ending & { pois: Record<string, Outcome> } {
  const endings = given.map((poi_id): Ending => {
    const mine = own.filter((e) => (e.poi_id ?? defaultPoi) === poi_id);
    const began = mine.some((e) => EPISODE.has(e.type));
    return began ? endingOf(mine) : { outcome: 'not_started', outcome_text: null };
  });
  const pois = Object.fromEntries(given.map((id, i) => [id, endings[i].outcome]));
  if (endings.every((e) => e.outcome === 'not_started')) return { outcome: 'not_started', outcome_text: null, pois };
  if (endings.every((e) => e.outcome === 'done')) return { ...endings[0], pois };
  // A POI the persona never got to leaves it incomplete.
  const worst = WORST.find((o) => endings.some((e) => (e.outcome === 'not_started' ? 'incomplete' : e.outcome) === o))!;
  return { ...(endings.find((e) => e.outcome === worst) ?? { outcome: 'incomplete', outcome_text: null }), pois };
}

// Rates leave out personas the run never started and ones the model never answered: neither says anything about the product.
function segmentOf(id: string | null, name: string, share: number, members: ReportPersona[], withFriction: Set<string>, pois: string[]): ReportSegment {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  for (const p of members) outcomes[p.outcome] += 1;
  const started = members.filter((p) => !isUnrated(p.outcome));
  const perPoi = pois.map((poi_id) => {
    const on = members.filter((p) => p.pois?.[poi_id] !== undefined && !isUnrated(p.pois[poi_id]));
    return { poi_id, personas: on.length, completion: rate(on.filter((p) => p.pois?.[poi_id] === 'done').length, on.length) };
  });
  return {
    id,
    name,
    share,
    personas: members.length,
    outcomes,
    completion: rate(outcomes.done, started.length),
    with_friction: rate(started.filter((p) => withFriction.has(p.id)).length, started.length),
    frictions: members.reduce((sum, p) => sum + p.frictions, 0),
    ...(pois.length > 1 ? { pois: perPoi } : {}),
  };
}

// A pure fold over one run's events in seq order: the report is only ever made this way (tech.md §5.1).
export function buildReport(events: GnomiEvent[]): Report {
  const started = ofType(events, 'run.started').at(0);
  if (!started) throw new Error('Cannot build a report: the run has no run.started event');
  const config = started.payload.config as LoggedConfig;
  const audience: Audience | null = config.project.audience ?? null;
  const settings = config.project.settings ?? null;
  const schema = config.project.persona_schema;
  const { prior } = config;
  const { pois } = withPois(config.project);
  const grounding = (audience?.segments ?? []).flatMap(({ id, name, grounding: real }) => (real && config.personas?.some((persona) => persona.segment_id === id)
    ? [{ segment_id: id, name, facts: real.facts.length, remarks: real.remarks.length, sources: real.sources.map((source) => source.name) }] : []));
  const comparison = buildComparison(events);
  // A competitor's site gets its own themes and comparisons; outcomes, frictions, feelings and sentiment describe the team's product.
  const competitors = competitorIds(pois);
  const ours = competitors.size ? events.filter((e) => !competitors.has(e.poi_id ?? '')) : events;

  const byPersona = new Map<string, GnomiEvent[]>();
  for (const e of ours) {
    const key = e.persona_id ?? '';
    const list = byPersona.get(key);
    if (list) list.push(e);
    else byPersona.set(key, [e]);
  }
  const eventsOf = (persona_id: string) => byPersona.get(persona_id) ?? [];

  // One persona per persona.created. Without those (runs before M2, or a run that never started) use the frozen population.
  const created = ofType(events, 'persona.created');
  const population: Persona[] =
    created.length > 0 ? created.map((e) => e.payload.persona) : (config.personas ?? (config.persona ? [config.persona] : []));
  const personaById = new Map<string, Persona>();
  for (const p of population) if (!personaById.has(p.id)) personaById.set(p.id, p);

  const ourPois = pois.filter((poi) => !competitors.has(poi.id));
  const personas: ReportPersona[] = population.map((p) => {
    const own = eventsOf(p.id);
    const given = poisFor(ourPois, audience?.segments.find((s) => s.id === p.segment_id) ?? null).map((poi) => poi.id);
    const { pois: perPoi, ...ending } = endingsOf(own, given, pois[0]?.id ?? '');
    return {
      id: p.id,
      name: p.name,
      ...(!schema || isAttributeEnabled(schema, 'job_title', 'all') ? { job_title: p.job_title } : {}),
      segment_id: p.segment_id ?? null, // runs before M2 have no segment
      device: p.device,
      ...ending,
      ...(ourPois.length > 1 ? { pois: perPoi } : {}),
      steps: ofType(own, 'persona.step').length,
      frictions: ofType(own, 'persona.friction_reported').length,
      ...(schema ? { attributes: reportAttributes(p, schema) } : {}),
    };
  });

  const atStep = stepReader(events, pois[0]?.id ?? '');
  const frictions: ReportFriction[] = ofType(ours, 'persona.friction_reported').map((e) => {
    const persona_id = e.persona_id ?? '';
    const persona = personaById.get(persona_id);
    const at = atStep(e, e.payload.step_no, e.payload.where.url);
    return {
      seq: e.seq,
      persona_id,
      persona_name: persona?.name ?? persona_id,
      segment_id: persona?.segment_id ?? null,
      step_no: e.payload.step_no,
      severity: e.payload.severity,
      what: e.payload.what,
      expected: e.payload.expected,
      url: at.url!, // a text or design by its name, not its stored file
      quote: at.quote,
      screenshot: at.screenshot,
      ...stepEvidence(e.payload, at),
    };
  });

  // Segments with no personas in this run are left out; a run without an audience has one built-in segment.
  const inRun = audience
    ? audience.segments.filter((s) => personas.some((p) => p.segment_id === s.id)).map((s) => ({ id: s.id, name: s.name, share: s.share }))
    : [{ id: null, name: 'Built-in persona', share: 100 }];
  const ctx: Context = {
    poi_id: pois[0]?.id ?? '',
    personas: new Map(personas.map((p) => [p.id, { name: p.name, segment_id: p.segment_id }])),
    segments: inRun,
  };
  const analysis = analyseFrictions(events, ctx);

  // Ran into friction: any self-report, survey friction or signal in a friction theme of the team's product; objections are not friction.
  // A scan's signal is about the page: its persona only reached it first.
  const personaAt = new Map(events.filter((e) => e.type !== 'signal.accessibility').map((e) => [e.seq, e.persona_id]));
  const withFriction = new Set(analysis.themes.filter((t) => t.category !== 'objection' && !competitors.has(t.poi_id)).flatMap((t) => t.seqs.flatMap((seq) => personaAt.get(seq) ?? [])));
  const segments: ReportSegment[] = inRun.map((s) =>
    segmentOf(s.id, s.name, s.share, audience ? personas.filter((p) => p.segment_id === s.id) : personas, withFriction, ourPois.map((poi) => poi.id)),
  );

  // Each segment counts by its share; the shares are renormalised over the segments with a persona that started and got model answers.
  const counted = segments.filter((s) => s.personas > s.outcomes.not_started + s.outcomes.model_failed);
  const weight = counted.reduce((sum, s) => sum + s.share, 0);
  // A counted segment has someone started, so its rates are set.
  const weighted = (pick: (s: ReportSegment) => number | null) =>
    weight === 0 ? null : counted.reduce((sum, s) => sum + s.share * (pick(s) ?? 0), 0) / weight;
  const comparisons = buildComparisons(events, competitors, ctx);
  // Only runs with social rounds get the spread section and the homogeneity guard; other reports stay as they were.
  const social = events.some((e) => e.type === 'social.post');
  const buyers = buyerResults(events, pois, ctx);
  const flows = comparison ? [] : buildFlow(ours, webPois(ourPois), personas, pois[0]?.id ?? '');

  const inUse = audience ? audience.segments.filter((s) => segments.some((seg) => seg.id === s.id)) : [];
  const roleOfUse = comparison ? comparison.study.targets.map((target) => target.session_role) : audience ? inUse.map((s) => s.role) : [config.project.role ?? config.session?.role ?? null];
  const roles = [...new Set(roleOfUse)].filter((role): role is string => role !== null);

  const calls = ofType(events, 'llm.call');
  const latestFeeling = new Map<string, number>();
  for (const event of ofType(ours, 'persona.step')) {
    // Invalid output steps carry a synthetic zero; it is not the persona reporting a neutral feeling.
    if (event.persona_id && event.payload.result.error !== 'invalid_output') latestFeeling.set(event.persona_id, event.payload.feeling);
  }
  const dimensions = schema ? buildDimensions(population, personas, latestFeeling, schema, withFriction) : undefined;
  if (dimensions) {
    for (const theme of analysis.themes.filter((t) => !competitors.has(t.poi_id))) {
      const drivers = themeDrivers(theme, dimensions, personas, analysis.reach);
      if (drivers.length > 0) theme.drivers = drivers;
    }
  }
  const total = (pick: (e: EventOf<'llm.call'>) => number) => calls.reduce((sum, e) => sum + pick(e), 0);
  // Runs before M2 have no routing, so the call itself names the model it used.
  const routing: Routing | null = settings?.routing ?? null;
  const models: Partial<Routing> = {};
  for (const call of calls) {
    const { role, provider, model } = call.payload;
    models[role] ??= routing?.[role] ?? { provider: provider as ProviderId, model };
  }
  const response_models: NonNullable<Report['methods']['response_models']> = {};
  for (const { payload: { role, response_model } } of calls) {
    if (response_model && !response_models[role]?.includes(response_model)) (response_models[role] ??= []).push(response_model);
  }
  const checkCall = calls.find((e) => e.payload.purpose === 'report_check')?.payload;

  const end = events.findLast(
    (e): e is EventOf<'run.finished' | 'run.stopped'> => e.type === 'run.finished' || e.type === 'run.stopped',
  );
  let status: Report['status'] = 'running';
  let stop_reason: string | null = null;
  if (end?.type === 'run.finished') status = 'finished';
  else if (end?.type === 'run.stopped') {
    status = 'stopped';
    stop_reason = end.payload.detail === null ? end.payload.reason : `${end.payload.reason}: ${end.payload.detail}`;
  }
  const endedAt = end?.ts ?? null;
  const coverage = comparison ? [] : buildCoverage(ourPois, personas, analysis.themes, analysis.reach, status);

  const perHost = new Map<string, number>();
  for (const e of ofType(events, 'containment.blocked_request')) {
    const key = JSON.stringify([e.payload.host, e.payload.reason ?? null]);
    perHost.set(key, (perHost.get(key) ?? 0) + 1);
  }
  // Ties sort A to Z by host, then reason, so the same log always gives the same appendix.
  const blocked_requests = [...perHost]
    .sort(([a, m], [b, n]) => n - m || (a < b ? -1 : 1))
    .map(([key, count]) => {
      const [host, reason] = JSON.parse(key) as [string, 'observe_only' | 'robots' | null];
      return reason ? { host, count, reason } : { host, count };
    });
  // Each web POI's start page host comes first and is always allowed. One that does not parse adds none, so it cannot hide the rest of the report.
  const hosts = webPois(pois).flatMap((poi) => [URL.parse(poi.start_url)?.hostname ?? '', ...poi.allowed_hosts]);
  const allowed_hosts = [...new Set(hosts)].filter(Boolean);
  const perTarget = new Map<string, Set<string>>();
  for (const e of ofType(ours, 'signal.small_target')) {
    const { page, element } = atStep(e, e.payload.step_no, e.payload.url);
    const [, , width, height] = e.payload.box.map(Math.round);
    const key = JSON.stringify([page, element, width, height]);
    perTarget.set(key, (perTarget.get(key) ?? new Set()).add(e.persona_id ?? ''));
  }
  const undersized_targets = [...perTarget]
    .sort(([a, m], [b, n]) => n.size - m.size || (a < b ? -1 : 1))
    .map(([key, ids]) => {
      const [page, element, width, height] = JSON.parse(key) as [string, string | null, number, number];
      return { page, element, width, height, personas: ids.size };
    });
  // A rule on a page is one line, however many states of the page broke it. A page with one good scan counts as scanned.
  const audited = new Map<string, NonNullable<ReportMethods['accessibility_audit']>[number]>();
  const scans = ofType(ours, 'accessibility.scanned').map((e) => ({ e, page: atStep(e, e.payload.step_no, e.payload.url).page ?? e.payload.url }));
  for (const { e, page } of scans) {
    for (const { category: _, ...violation } of e.payload.audit) if (!audited.has(page + violation.rule)) audited.set(page + violation.rule, { page, ...violation });
  }
  const accessibility_audit = [...audited].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, row]) => row);
  const scanned = new Set(scans.filter(({ e }) => e.payload.error === null).map(({ page }) => page));
  const unscanned = new Set(scans.map(({ page }) => page).filter((page) => !scanned.has(page)));
  const perceiving = new Map(ofType(ours, 'persona.episode_started').flatMap((e) => (e.payload.perception ? [[e.persona_id, e.payload.perception] as const] : [])));
  const seeing = [...perceiving.values()].filter((perception) => perception !== 'screen_reader').length;
  const reading = perceiving.size - seeing;
  const discarded = ofType(events, 'social.discarded');
  const runNotes = [
    // A text-only navigator model gets no images (llm/gateway.ts), whatever the setting says.
    ...(webPois(pois).length && settings && (!settings.screenshots || !readsImages(settings.routing.navigator)) ? ['The navigator saw each page as text only, without screenshots, so problems only visible on screen (layout, contrast, images) could not be noticed.'] : []),
    ...(discarded.length ? [`The run stopped in round ${discarded[0].round} before applying ${discarded.length} paid social answer${discarded.length === 1 ? '' : 's'}, so the feed and opinions miss ${discarded.length === 1 ? 'it' : 'them'}.`] : []),
    ...(settings && [...analysis.themes, ...(analysis.set_aside ?? [])].some((t) => t.check) && !readsImages(settings.check_model ?? settings.routing.judge) ? ['The evidence check read text only, because its model takes no images, so it could not see what the pages looked like.'] : []),
    ...(unscanned.size ? [`The accessibility scan failed on ${unscanned.size === 1 ? '1 page' : `${unscanned.size} pages`}, so nothing is known about ${unscanned.size === 1 ? 'it' : 'them'} from the scan.`] : []),
    ...(seeing ? [`${seeing === 1 ? '1 persona' : `${seeing} personas`} browsed with simulated colour-blind or blurred vision, so the screenshots stored for them, here and in the inspector, show that rather than the page as designed.`] : []),
    ...(reading ? [`${reading === 1 ? '1 screen-reader persona' : `${reading} screen-reader personas`} got the page as text without screenshots, so a screenshot stored for them is what the page looked like, not what they perceived.`] : []),
  ];

  return {
    ...(comparison ? { comparison } : {}),
    run_id: started.run_id,
    ...(config.repeat ? { repeat: config.repeat } : {}),
    status,
    stop_reason,
    goal: config.project.goal,
    pois: pois.map((poi) => ({ id: poi.id, type: poi.type, name: poi.name, start_url: poi.type === 'web' ? poi.start_url : null, ...(poi.type === 'web' && poi.mode === 'observe_only' ? { competitor: true as const } : {}) })),
    personas,
    personas_fingerprint: createHash('sha256').update(JSON.stringify(population.toSorted((a, b) => a.id.localeCompare(b.id)))).digest('hex').slice(0, 16),
    ...(dimensions ? { dimensions } : {}),
    segments,
    weighted: { completion: weighted((s) => s.completion), with_friction: weighted((s) => s.with_friction) },
    steps: ofType(events, 'persona.step').length,
    frictions,
    themes: analysis.themes,
    ...(analysis.set_aside ? { set_aside: analysis.set_aside } : {}),
    reach: analysis.reach,
    ...(coverage.length > 0 ? { coverage } : {}),
    sentiment: competitors.size ? sentimentBySegment(ours, ctx) : analysis.sentiment,
    went_well: competitors.size ? wentWell(ours, ctx) : analysis.went_well,
    ...(comparisons.length ? { comparisons } : {}),
    ...(social ? { spread: buildSpread(events, ctx, analysis.themes, analysis.tagged ?? new Map(), new Map(pois.map((poi) => [poi.id, poi.name])), analysis.set_aside) } : {}),
    ...(buyers.length > 0 ? { buyers } : {}),
    ...(flows.length > 0 ? { flows } : {}),
    ...foldStudy(events, analysis.themes, analysis.set_aside ?? [], competitors),
    cost_usd: total((e) => e.payload.cost_usd),
    unreported_usage_calls: calls.filter((e) => e.payload.usage_reported === false).length,
    llm_calls: calls.length,
    // llm.call keeps Anthropic's split: input_tokens is uncached input only.
    input_tokens: total((e) => e.payload.input_tokens + e.payload.cache_read_tokens + e.payload.cache_write_tokens),
    output_tokens: total((e) => e.payload.output_tokens),
    started_at: started.ts,
    ended_at: endedAt,
    duration_ms: endedAt === null ? null : endedAt - started.ts,
    banner: HYPOTHESIS_BANNER,
    methods: {
      seed: audience?.seed ?? config.seed,
      roles,
      models,
      ...(Object.keys(response_models).length ? { response_models } : {}),
      ...(checkCall ? { check_model: { provider: checkCall.provider as ProviderId, model: checkCall.model } } : {}),
      // Runs before M2 ran one persona at a time and kept the cost budget at the top level.
      // shortcut: runs before M2 had no wall-clock budget; the default is shown so the field has a value
      budgets: {
        cost_usd: settings?.cost_budget_usd ?? config.cost_budget_usd ?? DEFAULT_SETTINGS.cost_budget_usd,
        wall_clock_min: settings?.wall_clock_budget_min ?? DEFAULT_SETTINGS.wall_clock_budget_min,
        concurrency: settings?.concurrency ?? 1,
      },
      allowed_hosts,
      blocked_requests,
      blocked: ofType(events, 'persona.blocked').map((b) => {
        const persona_id = b.persona_id ?? '';
        return {
          persona_id,
          step_no: b.payload.step_no,
          reason: b.payload.reason,
          detail: b.payload.detail,
          resumed: resumedAfter(eventsOf(persona_id), b),
        };
      }),
      tripwires: ofType(events, 'containment.tripwire').map((e) => ({ kind: e.payload.kind, detail: e.payload.detail })),
      reset: ofType(events, 'run.reset_called').at(0)?.payload ?? null,
      concurrency_changes: ofType(events, 'run.concurrency_changed').map((e) => ({
        concurrency: e.payload.concurrency,
        reason: e.payload.reason,
      })),
      signal_thresholds: config.signals ?? null,
      ...(undersized_targets.length ? { undersized_targets } : {}),
      ...(accessibility_audit.length ? { accessibility_audit } : {}),
      ...(grounding.length ? { grounding } : {}),
      ...(prior ? { prior: { run_id: prior.run_id, fresh: population.filter((p) => !prior.memories[p.id]).length } } : {}),
      limitations: comparison ? comparison.limitations : [...analysis.limitations, ...runNotes],
      ...(social ? { homogeneity: homogeneity(events, population) } : {}),
    },
  };
}
