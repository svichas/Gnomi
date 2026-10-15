import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { GYM_V1_DEFECT_IDS, startGym } from '../../../gym/server.ts';
import { launchBrowserPool } from '../browser/pool.ts';
import { createGateway } from '../llm/gateway.ts';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, DEMO_SCRIPT, DEMO_SOCIALISER, DEMO_SURVEY } from '../llm/scripted.ts';
import { createFsBlobStore } from '../log/blobs.ts';
import { openProject } from '../log/sqlite.ts';
import { buildReport } from '../report/build.ts';
import { reportToMarkdown } from '../report/markdown.ts';
import { createRecorder, newRunConfig, startRun, type RunHandle } from '../run.ts';
import type { BrowserPool, LlmGateway, Recorder, Responder } from '../seams.ts';
import type { GnomiEvent, LlmRole, Opinion, PageSnapshot, ProviderId } from '../types.ts';
import { assess, BILLING_CAVEAT, createAllowance, executionCriterion, observeAttempt, validateOptions, type Criterion, type Facts, type Options, type Status } from './checks.ts';
import { complaint, fixture, FIXTURE_VERSION, germanProbe, M4_SEEDS, SEED, type Fixture } from './fixture.ts';
import { AUDIT_SIZE, auditCriterion, auditItems, FRAME_RATE, replayCriterion, spreadCriterion, spreadOf, type AuditItem, type SeedLog, type Spread } from './social.ts';

const json = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const SCOPE = 'Browsing only: seeded traits and authored fixture prose; no live persona writing or writer quality evaluation.';
const M4_SCOPE = 'Social swarm: one injected complaint over five run seeds of the frozen population, spread by segment, an influence audit sheet and scrubber replay from the reopened log. Graph frame rate is measured by the swarm graph check.';
type Allowance = ReturnType<typeof createAllowance>;
interface CaseResult { id: string; criteria: Criterion[]; facts?: Facts; project?: string; skipped?: string }

function scriptedNavigator(): Responder {
  const calls = new Map<string, number>();
  return (request) => {
    if (request.purpose === 'survey') return DEMO_SURVEY;
    const key = request.persona_id ?? '';
    const index = calls.get(key) ?? 0;
    calls.set(key, index + 1);
    const answer = DEMO_SCRIPT[Math.min(index, DEMO_SCRIPT.length - 1)];
    return typeof answer === 'function' ? answer(request) : answer;
  };
}

/** Counts real open contexts, including the period before a persona's first event. */
function measuredPool(pool: BrowserPool, observe: (snapshot: PageSnapshot) => void) {
  let open = 0;
  let peak = 0;
  const browsers: BrowserPool = {
    ...pool,
    async newPage(options) {
      const page = await pool.newPage(options);
      peak = Math.max(peak, ++open);
      let closed = false;
      return {
        ...page,
        async snapshot() { const snapshot = await page.snapshot(); observe(snapshot); return snapshot; },
        async close() { try { await page.close(); } finally { if (!closed) { closed = true; open--; } } },
      };
    },
  };
  return { browsers, peak: () => peak };
}

function reviewSheet(dir: string, id: string, data: Fixture, events: GnomiEvent[], live: boolean) {
  const items = data.personas.map((persona, index) => ({
    persona_id: persona.id, profile: `fixture.json#/personas/${index}`, verdict: null, notes: '',
    steps: events.flatMap((event) => event.type === 'persona.step' && event.persona_id === persona.id ? [{
      seq: event.seq, step_no: event.payload.step_no, thought: event.payload.thought, action: event.payload.action,
      result: event.payload.result, screenshot: event.payload.screenshot ? `project/${event.payload.screenshot}` : null,
    }] : []),
  }));
  json(join(dir, 'review.json'), { status: live ? 'REVIEW_NEEDED' : 'NOT_RUN', case: id, items });
  const lines = [
    `# ${id}: evidence review`, '',
    live ? 'Review required. These are live provider outputs; no language or profile-quality verdict has been inferred.' : 'Scripted fixture. This checks evidence delivery only and cannot establish live language or profile quality.', '',
    'Read the frozen [profiles](fixture.json), [events](events.json), [transcripts](transcripts.json), and [editable review sheet](review.json). Review every recorded thought/action for the selected criterion; record pass/fail, explanatory notes, and step sequence references. Do not count empty or invalid-output thoughts as language evidence.', '',
    id === 'german-locale'
      ? 'German criterion: nonempty thoughts should be naturally German; proper names, quoted interface text and code may retain their original form. Compare the [browser evidence](browser-evidence.json) separately. A German browser locale alone does not establish German thoughts.'
      : 'Profile adherence: check explicit contradictions of frozen facts, primary thought language, and goal; compare concrete behavior with the declared patience/tech-skill constraints. Do not infer demographic stereotypes or demand that every trait be mentioned. This fixture does not evaluate live persona writing.', '',
    ...items.flatMap((item) => [
      `## ${item.persona_id}`, '', `Profile: fixture.json, persona ${item.persona_id}. Verdict: unreviewed.`, '',
      ...item.steps.map((step) => `- Event ${step.seq}, step ${step.step_no}: ${step.thought.replaceAll('\n', ' ')}${step.screenshot ? ` ([screenshot](${step.screenshot}))` : ''}`), '',
    ]),
  ];
  writeFileSync(join(dir, 'review.md'), `${lines.join('\n')}\n`);
}

/** Explicit live mode is the only path that constructs a paid gateway; every call is checked and counted against the shared allowance. */
function guardedGateway(options: Options, allowance: Allowance, env: Record<string, string | undefined>, dir: string, record: Recorder, scripted: Partial<Record<LlmRole, Responder>>, throttle: (provider: ProviderId) => void): LlmGateway {
  const actual = options.mode === 'live'
    ? createGateway({ secrets: { get: (name) => name === 'anthropic_api_key' ? env.ANTHROPIC_API_KEY!.trim() : null }, localBaseUrl: null, record, onThrottle: throttle })
    : createScriptedGateway(scripted, record);
  return {
    call(req) {
      allowance.check();
      return actual.call({ ...req, signal: req.signal ? AbortSignal.any([req.signal, allowance.signal]) : allowance.signal, onAttempt(attempt) {
        observeAttempt(attempt, req.onAttempt, options.mode === 'live' ? allowance : null, (value) => appendFileSync(join(dir, 'attempts.jsonl'), `${JSON.stringify(value)}\n`));
      } });
    },
  };
}

/** Source, lockfile, price-table and runtime identity for a manifest; the price table is copied beside it. */
function provenance(out: string) {
  const source = resolve(import.meta.dirname, '../../..');
  const prices = readFileSync(join(source, 'engine/src/llm/prices.ts'), 'utf8');
  copyFileSync(join(source, 'engine/src/llm/prices.ts'), join(out, 'price-table.ts'));
  let revision = 'unknown';
  let dirty: boolean | null = null;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* a source archive may have no Git metadata */ }
  try { dirty = execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0; } catch { /* source archive */ }
  const sourceFiles = readdirSync(join(source, 'engine/src'), { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts')).map((file) => `engine/src/${file}`).concat(['gym/server.ts', 'engine/package.json']).sort();
  return {
    revision, dirty, source_sha256: hash(JSON.stringify(sourceFiles.map((file) => [file, hash(readFileSync(join(source, file)))]))),
    package_lock_sha256: hash(readFileSync(join(source, 'package-lock.json'))),
    price_table: { file: 'price-table.ts', sha256: hash(prices), source_checked_date: /const CHECKED = '([^']+)'/.exec(prices)?.[1] ?? 'unknown', model_availability: 'Unverified; no model-list probe is performed. Costs use the repository price table, not a provider invoice.' },
    runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cpu_count: cpus().length },
  };
}

async function runCase(id: string, data: Fixture, options: Options, pool: BrowserPool, allowance: Allowance, env: Record<string, string | undefined>): Promise<CaseResult> {
  const dir = join(options.out, id);
  mkdirSync(dir);
  json(join(dir, 'fixture.json'), data);
  const projectDir = join(dir, 'project');
  const store = openProject(projectDir);
  const browserEvidence: PageSnapshot[] = [];
  const measured = measuredPool(pool, (snapshot) => { if (id === 'german-locale') browserEvidence.push(snapshot); });
  let run: RunHandle | undefined;
  const cancel = () => run?.stop();
  allowance.signal.addEventListener('abort', cancel, { once: true });
  try {
    const record = createRecorder(store, () => {});
    const llm = guardedGateway(options, allowance, env, dir, record, { navigator: id === 'german-locale' ? (request) => request.purpose === 'survey' ? DEMO_SURVEY : ({
      thought: 'Dies ist ein geskripteter Test: Die Seite zeigt Deutsch und die Berliner Zeitzone.', feeling: 0,
      action: { type: 'done', ref: null, text: 'Geskriptete Prüfung beendet.' }, friction: null,
    }) : scriptedNavigator() }, (provider) => run?.throttle(provider));
    const project = structuredClone(data.project);
    if (options.mode === 'live') project.settings.cost_budget_usd = Math.min(project.settings.cost_budget_usd, options.allowance_usd! - allowance.spent());
    store.saveProject(project);
    store.replacePersonas(data.personas);
    const config = store.createRun({ ...newRunConfig(project, { personas: data.personas, sessions: [], reset: false }), seed: SEED, pause_timeout_ms: 0 });
    const started = performance.now();
    run = startRun(config, { store, blobs: createFsBlobStore(projectDir), browsers: measured.browsers, llm, record, sessions: null });
    const report = await run.done;
    const duration_ms = Math.round(performance.now() - started);
    const events = store.events(config.run_id);
    const reopened = openProject(projectDir);
    let replay_equal: boolean;
    try { replay_equal = isDeepStrictEqual(buildReport(reopened.events(config.run_id)), report); } finally { reopened.close(); }
    const calls = events.filter((event) => event.type === 'llm.call');
    const facts: Facts = {
      population: report.personas.length, terminal: report.personas.filter((p) => p.outcome !== 'incomplete').length,
      goal_completed: report.personas.filter((p) => p.outcome === 'done').length, blocked: report.personas.filter((p) => p.outcome === 'blocked').length,
      run_status: report.status, duration_ms, cost_usd: report.cost_usd, unknown_usage: calls.filter((event) => event.payload.usage_reported !== true).length,
      peak_contexts: measured.peak(), replay_equal,
    };
    json(join(dir, 'events.json'), events);
    json(join(dir, 'transcripts.json'), store.transcripts(config.run_id).map((entry) => ({ seq: entry.seq, request: JSON.parse(entry.request_json), response: JSON.parse(entry.response_json) })));
    json(join(dir, 'browser-evidence.json'), browserEvidence);
    json(join(dir, 'metrics.json'), { ...facts, setup_cost_usd: 0, steps: report.steps, calls: calls.length, input_tokens: report.input_tokens, output_tokens: report.output_tokens, outcomes: report.personas.map((p) => ({ id: p.id, outcome: p.outcome })), concurrency_changes: report.methods.concurrency_changes, attempts_without_usage: calls.filter((e) => e.payload.usage_reported !== true).map((e) => e.seq) });
    writeFileSync(join(dir, 'report.md'), reportToMarkdown(report));
    reviewSheet(dir, id, data, events, options.mode === 'live');
    const echo = browserEvidence.some((snapshot) => /Accept-Language: de-DE(?:,|;|["\n])/.test(snapshot.text) && /Browser locale: de-DE/.test(snapshot.text) && /Browser languages: de-DE, en/.test(snapshot.text) && /Browser timezone: Europe\/Berlin/.test(snapshot.text));
    const thoughts = events.filter((event) => event.type === 'persona.step' && event.payload.result.error !== 'invalid_output' && event.payload.thought.trim());
    const criteria: Criterion[] = id === 'population50' ? assess(options.mode, facts) : [
      executionCriterion(facts, 1),
      { id: 'german_browser', status: echo ? 'PASS' : 'FAIL', live_required: false, detail: 'Actual Gym snapshot must show de-DE locale, German-first HTTP/navigator languages and Europe/Berlin timezone.' },
      { id: 'native_german_thoughts', status: options.mode !== 'live' ? 'NOT_RUN' : thoughts.length ? 'REVIEW_NEEDED' : 'FAIL', live_required: true, detail: `${thoughts.length} nonempty valid thoughts; review.md links their source evidence.` },
      { id: 'locale_replay', status: replay_equal ? 'PASS' : 'FAIL', live_required: false, detail: 'Reopened event-log report equality.' },
    ];
    return { id, project: `${id}/project`, facts, criteria };
  } finally {
    allowance.signal.removeEventListener('abort', cancel);
    store.close();
  }
}

/** Explicit live mode is the only path that constructs a paid gateway; preflight happens before Gym/browser startup. */
export async function runAcceptance(options: Options, env: Record<string, string | undefined> = process.env) {
  validateOptions(options, env);
  if (existsSync(options.out)) throw new Error(`Acceptance output already exists: ${options.out}. Choose a fresh --out directory.`);
  mkdirSync(dirname(options.out), { recursive: true });
  mkdirSync(options.out);
  const source = provenance(options.out);
  const allowance = createAllowance(options.allowance_usd ?? Infinity);
  const cases: CaseResult[] = [];
  let error: string | null = null;
  let pool: BrowserPool | undefined;
  let gym: Awaited<ReturnType<typeof startGym>> | undefined;
  const started = Date.now();
  let fixture_preparation_ms = 0;
  try {
    gym = await startGym({ port: 0, defects: 'v1' }); // Gym v1, the M2 set; keep the real 4-second D09 delay
    const fixtureStart = performance.now();
    const base = fixture(gym.url);
    fixture_preparation_ms = Math.round(performance.now() - fixtureStart);
    json(join(options.out, 'manifest.json'), {
      version: 1, mode: options.mode, scope: SCOPE, seed: SEED, fixture_version: FIXTURE_VERSION,
      fixture_sha256: hash(JSON.stringify({ personas: base.personas, audience: base.project.audience, schema: base.project.persona_schema })),
      routing: base.project.settings.routing, settings: base.project.settings, setup_cost_usd: 0,
      recorded_spend_allowance_usd: options.allowance_usd ?? null, billing_caveat: BILLING_CAVEAT,
      gym: { defects: GYM_V1_DEFECT_IDS, candidates_delay_ms: 4000, login: false }, ...source, started_at: new Date(started).toISOString(),
    });
    pool = await launchBrowserPool();
    for (const [id, data] of [['population50', base], ['german-locale', germanProbe(base)]] as const) {
      if (allowance.signal.aborted) {
        cases.push({ id, skipped: 'The shared allowance stopped further work.', criteria: [{ id, status: 'NOT_RUN', live_required: true, detail: 'No new provider calls were dispatched for this case.' }] });
        continue;
      }
      cases.push(await runCase(id, data, options, pool, allowance, env));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    await pool?.close().catch(() => {});
    await gym?.close();
  }
  const status: Status = error || cases.some((result) => result.criteria.some((check) => check.status === 'FAIL')) ? 'FAIL' : options.mode === 'scripted' ? 'NOT_RUN' : 'REVIEW_NEEDED';
  const run_duration_ms = cases.reduce((sum, result) => sum + (result.facts?.duration_ms ?? 0), 0);
  const elapsed_ms = Date.now() - started;
  const result = { status, mode: options.mode, scope: SCOPE, cases, error, setup_cost_usd: 0, live_writer_duration_ms: 0, fixture_preparation_ms,
    recorded_cost_usd: allowance.spent(), completed_case_recorded_cost_usd: cases.reduce((sum, result) => sum + (result.facts?.cost_usd ?? 0), 0),
    missing_usage_attempts: allowance.unknown(), allowance_stop_reason: allowance.signal.aborted ? (allowance.signal.reason instanceof Error ? allowance.signal.reason.message : String(allowance.signal.reason)) : null,
    run_duration_ms, overhead_duration_ms: elapsed_ms - run_duration_ms, elapsed_ms, billing_caveat: BILLING_CAVEAT };
  json(join(options.out, 'acceptance.json'), result);
  return result;
}

interface SeedRun extends SeedLog { responses: Map<number, unknown>; spread: Spread | null; run_status: string | null; cost_usd: number | null }

async function runSeed(seed: number, data: Fixture, options: Options, pool: BrowserPool, allowance: Allowance, env: Record<string, string | undefined>): Promise<SeedRun> {
  const dir = join(options.out, `seed-${seed}`);
  mkdirSync(dir);
  const projectDir = join(dir, 'project');
  const store = openProject(projectDir);
  let run: RunHandle | undefined;
  const cancel = () => run?.stop();
  allowance.signal.addEventListener('abort', cancel, { once: true });
  try {
    const record = createRecorder(store, () => {});
    const scripted = { navigator: scriptedNavigator(), socialiser: DEMO_SOCIALISER, judge: DEMO_JUDGE, author: DEMO_AUTHOR };
    const llm = guardedGateway(options, allowance, env, dir, record, scripted, (provider) => run?.throttle(provider));
    const project = structuredClone(data.project);
    project.settings.social = true; // the shared fixture leaves social rounds off for M2
    if (options.mode === 'live') project.settings.cost_budget_usd = Math.min(project.settings.cost_budget_usd, options.allowance_usd! - allowance.spent());
    store.saveProject(project);
    store.replacePersonas(data.personas);
    const config = store.createRun({ ...newRunConfig(project, { personas: data.personas, sessions: [], reset: false }), seed, pause_timeout_ms: 0, injected_posts: [complaint(data)] });
    run = startRun(config, { store, blobs: createFsBlobStore(projectDir), browsers: pool, llm, record, sessions: null });
    const report = await run.done;
    const reopened = openProject(projectDir); // every M4 check reads the log alone
    let events: GnomiEvent[];
    let transcripts: { seq: number; request: unknown; response: unknown }[];
    try {
      events = reopened.events(config.run_id);
      transcripts = reopened.transcripts(config.run_id).map((entry) => ({ seq: entry.seq, request: JSON.parse(entry.request_json), response: JSON.parse(entry.response_json) }));
    } finally { reopened.close(); }
    const spread = spreadOf(events);
    json(join(dir, 'events.json'), events);
    json(join(dir, 'transcripts.json'), transcripts);
    json(join(dir, 'spread.json'), spread);
    writeFileSync(join(dir, 'report.md'), reportToMarkdown(report));
    return { seed, events, responses: new Map(transcripts.map((entry) => [entry.seq, entry.response])), spread, run_status: report.status, cost_usd: report.cost_usd };
  } finally {
    allowance.signal.removeEventListener('abort', cancel);
    store.close();
  }
}

function auditSheet(out: string, items: AuditItem[], live: boolean) {
  json(join(out, 'influence-audit.json'), { status: 'NOT_RUN', required: AUDIT_SIZE, sampled: items.length, items });
  const view = (o: Opinion | null) => o ? `sentiment ${o.sentiment}, confidence ${o.confidence}; likes: ${o.likes.join('; ') || 'none'}; frictions: ${o.frictions.join('; ') || 'none'}` : 'no opinion yet';
  const lines = [
    '# Influence audit', '',
    live ? 'Review required. These are live provider outputs; no plausibility verdict has been inferred.' : 'Scripted rehearsal. This checks evidence delivery only and cannot establish that influence is plausible.', '',
    `${items.length} of ${AUDIT_SIZE} edges, sampled by a fixed hash of seed, event and post. For each, judge whether the cited post plausibly explains the change of opinion, and record \`plausible\` or \`implausible\` with notes in [influence-audit.json](influence-audit.json). The criterion passes when at least 80% are plausible.`, '',
    ...items.flatMap((item, i) => [
      `## ${i + 1}. Seed ${item.seed}, round ${item.round}: ${item.from} → ${item.to}`, '',
      `- Cited post ${item.post_id} about ${item.poi_id}: "${item.post_text.replaceAll('\n', ' ')}"`,
      `- Before: ${view(item.before)}`,
      `- After: ${view(item.after)} (change ${item.delta})`,
      `- Evidence: [events](seed-${item.seed}/events.json) event ${item.seq}${item.reasoning ? `, [transcripts](seed-${item.seed}/transcripts.json) llm.call ${item.reasoning.llm_call_seq}` : ''}`, '',
      ...(item.reasoning ? ['```json', JSON.stringify(item.reasoning.response), '```', ''] : ['No socialiser answer precedes this change in the log.', '']),
    ]),
  ];
  writeFileSync(join(out, 'influence-audit.md'), `${lines.join('\n')}\n`);
}

/** M4 mode: the same guards as M2 (explicit allowance for live, fresh output, retained evidence), over five seeded social runs. */
export async function runM4Acceptance(options: Options, env: Record<string, string | undefined> = process.env) {
  validateOptions(options, env);
  if (existsSync(options.out)) throw new Error(`Acceptance output already exists: ${options.out}. Choose a fresh --out directory.`);
  mkdirSync(dirname(options.out), { recursive: true });
  mkdirSync(options.out);
  const source = provenance(options.out);
  const allowance = createAllowance(options.allowance_usd ?? Infinity);
  const runs: SeedRun[] = [];
  let error: string | null = null;
  let pool: BrowserPool | undefined;
  let gym: Awaited<ReturnType<typeof startGym>> | undefined;
  const started = Date.now();
  try {
    gym = await startGym({ port: 0, defects: 'v1' });
    const base = fixture(gym.url);
    json(join(options.out, 'fixture.json'), base);
    json(join(options.out, 'manifest.json'), {
      version: 1, suite: 'm4', mode: options.mode, scope: M4_SCOPE, seeds: M4_SEEDS, injected_post: complaint(base), fixture_version: FIXTURE_VERSION,
      fixture_sha256: hash(JSON.stringify({ personas: base.personas, audience: base.project.audience, schema: base.project.persona_schema })),
      routing: base.project.settings.routing, settings: base.project.settings, setup_cost_usd: 0,
      recorded_spend_allowance_usd: options.allowance_usd ?? null, billing_caveat: BILLING_CAVEAT,
      gym: { defects: GYM_V1_DEFECT_IDS, candidates_delay_ms: 4000, login: false }, ...source, started_at: new Date(started).toISOString(),
    });
    pool = await launchBrowserPool();
    for (const seed of M4_SEEDS) {
      if (allowance.signal.aborted) break; // later seeds stay missing: no new provider calls
      runs.push(await runSeed(seed, base, options, pool, allowance, env));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    await pool?.close().catch(() => {});
    await gym?.close();
  }
  const logs = M4_SEEDS.map((seed): SeedRun => runs.find((run) => run.seed === seed) ?? { seed, events: [], responses: new Map(), spread: null, run_status: null, cost_usd: null });
  const items = auditItems(logs);
  auditSheet(options.out, items, options.mode === 'live');
  const criteria = [spreadCriterion(options.mode, logs.map((run) => run.spread)), auditCriterion(items.length), replayCriterion(logs), FRAME_RATE];
  const status: Status = error || criteria.some((check) => check.status === 'FAIL') ? 'FAIL' : options.mode === 'scripted' ? 'NOT_RUN' : 'REVIEW_NEEDED';
  const result = {
    status, mode: options.mode, scope: M4_SCOPE, criteria, error, setup_cost_usd: 0,
    seeds: logs.map(({ seed, run_status, cost_usd, spread }) => ({ seed, run_status, cost_usd, evidence: run_status ? `seed-${seed}` : null, spread: spread && { same: spread.same, cross: spread.cross, same_population: spread.same_population, cross_population: spread.cross_population } })),
    recorded_cost_usd: allowance.spent(), missing_usage_attempts: allowance.unknown(),
    allowance_stop_reason: allowance.signal.aborted ? (allowance.signal.reason instanceof Error ? allowance.signal.reason.message : String(allowance.signal.reason)) : null,
    elapsed_ms: Date.now() - started, billing_caveat: BILLING_CAVEAT,
  };
  json(join(options.out, 'acceptance.json'), result);
  return result;
}
