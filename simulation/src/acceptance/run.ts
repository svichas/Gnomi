import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { mean } from 'simple-statistics';
import { gymAssets } from '../../../demo/GymSite/assets.ts';
import { DEFECT_IDS, GYM_V1_DEFECT_IDS, startGym } from '../../../demo/GymSite/server.ts';
import { importLocalFile } from '../assets.ts';
import { fnv1a, mulberry32 } from '../audience/sample.ts';
import { launchBrowserPool } from '../browser/pool.ts';
import { createGateway } from '../llm/gateway.ts';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, DEMO_NAVIGATOR, DEMO_SCRIPT, DEMO_SOCIALISER, DEMO_SURVEY } from '../llm/scripted.ts';
import { createFsBlobStore } from '../log/blobs.ts';
import { openProject } from '../log/sqlite.ts';
import { preflight } from '../poi/index.ts';
import { buildReport } from '../report/build.ts';
import { reportToMarkdown } from '../report/markdown.ts';
import { createRecorder, newRunConfig, startRun, type RunHandle } from '../run.ts';
import type { BlobStore, BrowserPool, LlmGateway, ProjectStore, Recorder, Responder } from '../seams.ts';
import { PROVIDER_DEFAULTS } from '../settings.ts';
import { graphMetrics } from '../social/graph.ts';
import type { GnomiEvent, LlmRole, Opinion, PageSnapshot, ProviderId, Report, RunSettings } from '../types.ts';
import { ARMS, assess, BILLING_CAVEAT, createAllowance, defectScores, executionCriterion, FULL_POPULATION, KEY_ENV, observeAttempt, pairedDifference, TOP, validateOptions, type Arm, type Criterion, type Facts, type Options, type Status } from './checks.ts';
import { complaint, fixture, FIXTURE_VERSION, generic, germanProbe, gym, M3_SEEDS, M4_SEEDS, M5_SEEDS, SEED, subset, type Fixture } from './fixture.ts';
import { atScale, buyerTextCriterion, controlFrameCriterion, d28Criterion, D26_FRAME, designCase, designSkipped, DESIGN_PERSONAS, FIGMA_LISTING, frameMismatchCriterion, frameMismatches, textCase, type FrameMismatches } from './m5.ts';
import { AUDIT_SIZE, auditCriterion, auditItems, FRAME_RATE, replayCriterion, spreadCriterion, spreadOf, type AuditItem, type SeedLog, type Spread } from './social.ts';

const json = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const SCOPE = 'Browsing only: seeded traits and authored fixture prose; no live persona writing or writer quality evaluation.';
const M4_SCOPE = 'Social swarm: one injected complaint over five run seeds of the frozen population, spread by segment, an influence audit sheet and scrubber replay from the reopened log. Graph frame rate is measured by the swarm graph check.';
type Allowance = ReturnType<typeof createAllowance>;
const CATALOGUE = resolve(import.meta.dirname, '../../../demo/GymSite/defects.yaml');
const stopReason = (allowance: Allowance) => allowance.signal.aborted ? (allowance.signal.reason instanceof Error ? allowance.signal.reason.message : String(allowance.signal.reason)) : null;
/** What a manifest pins of a population: its people, its audience and the profile schema they were written against. */
const fixtureSha = (data: Fixture) => hash(JSON.stringify({ personas: data.personas, audience: data.project.audience, schema: data.project.persona_schema }));
const parsedTranscripts = (store: Pick<ProjectStore, 'transcripts'>, run_id: string) =>
  store.transcripts(run_id).map((entry) => ({ seq: entry.seq, request: JSON.parse(entry.request_json), response: JSON.parse(entry.response_json) }));
interface CaseResult { id: string; criteria: Criterion[]; facts?: Facts; project?: string; skipped?: string }

function scriptedNavigator(): Responder {
  const calls = new Map<string, number>();
  return (request) => {
    if (request.purpose === 'survey') return DEMO_SURVEY;
    if (request.purpose === 'read_text' || request.purpose === 'buyer_survey' || request.purpose === 'design') return DEMO_NAVIGATOR(request); // M5's POIs
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
    ? createGateway({ secrets: { get: (name) => name === `${options.provider}_api_key` ? env[KEY_ENV[options.provider]]!.trim() : null }, localBaseUrl: null, record, onThrottle: throttle })
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

/** The frozen fixture at the requested size, routed to the chosen provider's defaults. */
function prepare(base: Fixture, options: Options, personas = options.personas): Fixture {
  const data = subset(base, personas);
  return { ...data, project: { ...data.project, settings: { ...data.project.settings, routing: structuredClone(PROVIDER_DEFAULTS[options.provider]) } } };
}

/** Source, lockfile, price-table and runtime identity for a manifest; the price table is copied beside it. */
function provenance(out: string) {
  const source = resolve(import.meta.dirname, '../../..');
  const prices = readFileSync(join(source, 'simulation/src/llm/prices.ts'), 'utf8');
  copyFileSync(join(source, 'simulation/src/llm/prices.ts'), join(out, 'price-table.ts'));
  let revision = 'unknown';
  let dirty: boolean | null = null;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* a source archive may have no Git metadata */ }
  try { dirty = execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0; } catch { /* source archive */ }
  const sourceFiles = readdirSync(join(source, 'simulation/src'), { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts')).map((file) => `simulation/src/${file}`).concat(['demo/GymSite/server.ts', 'simulation/package.json']).sort();
  return {
    revision, dirty, source_sha256: hash(JSON.stringify(sourceFiles.map((file) => [file, hash(readFileSync(join(source, file)))]))),
    package_lock_sha256: hash(readFileSync(join(source, 'package-lock.json'))),
    price_table: { file: 'price-table.ts', sha256: hash(prices), source_checked_date: /const CHECKED = '([^']+)'/.exec(prices)?.[1] ?? 'unknown', model_availability: 'Unverified; no model-list probe is performed. Costs use the repository price table, not a provider invoice.' },
    runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cpu_count: cpus().length },
  };
}

/** The suites' shared guards: a live run needs an allowance and a key, and earlier evidence is never overwritten. Returns the provenance. */
function freshOutput(options: Options, env: Record<string, string | undefined>) {
  validateOptions(options, env);
  if (existsSync(options.out)) throw new Error(`Acceptance output already exists: ${options.out}. Choose a fresh --out directory.`);
  mkdirSync(dirname(options.out), { recursive: true });
  mkdirSync(options.out);
  return provenance(options.out);
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
      population: report.personas.length, terminal: report.personas.filter((p) => !['incomplete', 'not_started', 'model_failed'].includes(p.outcome)).length, // not reached, or the model failed: no outcome of the persona's own
      goal_completed: report.personas.filter((p) => p.outcome === 'done').length, blocked: report.personas.filter((p) => p.outcome === 'blocked').length,
      run_status: report.status, duration_ms, cost_usd: report.cost_usd, unknown_usage: calls.filter((event) => event.payload.usage_reported !== true).length,
      peak_contexts: measured.peak(), replay_equal,
    };
    json(join(dir, 'events.json'), events);
    json(join(dir, 'transcripts.json'), parsedTranscripts(store, config.run_id));
    json(join(dir, 'browser-evidence.json'), browserEvidence);
    json(join(dir, 'metrics.json'), { ...facts, setup_cost_usd: 0, steps: report.steps, calls: calls.length, input_tokens: report.input_tokens, output_tokens: report.output_tokens, outcomes: report.personas.map((p) => ({ id: p.id, outcome: p.outcome })), concurrency_changes: report.methods.concurrency_changes, attempts_without_usage: calls.filter((e) => e.payload.usage_reported !== true).map((e) => e.seq) });
    writeFileSync(join(dir, 'report.md'), reportToMarkdown(report));
    reviewSheet(dir, id, data, events, options.mode === 'live');
    const echo = browserEvidence.some((snapshot) => /Accept-Language: de-DE(?:,|;|["\n])/.test(snapshot.text) && /Browser locale: de-DE/.test(snapshot.text) && /Browser languages: de-DE, en/.test(snapshot.text) && /Browser timezone: Europe\/Berlin/.test(snapshot.text));
    const thoughts = events.filter((event) => event.type === 'persona.step' && event.payload.result.error !== 'invalid_output' && event.payload.thought.trim());
    const criteria: Criterion[] = id === 'population50' ? assess(options.mode, facts, data.personas.length) : [
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
  const source = freshOutput(options, env);
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
    const base = prepare(fixture(gym.url), options);
    fixture_preparation_ms = Math.round(performance.now() - fixtureStart);
    json(join(options.out, 'manifest.json'), {
      version: 1, mode: options.mode, scope: SCOPE, seed: SEED, fixture_version: FIXTURE_VERSION, provider: options.provider, personas: base.personas.length,
      fixture_sha256: fixtureSha(base),
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
    missing_usage_attempts: allowance.unknown(), allowance_stop_reason: stopReason(allowance),
    run_duration_ms, overhead_duration_ms: elapsed_ms - run_duration_ms, elapsed_ms, billing_caveat: BILLING_CAVEAT };
  json(join(options.out, 'acceptance.json'), result);
  return result;
}

interface SeedRun extends SeedLog { responses: Map<number, unknown>; spread: Spread | null; run_status: string | null; cost_usd: number | null; report?: Report }

/** One seeded run with its evidence in `<out>/<name>`; social runs get the injected complaint and their spread (M4), others only the report (M3). */
async function runSeed(name: string, seed: number, data: Fixture, options: Options, pool: BrowserPool, allowance: Allowance, env: Record<string, string | undefined>, social: boolean, assets: string[] = []): Promise<SeedRun> {
  const dir = join(options.out, name);
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
    project.settings.social = social; // the shared fixture leaves social rounds off for M2
    if (options.mode === 'live') project.settings.cost_budget_usd = Math.min(project.settings.cost_budget_usd, options.allowance_usd! - allowance.spent());
    store.saveProject(project);
    store.replacePersonas(data.personas);
    const blobs = createFsBlobStore(projectDir);
    for (const path of assets) await importLocalFile(blobs, path); // M5's text and frames: the project's own copies, under the ids its POIs name
    const config = store.createRun({ ...newRunConfig(project, { personas: data.personas, sessions: [], reset: false }), seed, pause_timeout_ms: 0, injected_posts: social ? [complaint(data)] : [] });
    run = startRun(config, { store, blobs, browsers: pool, llm, record, sessions: null });
    const report = await run.done;
    const reopened = openProject(projectDir); // every M4 check reads the log alone
    let events: GnomiEvent[];
    let transcripts: { seq: number; request: unknown; response: unknown }[];
    try {
      events = reopened.events(config.run_id);
      transcripts = parsedTranscripts(reopened, config.run_id);
    } finally { reopened.close(); }
    const spread = social ? spreadOf(events) : null;
    json(join(dir, 'events.json'), events);
    json(join(dir, 'transcripts.json'), transcripts);
    if (social) json(join(dir, 'spread.json'), spread);
    json(join(dir, 'report.json'), report);
    writeFileSync(join(dir, 'report.md'), reportToMarkdown(report));
    return { seed, events, responses: new Map(transcripts.map((entry) => [entry.seq, entry.response])), spread, run_status: report.status, cost_usd: report.cost_usd, report };
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
  const source = freshOutput(options, env);
  const allowance = createAllowance(options.allowance_usd ?? Infinity);
  const runs: SeedRun[] = [];
  let error: string | null = null;
  let pool: BrowserPool | undefined;
  let gym: Awaited<ReturnType<typeof startGym>> | undefined;
  const started = Date.now();
  try {
    gym = await startGym({ port: 0, defects: 'v1' });
    const base = prepare(fixture(gym.url), options);
    json(join(options.out, 'fixture.json'), base);
    json(join(options.out, 'manifest.json'), {
      version: 1, suite: 'm4', mode: options.mode, scope: M4_SCOPE, seeds: M4_SEEDS.slice(0, options.seeds ?? M4_SEEDS.length), provider: options.provider, personas: base.personas.length, injected_post: complaint(base), fixture_version: FIXTURE_VERSION,
      fixture_sha256: fixtureSha(base),
      routing: base.project.settings.routing, settings: base.project.settings, setup_cost_usd: 0,
      recorded_spend_allowance_usd: options.allowance_usd ?? null, billing_caveat: BILLING_CAVEAT,
      gym: { defects: GYM_V1_DEFECT_IDS, candidates_delay_ms: 4000, login: false }, ...source, started_at: new Date(started).toISOString(),
    });
    pool = await launchBrowserPool();
    for (const seed of M4_SEEDS.slice(0, options.seeds ?? M4_SEEDS.length)) { // seeds not run stay missing, so spread cannot pass on fewer than four
      if (allowance.signal.aborted) break; // later seeds stay missing: no new provider calls
      runs.push(await runSeed(`seed-${seed}`, seed, base, options, pool, allowance, env, true));
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
  const spread = spreadCriterion(options.mode, logs.map((run) => run.spread));
  // A small population saturates: with 6–12 follows each, everyone reaches everyone, so segment sizes decide the comparison.
  const scaled = options.personas < FULL_POPULATION ? { ...spread, status: 'NOT_RUN' as const, detail: `Reduced scale (${options.personas} of ${FULL_POPULATION} personas): ${spread.detail}` } : spread;
  const criteria = [scaled, auditCriterion(items.length), replayCriterion(logs), FRAME_RATE];
  const status: Status = error || criteria.some((check) => check.status === 'FAIL') ? 'FAIL' : options.mode === 'scripted' ? 'NOT_RUN' : 'REVIEW_NEEDED';
  const result = {
    status, mode: options.mode, scope: M4_SCOPE, criteria, error, setup_cost_usd: 0,
    seeds: logs.map(({ seed, run_status, cost_usd, spread }) => ({ seed, run_status, cost_usd, evidence: run_status ? `seed-${seed}` : null, spread: spread && { same: spread.same, cross: spread.cross, same_population: spread.same_population, cross_population: spread.cross_population } })),
    recorded_cost_usd: allowance.spent(), missing_usage_attempts: allowance.unknown(),
    allowance_stop_reason: stopReason(allowance),
    elapsed_ms: Date.now() - started, billing_caveat: BILLING_CAVEAT,
  };
  json(join(options.out, 'acceptance.json'), result);
  return result;
}

const M3_SCOPE = 'Friction pipeline: the frozen population on Gym v2 (all 25 defects) over three run seeds, then the same population on the no-defect control build. Themes are mapped to catalogued defects by a reviewer.';

/** Each run's top themes with an empty `defect` for a reviewer to map to the catalogue (or leave null for a false positive). */
function themeSheet(out: string, runs: { name: string; report?: Report }[], live: boolean) {
  const items = runs.flatMap(({ name, report }) => (report?.themes ?? []).filter((theme) => theme.rank <= TOP).map((theme) => ({
    run: name, rank: theme.rank, theme_id: theme.id, title: theme.title, description: theme.description, trust: theme.trust, severity: theme.severity,
    personas: theme.personas, pages: theme.pages, elements: theme.elements, seqs: theme.seqs.length,
    evidence: theme.evidence.map((e) => ({ seq: e.seq, persona: e.persona_name, step_no: e.step_no, url: e.url, what: e.what, quote: e.quote })),
    defect: null as string | null, notes: '',
  })));
  json(join(out, 'theme-mapping.json'), { status: live ? 'REVIEW_NEEDED' : 'NOT_RUN', catalogue: 'defects.yaml', items });
  const lines = [
    '# Theme mapping', '',
    live ? 'Review required. Map each theme to the catalogued defect it describes, or leave `defect` null when it describes none.' : 'Scripted rehearsal. This checks evidence delivery only; scripted frictions do not come from the defects.', '',
    'A theme is a true positive when it maps to a catalogued defect that is switched on (all 25 on Gym v2, none on the control build). A defect is found when a theme with trust confirmed or observed maps to it. Record the mapping in [theme-mapping.json](theme-mapping.json) against [the catalogue](defects.yaml).', '',
    ...items.flatMap((item) => [
      `## ${item.run}, rank ${item.rank}: ${item.title}`, '',
      `Trust ${item.trust}, severity ${item.severity}, ${item.personas} personas, pages ${item.pages.join(', ') || 'none'}. ${item.description}`, '',
      ...item.evidence.map((e) => `- Event ${e.seq} (${e.persona}, step ${e.step_no ?? 'survey'}, ${e.url ?? 'no url'}): ${e.what}. "${e.quote.replaceAll('\n', ' ')}"`), '',
    ]),
  ];
  writeFileSync(join(out, 'theme-mapping.md'), `${lines.join('\n')}\n`);
}

/** M3 mode: seeded Gym v2 runs and a control run with the M2 guards; recall, precision and stability need the reviewed theme mapping. */
export async function runM3Acceptance(options: Options, env: Record<string, string | undefined> = process.env) {
  const source = freshOutput(options, env);
  copyFileSync(CATALOGUE, join(options.out, 'defects.yaml'));
  const allowance = createAllowance(options.allowance_usd ?? Infinity);
  const seeds = M3_SEEDS.slice(0, options.seeds ?? M3_SEEDS.length);
  const runs: { name: string; run?: SeedRun }[] = [...seeds.map((seed) => ({ name: `seed-${seed}` })), { name: 'control' }];
  let error: string | null = null;
  let pool: BrowserPool | undefined;
  const gyms: Awaited<ReturnType<typeof startGym>>[] = [];
  const started = Date.now();
  try {
    const [defects, control] = [await startGym({ port: 0, defects: 'all' }), await startGym({ port: 0, defects: 'none' })];
    gyms.push(defects, control);
    const base = prepare(fixture(defects.url), options);
    gym(base).name = 'Gym v2';
    const controlBase = { ...base, project: { ...base.project, pois: [{ ...gym(base), name: 'Gym control', start_url: `${control.url}/` }] } };
    json(join(options.out, 'fixture.json'), base);
    json(join(options.out, 'manifest.json'), {
      version: 1, suite: 'm3', mode: options.mode, scope: M3_SCOPE, seeds, control_seed: SEED, provider: options.provider, personas: base.personas.length, fixture_version: FIXTURE_VERSION,
      fixture_sha256: fixtureSha(base),
      routing: base.project.settings.routing, settings: base.project.settings, setup_cost_usd: 0,
      recorded_spend_allowance_usd: options.allowance_usd ?? null, billing_caveat: BILLING_CAVEAT,
      gym: { defects: DEFECT_IDS, control: [], catalogue: 'defects.yaml', login: false }, ...source, started_at: new Date(started).toISOString(),
    });
    pool = await launchBrowserPool();
    for (const entry of runs) {
      if (allowance.signal.aborted) break; // later runs stay missing: no new provider calls
      const control = entry.name === 'control';
      entry.run = await runSeed(entry.name, control ? SEED : Number(entry.name.slice(5)), control ? controlBase : base, options, pool, allowance, env, false);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    await pool?.close().catch(() => {});
    for (const gym of gyms) await gym.close();
  }
  const live = options.mode === 'live';
  themeSheet(options.out, runs.map(({ name, run }) => ({ name, report: run?.report })), live);
  const finished = runs.filter((entry) => entry.run?.report?.status === 'finished');
  const control = runs.at(-1)!.run?.report;
  const controlThemes = control?.status === 'finished' ? control.themes ?? [] : null;
  const counts = controlThemes && { confirmed: controlThemes.filter((t) => t.trust === 'confirmed').length, reported: controlThemes.filter((t) => t.trust === 'reported').length };
  const unlinked = finished.flatMap((entry) => (entry.run!.report!.themes ?? []).filter((theme) => !theme.seqs.length || !theme.seqs.every((seq) => entry.run!.events.some((event) => event.seq === seq))).map((theme) => `${entry.name}#${theme.id}`));
  const full = options.personas >= 50 && seeds.length === M3_SEEDS.length;
  const review = (id: string, detail: string): Criterion => ({ id, live_required: true, status: live && full && finished.length === runs.length ? 'REVIEW_NEEDED' : 'NOT_RUN', detail: `${full ? '' : `Reduced scale (${options.personas} of 50 personas, ${seeds.length} of ${M3_SEEDS.length} seeds). `}${detail}` });
  const criteria: Criterion[] = [
    review('recall_high', 'High-severity defects found (a confirmed or observed theme maps to them) ÷ high-severity defects on; needs ≥ 0.6. Computed from theme-mapping.json.'),
    review('precision', `True-positive themes ÷ all themes in each Gym v2 report's top ${TOP}; needs ≥ 0.7. Computed from theme-mapping.json.`),
    review('stability', 'Jaccard overlap of the mapped top-ten theme sets across the three seeds; needs ≥ 0.6.'),
    { id: 'control_run', live_required: true, status: !live || !counts ? 'NOT_RUN' : counts.confirmed === 0 && counts.reported <= 2 ? (full ? 'PASS' : 'NOT_RUN') : 'FAIL',
      detail: counts ? `${full ? '' : `Reduced scale (${options.personas} of 50 personas). `}Control build: ${counts.confirmed} confirmed and ${counts.reported} reported themes of ${controlThemes!.length}; needs no confirmed and at most two reported.` : 'The control run did not finish.' },
    { id: 'evidence_links', live_required: false, status: finished.length === 0 ? 'NOT_RUN' : unlinked.length ? 'FAIL' : 'PASS', detail: unlinked.length ? `Themes without log events: ${unlinked.join(', ')}.` : `Every theme in ${finished.length} finished runs links to events in its log.` },
    { id: 'export_size', live_required: true, status: 'NOT_RUN', detail: 'The HTML export is rendered by the app; measure it by exporting a seed\'s report from its project folder.' },
  ];
  const status: Status = error || criteria.some((check) => check.status === 'FAIL') ? 'FAIL' : live ? 'REVIEW_NEEDED' : 'NOT_RUN';
  const result = {
    status, mode: options.mode, scope: M3_SCOPE, criteria, error, setup_cost_usd: 0,
    runs: runs.map(({ name, run }) => ({ name, run_status: run?.run_status ?? null, cost_usd: run?.cost_usd ?? null, themes: run?.report?.themes?.length ?? null, evidence: run ? name : null })),
    recorded_cost_usd: allowance.spent(), missing_usage_attempts: allowance.unknown(),
    allowance_stop_reason: stopReason(allowance),
    elapsed_ms: Date.now() - started, billing_caveat: BILLING_CAVEAT,
  };
  json(join(options.out, 'acceptance.json'), result);
  return result;
}

const M5_SCOPE = "Points of interest: Gym v3's pricing copy (D28) read by the frozen population and a buyer segment, then the control copy; then Gym v3's checkout frames (D26) walked over five run seeds, then the control frames. Figma listing is checked by the app smoke test.";

/** Asset ids are content hashes, so importing a file into a throwaway store says which id its project copy will have. */
const assetIds = async (paths: string[]) => {
  const files = new Map<string, Uint8Array>();
  const blobs: BlobStore = { put: async (path, data) => void files.set(path, data), get: async (path) => files.get(path)! };
  return Promise.all(paths.map(async (path) => (await importLocalFile(blobs, path)).id));
};

/** The text runs' top themes and buying surveys, for a reader to say which (if any) describes D28's contradiction. */
function d28Sheet(out: string, runs: { name: string; report?: Report }[], live: boolean) {
  const items = runs.flatMap(({ name, report }) => (report?.themes ?? []).filter((theme) => theme.rank <= TOP).map((theme) => ({
    run: name, rank: theme.rank, theme_id: theme.id, title: theme.title, description: theme.description, trust: theme.trust, severity: theme.severity,
    personas: theme.personas, elements: theme.elements, seqs: theme.seqs.length,
    evidence: theme.evidence.map((e) => ({ seq: e.seq, persona: e.persona_name, segment: e.segment_id, what: e.what, quote: e.quote, passage: e.passage?.text ?? null })),
    d28: null as boolean | null, notes: '',
  })));
  const buyers = runs.map(({ name, report }) => ({ run: name, sentiment: report?.sentiment ?? [], buyers: report?.buyers ?? [] }));
  json(join(out, 'd28-themes.json'), { status: live ? 'REVIEW_NEEDED' : 'NOT_RUN', catalogue: 'defects.yaml', items, buyers });
  const lines = [
    '# D28 themes', '',
    live ? 'Review required. These are live provider outputs; no mapping has been inferred.' : 'Scripted rehearsal. This checks evidence delivery only; scripted confusions do not come from the copy.', '',
    'D28: the Team plan card lists single sign-on (SAML SSO), while the comparison table and the FAQ give it to Business only. Set `d28` to true on each theme that describes this contradiction: in `text-d28` that is a catch, in `text-control` (whose copy says SSO is Business only everywhere) a false positive. Record the result in [d28-themes.json](d28-themes.json) against [the catalogue](defects.yaml). Text themes are self-reports and a text has no browser signals, so none is confirmed or observed; the M3 trust rule cannot apply, and every theme is a candidate.', '',
    ...runs.flatMap(({ name, report }) => [
      `## ${name}: buying survey`, '',
      ...(report?.buyers?.length ? report.buyers.flatMap((b) => [
        `- ${b.name}: ${b.surveyed} surveyed, sentiment ${b.sentiment.toFixed(2)}, ${Math.round(b.would_buy * 100)}% would buy or recommend; price low ${b.price.low}, fair ${b.price.fair}, high ${b.price.high}, unclear ${b.price.unclear}.`,
        ...b.objections.map((o) => `  - Objection (${o.personas} personas): "${o.text.replaceAll('\n', ' ')}"`),
        ...b.unclear.map((o) => `  - Unclear (${o.personas} personas): "${o.text.replaceAll('\n', ' ')}"`),
      ]) : ['No buying survey answers.']), '',
    ]),
    ...items.flatMap((item) => [
      `## ${item.run}, rank ${item.rank}: ${item.title}`, '',
      `Trust ${item.trust}, severity ${item.severity}, ${item.personas} personas, elements ${item.elements.join(', ') || 'none'}. ${item.description}`, '',
      ...item.evidence.map((e) => `- Event ${e.seq} (${e.persona}): ${e.what}.${e.passage ? ` Passage: "${e.passage.replaceAll('\n', ' ')}".` : ''} "${e.quote.replaceAll('\n', ' ')}"`), '',
    ]),
  ];
  writeFileSync(join(out, 'd28-themes.md'), `${lines.join('\n')}\n`);
}

/** M5 mode: no browser and no Gym server, because text and design POIs open no page. The guards are the M2 ones (explicit allowance for live, fresh output, retained evidence). */
export async function runM5Acceptance(options: Options, env: Record<string, string | undefined> = process.env) {
  const source = freshOutput(options, env);
  copyFileSync(CATALOGUE, join(options.out, 'defects.yaml'));
  const allowance = createAllowance(options.allowance_usd ?? Infinity);
  const live = options.mode === 'live';
  const pool = { newPage: () => Promise.reject(new Error('A text or design POI opened a browser page.')) } as unknown as BrowserPool;
  const seeds = M5_SEEDS.slice(0, options.seeds ?? M5_SEEDS.length);
  const texts: { name: string; run?: SeedRun }[] = [{ name: 'text-d28' }, { name: 'text-control' }];
  const frames = seeds.map((seed) => ({ seed, name: `design-${seed}`, run: undefined as SeedRun | undefined }));
  const control = { seed: SEED, name: 'design-control', run: undefined as SeedRun | undefined };
  let refusal: string | null = null;
  let designPersonas = 0;
  let error: string | null = null;
  const started = Date.now();
  try {
    const users = fixture('http://localhost');
    const base = prepare(users, options);
    const designBase = prepare(users, options, Math.min(options.personas, DESIGN_PERSONAS));
    designPersonas = designBase.personas.length;
    const files = [gymAssets({ defects: 'D28' }).copy.pricing, gymAssets({ defects: 'none' }).copy.pricing, ...gymAssets({ defects: 'D26' }).frames.checkout, ...gymAssets({ defects: 'none' }).frames.checkout];
    const ids = await assetIds(files);
    const [pricing, pricingControl] = ids;
    const [shop, shopControl] = [ids.slice(2, 8), ids.slice(8, 14)];
    const [textCases, designCases] = [[textCase(base, pricing), textCase(base, pricingControl)], [designCase(designBase, shop), designCase(designBase, shopControl)]];
    for (const [i, data] of textCases.entries()) { // a text run the runner refuses would only fail late and obscurely
      const bad = preflight(data.project, (id) => ids.includes(id));
      if (bad) throw new Error(`The ${texts[i].name} project is refused: ${bad}`);
    }
    refusal = preflight(designCases[0].project, (id) => ids.includes(id)); // e.g. a navigator that cannot read images: skip the design case, spending nothing
    json(join(options.out, 'manifest.json'), {
      version: 1, suite: 'm5', mode: options.mode, scope: M5_SCOPE, seeds, provider: options.provider, fixture_version: FIXTURE_VERSION,
      personas: { text: textCases[0].personas.length, buyers: textCases[0].personas.length - base.personas.length, design: designPersonas },
      fixture_sha256: fixtureSha(base), case_sha256: { text: fixtureSha(textCases[0]), design: fixtureSha(designCases[0]) },
      routing: base.project.settings.routing, settings: base.project.settings, setup_cost_usd: 0,
      recorded_spend_allowance_usd: options.allowance_usd ?? null, billing_caveat: BILLING_CAVEAT,
      gym: { defects: ['D26', 'D28'], control: [], catalogue: 'defects.yaml', login: false },
      assets: files.map((file, i) => ({ file: relative(resolve(import.meta.dirname, '../../..'), file), id: ids[i] })),
      design: { frame: D26_FRAME + 1, skipped: refusal }, ...source, started_at: new Date(started).toISOString(),
    });
    for (const [i, entry] of texts.entries()) {
      if (allowance.signal.aborted) break; // later runs stay missing: no new provider calls
      entry.run = await runSeed(entry.name, SEED, textCases[i], options, pool, allowance, env, false, [files[i]]);
    }
    for (const entry of refusal ? [] : [...frames, control]) {
      if (allowance.signal.aborted) break;
      const defect = entry !== control;
      entry.run = await runSeed(entry.name, entry.seed, designCases[defect ? 0 : 1], options, pool, allowance, env, false, defect ? files.slice(2, 8) : files.slice(8, 14));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  d28Sheet(options.out, texts.map(({ name, run }) => ({ name, report: run?.report })), live);
  const slots = M5_SEEDS.map((seed) => { const run = frames.find((entry) => entry.seed === seed)?.run; return run ? frameMismatches(run.events) : null; });
  const controlMismatches = control.run ? frameMismatches(control.run.events) : null;
  const reduced = seeds.length < M5_SEEDS.length || designPersonas < DESIGN_PERSONAS ? `${designPersonas} of ${DESIGN_PERSONAS} personas, ${seeds.length} of ${M5_SEEDS.length} seeds` : null;
  const criteria: Criterion[] = [
    buyerTextCriterion(options.mode, texts[0].run?.report),
    d28Criterion(options.mode, { d28: texts[0].run?.report, control: texts[1].run?.report }),
    ...(refusal ? designSkipped(refusal) : [atScale(frameMismatchCriterion(options.mode, slots), reduced), atScale(controlFrameCriterion(options.mode, controlMismatches), reduced)]),
    FIGMA_LISTING,
  ];
  const status: Status = error || criteria.some((check) => check.status === 'FAIL') ? 'FAIL' : live ? 'REVIEW_NEEDED' : 'NOT_RUN';
  const summary = ({ name, run }: { name: string; run?: SeedRun }) => ({ name, run_status: run?.run_status ?? null, cost_usd: run?.cost_usd ?? null, themes: run?.report?.themes?.length ?? null, evidence: run ? name : null });
  const result = {
    status, mode: options.mode, scope: M5_SCOPE, criteria, error, setup_cost_usd: 0,
    text: texts.map(summary),
    design: { skipped: refusal, frame: D26_FRAME + 1, personas: designPersonas, seeds: frames.map((entry) => ({ seed: entry.seed, ...summary(entry), mismatch: entry.run ? frameMismatches(entry.run.events) : null })), control: { ...summary(control), mismatch: controlMismatches } },
    recorded_cost_usd: allowance.spent(), missing_usage_attempts: allowance.unknown(),
    allowance_stop_reason: stopReason(allowance),
    elapsed_ms: Date.now() - started, billing_caveat: BILLING_CAVEAT,
  };
  json(join(options.out, 'acceptance.json'), result);
  return result;
}

const EVALUATE_SCOPE = 'Evaluation harness: the frozen population on Gym v2 (all 25 defects) with the injected complaint, one run per declared arm in each replicate, matched on population and seed. Arm order is shuffled per replicate with a seed, and the Gym store is reset before each run. Outcomes are run-level; whole replicates are the unit of analysis. Defect recall and precision are NOT_RUN until reviewed theme mappings exist; each run keeps a one-to-one page-overlap proxy.';
// The predeclared benchmark fields (new_simulation.md §9); none is filled yet, so validity and efficiency cannot be claimed.
// primary_metrics stays null until a pilot sets it; until then every interval is exploratory.
const BENCHMARK = { human_reference_dataset: null, behavioural_error_margin: null, efficiency_margin: null, confirmatory_repeats: null, primary_metrics: null as string[] | null };
const METRICS = ['completion_rate', 'abandonment_rate', 'themes', 'first_hand', 'heard_first', 'cost_usd', 'llm_calls', 'segment_modularity', 'mean_in_degree', 'top_decile_in_share'] as const;
type Outcomes = ReturnType<typeof outcomesOf>;

/** One finished run's outcomes, with segment numerators and denominators; the graph is the one the run logged on persona.created, absent without social rounds. */
function outcomesOf(report: Report, data: Fixture, events: GnomiEvent[], catalogue: string) {
  const n = report.personas.length;
  const count = (outcome: string) => report.personas.filter((p) => p.outcome === outcome).length;
  const themes = report.themes ?? [];
  const settings = data.project.settings;
  const follows = new Map(events.flatMap((event) => event.type === 'persona.created' && event.payload.follows ? [[event.payload.persona.id, event.payload.follows] as const] : []));
  const graph = settings.social ? graphMetrics(follows, data.personas) : null;
  return {
    personas: n, completed: count('done'), abandoned: count('abandoned'),
    completion_rate: n ? count('done') / n : null, abandonment_rate: n ? count('abandoned') / n : null,
    segments: report.segments.map((s) => ({ segment_id: s.id, personas: s.personas, completed: s.outcomes.done, abandoned: s.outcomes.abandoned })),
    defect_proxy: defectScores(themes, catalogue, DEFECT_IDS), // one-to-one page overlap, not reviewed: never a compared metric
    themes: themes.length, first_hand: themes.reduce((sum, t) => sum + (t.prevalence?.personas ?? 0), 0), heard_first: themes.reduce((sum, t) => sum + (t.heard_first ?? 0), 0),
    cost_usd: report.cost_usd, llm_calls: report.llm_calls,
    segment_modularity: graph?.segment_modularity ?? null, mean_in_degree: graph?.mean_in_degree ?? null, top_decile_in_share: graph?.top_decile_in_share ?? null,
  };
}

const fmt = (x: number | null) => x === null ? 'n/a' : Number(x.toFixed(4)).toString();

/** Evaluate mode (new_simulation.md §9): repeated matched replicates over the declared arms, per-arm means and paired differences from baseline. */
export async function runEvaluation(options: Options, env: Record<string, string | undefined> = process.env) {
  const source = freshOutput(options, env);
  const catalogue = readFileSync(CATALOGUE, 'utf8');
  copyFileSync(CATALOGUE, join(options.out, 'defects.yaml'));
  const allowance = createAllowance(options.allowance_usd ?? Infinity);
  const arms: Arm[] = options.arms ?? (Object.keys(ARMS) as Arm[]);
  const seeds = Array.from({ length: options.repeats ?? 5 }, (_, r) => SEED + r);
  // A seeded arm order per replicate, so an arm's effect is not its position after the others.
  const order = (seed: number) => { const next = mulberry32(fnv1a(`arms/${seed}`)); return arms.map((arm) => ({ arm, key: next() })).sort((a, b) => a.key - b.key).map((e) => e.arm); };
  const replicates = seeds.map((seed, r) => ({ replicate: r + 1, seed, order: order(seed), arms: {} as Partial<Record<Arm, { run_status: string | null; evidence: string; duration_ms: number; outcomes: Outcomes | null }>> }));
  let error: string | null = null;
  let pool: BrowserPool | undefined;
  let server: Awaited<ReturnType<typeof startGym>> | undefined;
  const started = Date.now();
  try {
    server = await startGym({ port: 0, defects: 'all' });
    const base = prepare(fixture(server.url), options);
    const plain = generic(base);
    json(join(options.out, 'fixture.json'), base);
    json(join(options.out, 'manifest.json'), {
      version: 1, suite: 'evaluate', mode: options.mode, scope: EVALUATE_SCOPE, repeats: seeds.length, seeds, arms: Object.fromEntries(arms.map((arm) => [arm, ARMS[arm]])),
      provider: options.provider, personas: base.personas.length, injected_post: complaint(base), fixture_version: FIXTURE_VERSION,
      fixture_sha256: fixtureSha(base),
      routing: base.project.settings.routing, settings: base.project.settings, setup_cost_usd: 0, benchmark: BENCHMARK,
      recorded_spend_allowance_usd: options.allowance_usd ?? null, billing_caveat: BILLING_CAVEAT,
      gym: { defects: DEFECT_IDS, catalogue: 'defects.yaml', login: false }, ...source, started_at: new Date(started).toISOString(),
    });
    pool = await launchBrowserPool();
    for (const entry of replicates) {
      for (const arm of entry.order) {
        if (allowance.signal.aborted) break; // later runs stay missing: no new provider calls
        const reset = await fetch(`${server.url}/__reset`, { method: 'POST' }); // jobs and users an earlier run created must not leak into this one
        if (!reset.ok) throw new Error(`The Gym reset failed with HTTP ${reset.status}.`);
        const spec: { settings?: Partial<RunSettings>; generic?: true } = ARMS[arm];
        const from = spec.generic ? plain : base;
        const data = { ...from, project: { ...from.project, settings: { ...from.project.settings, ...spec.settings } } };
        const name = `r${entry.replicate}-${arm}`;
        const runStarted = performance.now();
        const run = await runSeed(name, entry.seed, data, options, pool, allowance, env, data.project.settings.social !== false);
        entry.arms[arm] = { run_status: run.run_status, evidence: name, duration_ms: Math.round(performance.now() - runStarted), outcomes: run.report?.status === 'finished' ? outcomesOf(run.report, data, run.events, catalogue) : null };
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    await pool?.close().catch(() => {});
    await server?.close();
  }
  const series = (arm: Arm, metric: typeof METRICS[number]) => replicates.map((entry) => entry.arms[arm]?.outcomes?.[metric] ?? null);
  // Means over the same replicates in every arm, so a stopped run cannot make the arms average different seeds.
  const complete = replicates.filter((entry) => arms.every((arm) => entry.arms[arm]?.outcomes));
  const means = Object.fromEntries(arms.map((arm) => [arm, Object.fromEntries(METRICS.map((metric) => {
    const values = complete.map((entry) => entry.arms[arm]!.outcomes![metric]).filter((x) => x !== null);
    return [metric, { n: values.length, mean: values.length ? mean(values) : null }];
  }))]));
  const differences = Object.fromEntries(arms.filter((arm) => arm !== 'baseline').map((arm) => [arm, Object.fromEntries(METRICS.map((metric) => [metric, pairedDifference(series(arm, metric), series('baseline', metric))]))]));
  const missing = Object.entries(BENCHMARK).filter(([, value]) => value === null).map(([key]) => key);
  const scripted = options.mode === 'scripted';
  const labels = scripted ? { behavioural_validity: 'NOT_RUN', efficiency: 'NOT_RUN' } as const : { behavioural_validity: 'NOT_VALIDATED', efficiency: 'INCONCLUSIVE' } as const;
  const status: Status | 'INCOMPLETE' = error ? 'FAIL' : complete.length < seeds.length ? 'INCOMPLETE' : scripted ? 'NOT_RUN' : 'REVIEW_NEEDED';
  const primary = BENCHMARK.primary_metrics ?? [];
  const defect_metrics = { recall: null, precision: null, status: 'NOT_RUN', detail: 'Needs reviewed theme-to-defect mappings. Each run\'s outcomes.defect_proxy is a one-to-one page-overlap proxy, not a compared metric.' } as const;
  const result = {
    status, mode: options.mode, scope: EVALUATE_SCOPE, labels, missing_benchmark: missing, error, repeats: seeds.length, complete_replicates: complete.length, arms,
    method: 'Per arm, the mean over the replicates complete in every arm; per arm against baseline, the mean of per-replicate differences with a two-sided 95% Student t interval over replicate pairs where both finished, given only for three or more pairs that vary. Personas are never the unit. No multiplicity correction is applied.',
    intervals: primary.length ? `confirmatory for ${primary.join(', ')}; exploratory otherwise` : 'exploratory: no primary metric is declared', defect_metrics,
    replicates, means, differences,
    recorded_cost_usd: allowance.spent(), missing_usage_attempts: allowance.unknown(),
    allowance_stop_reason: stopReason(allowance),
    elapsed_ms: Date.now() - started, billing_caveat: BILLING_CAVEAT,
  };
  json(join(options.out, 'results.json'), result);
  const lines = [
    '# Evaluation results', '',
    `Behavioural validity: ${labels.behavioural_validity}. Efficiency: ${labels.efficiency}. Missing predeclared benchmark fields: ${missing.join(', ')}.`, '',
    `Defect recall: n/a (${defect_metrics.status}). Defect precision: n/a (${defect_metrics.status}). ${defect_metrics.detail}`, '',
    `Intervals: ${result.intervals}.`, '',
    `${scripted ? 'Scripted rehearsal: no provider calls, so outcomes show the harness, not the model. ' : ''}${status === 'INCOMPLETE' ? 'INCOMPLETE: ' : ''}${complete.length} of ${seeds.length} replicates complete across ${arms.length} arms (${arms.join(', ')}). ${result.method} With few replicates the interval may be too wide to be useful, and it describes the simulator, not a human population.${error ? ` Error: ${error}` : ''}`, '',
    ...Object.entries(differences).flatMap(([arm, metrics]) => [
      `## ${arm} − baseline`, '', '| Metric | Mean difference | 95% interval | Pairs |', '| --- | --- | --- | --- |',
      ...Object.entries(metrics).map(([metric, d]) => `| ${metric} | ${fmt(d.mean)} | ${d.lower === null ? `n/a (${d.note})` : `${fmt(d.lower)} to ${fmt(d.upper)}${primary.includes(metric) ? '' : ' (exploratory)'}`} | ${d.n} |`), '',
    ]),
  ];
  writeFileSync(join(options.out, 'results.md'), `${lines.join('\n')}\n`);
  return result;
}
