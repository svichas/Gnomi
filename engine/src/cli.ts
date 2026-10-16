// One persona, one URL, one goal, from a terminal: the headless entry point of tech.md §16.2.
// node engine/src/cli.ts --url <start url> --goal "<goal>" [--allow host1,host2] [--not-production] [--project <dir>] [--fake-llm] [--headed]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { launchBrowserPool } from './browser/pool.ts';
import { createGateway } from './llm/gateway.ts';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, DEMO_NAVIGATOR, DEMO_SOCIALISER } from './llm/scripted.ts';
import { createFsBlobStore } from './log/blobs.ts';
import { openProject } from './log/sqlite.ts';
import { BUILTIN_PERSONA } from './persona.ts';
import { reportToMarkdown } from './report/markdown.ts';
import { createRecorder, newRunConfig, startRun, type RunHandle } from './run.ts';
import { preflight } from './poi/index.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import type { GnomiEvent, ProjectConfig } from './types.ts';

const USAGE =
  'Usage: node engine/src/cli.ts --url <start url> --goal "<goal>" [--allow host1,host2] [--not-production] [--project <dir>] [--fake-llm] [--headed]';

function describe(e: GnomiEvent): string {
  switch (e.type) {
    case 'run.started':
      return `${e.payload.config.run_id}: "${e.payload.config.project.goal}" on ${e.payload.config.project.pois.map((poi) => (poi.type === 'web' ? poi.start_url : poi.name)).join(', ')}`;
    case 'run.concurrency_changed':
      return `${e.payload.concurrency} at once: ${e.payload.reason}`;
    case 'run.reset_called':
      return `${e.payload.url} → ${e.payload.status ?? e.payload.error}`;
    case 'persona.created':
      return `${e.payload.persona.name}, ${e.payload.persona.job_title}`;
    case 'persona.episode_started':
      return `${e.payload.start_url} (${e.payload.device})`;
    case 'llm.call': {
      const p = e.payload;
      const cache = p.cache_read_tokens || p.cache_write_tokens ? ` (+${p.cache_read_tokens} cache read, +${p.cache_write_tokens} cache write)` : '';
      return `${p.provider}/${p.model} ${p.status}: ${p.input_tokens} in${cache}, ${p.output_tokens} out, $${p.cost_usd.toFixed(5)}, ${p.latency_ms} ms${p.error ? `: ${p.error.slice(0, 200)}` : ''}`;
    }
    case 'persona.step': {
      const { step_no, action, target, result, feeling, thought } = e.payload;
      const on = target ? ` ${target.role} "${target.name}"` : action.ref ? ` ${action.ref}` : '';
      const text = action.text ? ` "${action.text}"` : '';
      const outcome = !result.ok ? `failed: ${result.error}` : result.url_after !== result.url_before ? `→ ${result.url_after}` : 'ok';
      return `${step_no}. ${action.type}${on}${text} ${outcome} | feeling ${feeling} | "${thought}"`;
    }
    case 'persona.friction_reported':
      return `step ${e.payload.step_no}, severity ${e.payload.severity}: ${e.payload.what} (expected: ${e.payload.expected})`;
    case 'persona.opinion_changed':
      return `${e.payload.poi_id}: sentiment ${e.payload.after.sentiment}, self-reported confidence ${Math.round(e.payload.after.confidence * 100)}%`;
    case 'persona.goal_done':
      return `step ${e.payload.step_no}: ${e.payload.summary}`;
    case 'persona.abandoned':
      return `step ${e.payload.step_no}: ${e.payload.reason}`;
    case 'signal.budget_exceeded':
      return `all ${e.payload.budget} steps used`;
    case 'persona.blocked':
      return `step ${e.payload.step_no}, ${e.payload.reason}: ${e.payload.detail}`;
    case 'persona.resumed':
      return `step ${e.payload.step_no}`;
    case 'containment.blocked_request':
      return `${e.payload.method} ${e.payload.url}`;
    case 'containment.tripwire':
      return `${e.payload.kind}: ${e.payload.detail}`;
    case 'signal.repeated_failure':
      return `step ${e.payload.step_no}: the same ${e.payload.action} failed three times in a row (${e.payload.error})`;
    case 'signal.failed_action':
      return `step ${e.payload.step_no}: ${e.payload.action} failed (${e.payload.error})`;
    case 'signal.loop':
      return `step ${e.payload.step_no}: ${e.payload.url} seen ${e.payload.visits} times`;
    case 'signal.backtrack':
      return `step ${e.payload.step_no}: ${e.payload.kind} on ${e.payload.url}`;
    case 'signal.error':
      return `step ${e.payload.step_no}: ${e.payload.kind}${e.payload.status ? ` ${e.payload.status}` : ''} ${e.payload.message}`;
    case 'signal.validation_error':
      return `step ${e.payload.step_no}: "${e.payload.message}"`;
    case 'signal.small_target':
      return `step ${e.payload.step_no}: ${e.payload.box[2]}×${e.payload.box[3]} target`;
    case 'persona.survey':
      return `${e.payload.poi_id}: sentiment ${e.payload.sentiment}, ${e.payload.would_continue ? 'would' : 'would not'} continue: "${e.payload.reason}"`;
    case 'run.round_started':
    case 'run.round_ended':
      return `round ${e.round}`;
    case 'social.feed_viewed':
      return `${e.payload.post_ids.length} posts`;
    case 'social.post':
      return `${e.payload.parent_id ? `reply to ${e.payload.parent_id}` : 'post'} ${e.payload.post_id}${e.payload.injected ? ' (injected)' : ''}: "${e.payload.text}"`;
    case 'social.reaction':
      return `${e.payload.kind} ${e.payload.post_id}`;
    case 'run.finished':
      return '';
    case 'run.stopped':
      return e.payload.detail ? `${e.payload.reason}: ${e.payload.detail}` : e.payload.reason;
    case 'report.started':
      return e.payload.pois.length ? `naming themes and writing suggestions for ${e.payload.pois.join(', ')}` : 'no frictions to name themes for';
    case 'report.themes':
      return `${e.payload.poi_id}: ${e.payload.themes.length} themes named by the judge`;
    case 'report.suggestions':
      return `${e.payload.poi_id}: ${e.payload.suggestions.length} suggested changes from the author`;
    case 'report.generated':
      return `${e.payload.path} (${e.payload.friction_count} frictions)`;
  }
}

const OPTIONS = {
  url: { type: 'string' },
  goal: { type: 'string' },
  allow: { type: 'string', default: '' },
  'not-production': { type: 'boolean', default: false },
  project: { type: 'string' },
  'fake-llm': { type: 'boolean', default: false },
  headed: { type: 'boolean', default: false },
} as const;

function args() {
  try {
    return parseArgs({ options: OPTIONS }).values;
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : err}\n${USAGE}`);
  }
}

async function main(): Promise<void> {
  const values = args();
  if (!values.url || !values.goal) throw new Error(USAGE);
  const start = URL.parse(values.url);
  if (!start || !/^https?:$/.test(start.protocol)) throw new Error(`Not an http(s) URL: ${values.url}`);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!values['fake-llm'] && !apiKey) throw new Error('Set ANTHROPIC_API_KEY, or pass --fake-llm for a scripted run that calls no model.');

  // shortcut: sessions and audiences are set up in the app only, so the CLI runs the built-in persona logged out on the
  // default routing; add --role and --audience once the CLI can record and sample
  const project: ProjectConfig = {
    name: start.host,
    description: '',
    pois: [{
      id: 'poi-1',
      type: 'web',
      mode: 'full',
      segments: null,
      name: start.host,
      start_url: start.href,
      allowed_hosts: values.allow.split(',').map((h) => h.trim()).filter(Boolean),
      production_domains: [],
      not_production: values['not-production'],
      reset_hook_url: null,
    }],
    goal: values.goal,
    role: null,
    audience: null,
    settings: DEFAULT_SETTINGS,
  };
  const refusal = preflight(project);
  if (refusal) throw new Error(values['not-production'] ? refusal : `${refusal}\nOn the command line, confirm with --not-production.`);

  const dir = values.project ?? mkdtempSync(join(tmpdir(), 'gnomi-'));
  const store = openProject(dir);
  try {
    store.saveProject(project);
    const record = createRecorder(store, (e) => console.log(`#${e.seq} ${e.type} ${describe(e)}`.trimEnd()));
    const browsers = await launchBrowserPool({ headless: !values.headed });
    try {
      let run: RunHandle | undefined;
      const llm =
        apiKey && !values['fake-llm']
          ? createGateway({ secrets: { get: (name) => (name === 'anthropic_api_key' ? apiKey : null) }, localBaseUrl: null, record, onThrottle: (provider) => run?.throttle(provider) })
          : createScriptedGateway({ navigator: DEMO_NAVIGATOR, socialiser: DEMO_SOCIALISER, judge: DEMO_JUDGE, author: DEMO_AUTHOR }, record);
      console.log(`Project folder: ${dir}`);
      // Nobody can resume a blocked persona from a terminal, so a block ends her episode at once.
      const config = store.createRun({ ...newRunConfig(project, { personas: [BUILTIN_PERSONA], sessions: [], reset: false }), pause_timeout_ms: 0 });
      run = startRun(config, { store, blobs: createFsBlobStore(dir), browsers, llm, record, sessions: null });
      const started = run;
      process.once('SIGINT', () => {
        console.log('Stopping… (Ctrl-C again to quit at once)');
        started.stop();
        process.once('SIGINT', () => process.exit(130));
      });
      const report = await started.done;
      console.log(`\n${reportToMarkdown(report)}`);
      console.log(`Screenshots and report.json are under ${dir}`);
    } finally {
      await browsers.close();
    }
  } finally {
    store.close();
  }
}

// A finished or stopped run exits 0; only a run that could not start exits non-zero.
main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
