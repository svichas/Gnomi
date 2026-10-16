import { webPois, withPois, type SavedProject } from '../poi/pois.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { isAttributeEnabled } from '../profile/schema.ts';
import { buildDimensions, reportAttributes } from './dimensions.ts';
import { buildSpread, homogeneity } from './spread.ts';
import { buyerResults } from './buyers.ts';
import { stepEvidence } from './friction.ts';
import { analyseFrictions, type Context } from './themes.ts';
import type {
  Audience,
  EventOf,
  EventPayloads,
  EventType,
  GnomiEvent,
  Outcome,
  Persona,
  ProjectConfig,
  ProviderId,
  Report,
  ReportFriction,
  ReportPersona,
  ReportSegment,
  Routing,
  RunConfig,
  SessionInfo,
} from '../types.ts';

export const HYPOTHESIS_BANNER =
  'These findings come from simulated users. Treat them as hypotheses and validate the top items with real users before committing to changes.';

const OUTCOMES: Outcome[] = ['done', 'abandoned', 'budget_exceeded', 'repeated_failure', 'blocked', 'incomplete'];

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

// A start_url that does not parse contributes no host, so it cannot hide the rest of the report.
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const rate = (count: number, total: number) => (total === 0 ? 0 : count / total);

const stepKey = (persona_id: string, step_no: number) => JSON.stringify([persona_id, step_no]);

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
    ending = {
      outcome: 'repeated_failure',
      outcome_text: `The same ${stuck.payload.action} failed three times in a row (${stuck.payload.error})`,
    };
  }
  if (abandoned) ending = { outcome: 'abandoned', outcome_text: abandoned.payload.reason };
  if (goalDone) ending = { outcome: 'done', outcome_text: goalDone.payload.summary };
  return ending;
}

function segmentOf(id: string | null, name: string, share: number, members: ReportPersona[]): ReportSegment {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  for (const p of members) outcomes[p.outcome] += 1;
  return {
    id,
    name,
    share,
    personas: members.length,
    outcomes,
    completion: rate(outcomes.done, members.length),
    with_friction: rate(members.filter((p) => p.frictions > 0).length, members.length),
    frictions: members.reduce((sum, p) => sum + p.frictions, 0),
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
  const { pois } = withPois(config.project);

  const byPersona = new Map<string, GnomiEvent[]>();
  for (const e of events) {
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

  const personas: ReportPersona[] = population.map((p) => {
    const own = eventsOf(p.id);
    return {
      id: p.id,
      name: p.name,
      ...(!schema || isAttributeEnabled(schema, 'job_title', 'all') ? { job_title: p.job_title } : {}),
      segment_id: p.segment_id ?? null, // runs before M2 have no segment
      device: p.device,
      ...endingOf(own),
      steps: ofType(own, 'persona.step').length,
      frictions: ofType(own, 'persona.friction_reported').length,
      ...(schema ? { attributes: reportAttributes(p, schema) } : {}),
    };
  });

  // Step numbers repeat across personas, so a friction finds its step by persona and step number together.
  const stepByKey = new Map<string, EventPayloads['persona.step']>();
  for (const e of ofType(events, 'persona.step')) stepByKey.set(stepKey(e.persona_id ?? '', e.payload.step_no), e.payload);
  const frictions: ReportFriction[] = ofType(events, 'persona.friction_reported').map((e) => {
    const persona_id = e.persona_id ?? '';
    const persona = personaById.get(persona_id);
    const step = stepByKey.get(stepKey(persona_id, e.payload.step_no));
    return {
      seq: e.seq,
      persona_id,
      persona_name: persona?.name ?? persona_id,
      segment_id: persona?.segment_id ?? null,
      step_no: e.payload.step_no,
      severity: e.payload.severity,
      what: e.payload.what,
      expected: e.payload.expected,
      url: e.payload.where.url,
      quote: step?.thought ?? '',
      screenshot: step?.screenshot ?? null,
      ...stepEvidence(e.payload, step),
    };
  });

  // Segments with no personas in this run are left out; a run without an audience has one built-in segment.
  const segments: ReportSegment[] = audience
    ? audience.segments.flatMap((s) => {
        const members = personas.filter((p) => p.segment_id === s.id);
        return members.length > 0 ? [segmentOf(s.id, s.name, s.share, members)] : [];
      })
    : [segmentOf(null, 'Built-in persona', 100, personas)];

  // Each segment counts by its share; the shares are renormalised over the segments that have personas.
  const weight = segments.reduce((sum, s) => sum + s.share, 0);
  const weighted = (pick: (s: ReportSegment) => number) =>
    weight === 0 ? 0 : segments.reduce((sum, s) => sum + s.share * pick(s), 0) / weight;

  const ctx: Context = {
    poi_id: pois[0]?.id ?? '',
    personas: new Map(personas.map((p) => [p.id, { name: p.name, segment_id: p.segment_id }])),
    segments,
  };
  const analysis = analyseFrictions(events, ctx);
  // Only runs with social rounds get the spread section and the homogeneity guard; other reports stay as they were.
  const social = events.some((e) => e.type === 'social.post');
  const buyers = buyerResults(events, pois, ctx);

  const inUse = audience ? audience.segments.filter((s) => segments.some((seg) => seg.id === s.id)) : [];
  const roleOfUse = audience ? inUse.map((s) => s.role) : [config.project.role ?? config.session?.role ?? null];
  const roles = [...new Set(roleOfUse)].filter((role): role is string => role !== null);

  const calls = ofType(events, 'llm.call');
  const latestFeeling = new Map<string, number>();
  for (const event of ofType(events, 'persona.step')) {
    // Invalid output steps carry a synthetic zero; it is not the persona reporting a neutral feeling.
    if (event.persona_id && event.payload.result.error !== 'invalid_output') latestFeeling.set(event.persona_id, event.payload.feeling);
  }
  const total = (pick: (e: EventOf<'llm.call'>) => number) => calls.reduce((sum, e) => sum + pick(e), 0);
  // Runs before M2 have no routing, so the call itself names the model it used.
  const routing: Routing | null = settings?.routing ?? null;
  const models: Partial<Routing> = {};
  for (const call of calls) {
    const { role, provider, model } = call.payload;
    models[role] ??= routing?.[role] ?? { provider: provider as ProviderId, model };
  }

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

  const perHost = new Map<string, number>();
  for (const e of ofType(events, 'containment.blocked_request')) {
    perHost.set(e.payload.host, (perHost.get(e.payload.host) ?? 0) + 1);
  }
  // Ties sort A to Z by host, so the same log always gives the same appendix.
  const blocked_requests = [...perHost]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || (a.host < b.host ? -1 : 1));
  // Each web POI's start page host comes first and is always allowed.
  const hosts = webPois(pois).flatMap((poi) => [hostOf(poi.start_url), ...poi.allowed_hosts]);
  const allowed_hosts = [...new Set(hosts)].filter(Boolean);

  return {
    run_id: started.run_id,
    status,
    stop_reason,
    goal: config.project.goal,
    pois: pois.map((poi) => ({ id: poi.id, type: poi.type, name: poi.name, start_url: poi.type === 'web' ? poi.start_url : null })),
    personas,
    ...(schema ? { dimensions: buildDimensions(population, personas, latestFeeling, schema) } : {}),
    segments,
    weighted: { completion: weighted((s) => s.completion), with_friction: weighted((s) => s.with_friction) },
    steps: ofType(events, 'persona.step').length,
    frictions,
    themes: analysis.themes,
    sentiment: analysis.sentiment,
    went_well: analysis.went_well,
    ...(social ? { spread: buildSpread(events, ctx, analysis.themes, analysis.tagged ?? new Map(), new Map(pois.map((poi) => [poi.id, poi.name]))) } : {}),
    ...(buyers.length > 0 ? { buyers } : {}),
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
      limitations: analysis.limitations,
      ...(social ? { homogeneity: homogeneity(events, population) } : {}),
    },
  };
}
