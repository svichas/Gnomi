import type { EventOf, EventType, GnomiEvent, Report, ReportFriction } from '../types.ts';

export const HYPOTHESIS_BANNER =
  'These findings come from simulated users. Treat them as hypotheses and validate the top items with real users before committing to changes.';

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

// A pure fold over one run's events in seq order: the report is only ever made this way (tech.md §5.1).
export function buildReport(events: GnomiEvent[]): Report {
  const started = ofType(events, 'run.started').at(0);
  if (!started) throw new Error('Cannot build a report: the run has no run.started event');
  const { config } = started.payload;

  // A friction may be logged before or after its step, so index every step before pairing them.
  const steps = ofType(events, 'persona.step');
  const stepByNo = new Map(steps.map((e) => [e.payload.step_no, e.payload] as const));
  const frictions: ReportFriction[] = ofType(events, 'persona.friction_reported').map((e) => {
    const step = stepByNo.get(e.payload.step_no);
    return {
      seq: e.seq,
      step_no: e.payload.step_no,
      severity: e.payload.severity,
      what: e.payload.what,
      expected: e.payload.expected,
      url: e.payload.where.url,
      quote: step?.thought ?? '',
      screenshot: step?.screenshot ?? null,
    };
  });

  const goalDone = ofType(events, 'persona.goal_done').at(0);
  const abandoned = ofType(events, 'persona.abandoned').at(0);
  const stuck = ofType(events, 'signal.repeated_failure').at(0);
  const budget = ofType(events, 'signal.budget_exceeded').at(0);
  const blocks = ofType(events, 'persona.blocked');
  const resumes = ofType(events, 'persona.resumed');
  // A block is resumed when the same persona resumed after it.
  const resumed = (block: EventOf<'persona.blocked'>) =>
    resumes.some((r) => r.persona_id === block.persona_id && r.seq > block.seq);
  const lastBlock = blocks.at(-1);

  // Lowest priority first, so each later match overrides an earlier one.
  let ending: Pick<Report, 'outcome' | 'outcome_text'> = { outcome: 'incomplete', outcome_text: null };
  if (budget) ending = { outcome: 'budget_exceeded', outcome_text: null };
  if (lastBlock && !resumed(lastBlock)) ending = { outcome: 'blocked', outcome_text: lastBlock.payload.detail };
  if (stuck) {
    ending = {
      outcome: 'repeated_failure',
      outcome_text: `The same ${stuck.payload.action} failed three times in a row (${stuck.payload.error})`,
    };
  }
  if (abandoned) ending = { outcome: 'abandoned', outcome_text: abandoned.payload.reason };
  if (goalDone) ending = { outcome: 'done', outcome_text: goalDone.payload.summary };

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

  const calls = ofType(events, 'llm.call');
  const total = (pick: (e: EventOf<'llm.call'>) => number) => calls.reduce((sum, e) => sum + pick(e), 0);
  const endedAt = end?.ts ?? null;

  const perHost = new Map<string, number>();
  for (const e of ofType(events, 'containment.blocked_request')) {
    perHost.set(e.payload.host, (perHost.get(e.payload.host) ?? 0) + 1);
  }
  // Ties sort A to Z by host, so the same log always gives the same appendix.
  const blocked_requests = [...perHost]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || (a.host < b.host ? -1 : 1));
  // The start page's host comes first and is always allowed; runs logged before M1 have no allowed_hosts.
  const hosts = [hostOf(config.project.poi.start_url), ...(config.project.poi.allowed_hosts ?? [])];
  const allowed_hosts = [...new Set(hosts)].filter(Boolean);

  return {
    run_id: started.run_id,
    status,
    stop_reason,
    goal: config.project.goal,
    poi: { name: config.project.poi.name, start_url: config.project.poi.start_url },
    persona: {
      id: config.persona.id,
      name: config.persona.name,
      job_title: config.persona.job_title,
      device: config.persona.device,
    },
    ...ending,
    steps: steps.length,
    frictions,
    cost_usd: total((e) => e.payload.cost_usd),
    llm_calls: calls.length,
    // llm.call keeps Anthropic's split: input_tokens is uncached input only.
    input_tokens: total((e) => e.payload.input_tokens + e.payload.cache_read_tokens + e.payload.cache_write_tokens),
    output_tokens: total((e) => e.payload.output_tokens),
    started_at: started.ts,
    ended_at: endedAt,
    duration_ms: endedAt === null ? null : endedAt - started.ts,
    banner: HYPOTHESIS_BANNER,
    methods: {
      role: config.session?.role ?? config.project.role ?? null,
      allowed_hosts,
      blocked_requests,
      blocked: blocks.map((b) => ({
        step_no: b.payload.step_no,
        reason: b.payload.reason,
        detail: b.payload.detail,
        resumed: resumed(b),
      })),
      tripwires: ofType(events, 'containment.tripwire').map((e) => ({ kind: e.payload.kind, detail: e.payload.detail })),
      reset: ofType(events, 'run.reset_called').at(0)?.payload ?? null,
    },
  };
}
