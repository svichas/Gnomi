import { runEpisode } from './agent/loop.ts';
import { BUILTIN_PERSONA } from './persona.ts';
import { buildReport } from './report/build.ts';
import type { BlobStore, BrowserPool, LlmGateway, PageDriver, ProjectStore, Recorder } from './seams.ts';
import type { EventPayloads, GnomiEvent, ProjectConfig, Report, RunConfig } from './types.ts';

export interface RunDeps {
  store: ProjectStore;
  blobs: BlobStore;
  browsers: BrowserPool;
  llm: LlmGateway;
  record: Recorder;
}

export interface RunHandle {
  run_id: string;
  /** Cancels the in-flight model call (a browser action already under way completes); the run then ends with run.stopped(user). */
  stop(): void;
  /** Resolves with the final report after report.generated is recorded. Run failures never reject it: they end as run.stopped(error). */
  done: Promise<Report>;
}

export function createRecorder(store: ProjectStore, onEvent: (event: GnomiEvent) => void): Recorder {
  return (event, transcript) => {
    const stored = store.append(event);
    if (transcript) store.saveTranscript(stored.run_id, stored.seq, transcript.request, transcript.response);
    onEvent(stored);
    return stored;
  };
}

/** M0 defaults (roadmap M0): the built-in persona, a Claude Haiku navigator, 40 steps, a $1 cap, screenshots on. */
export function newRunConfig(project: ProjectConfig): Omit<RunConfig, 'run_id'> {
  return {
    seed: Math.floor(Math.random() * 2 ** 31),
    project,
    persona: BUILTIN_PERSONA,
    model: { provider: 'anthropic', navigator: 'claude-haiku-5-5' },
    step_budget: 40,
    cost_budget_usd: 1,
    screenshots: true,
    app_version: '0.0.0', // shortcut: fixed until packaging (M7) stamps a real version
  };
}

export function startRun(config: RunConfig, { store, blobs, browsers, llm, record }: RunDeps): RunHandle {
  const { run_id, persona, project } = config;
  const controller = new AbortController();
  // The budget reads spend from the log, so it counts every llm.call the gateway recorded, retries included.
  const spentUsd = () => store.events(run_id, { types: ['llm.call'] }).reduce((sum, e) => sum + (e.type === 'llm.call' ? e.payload.cost_usd : 0), 0);
  const base = { run_id, round: 1, persona_id: null, poi_id: null };

  const execute = async (): Promise<Report> => {
    record({ ...base, type: 'run.started', payload: { config } });
    let stopped: EventPayloads['run.stopped'] | null = null;
    let page: PageDriver | null = null;
    try {
      record({ ...base, persona_id: persona.id, type: 'persona.created', payload: { persona } });
      page = await browsers.newPage({ device: persona.device, origin: new URL(project.poi.start_url).origin });
      await page.goto(project.poi.start_url);
      const episode = { poi_id: project.poi.id, device: persona.device, start_url: project.poi.start_url };
      record({ ...base, persona_id: persona.id, poi_id: project.poi.id, type: 'persona.episode_started', payload: episode });
      const end = await runEpisode({ config, page, llm, blobs, record, signal: controller.signal, spentUsd });
      if (end === 'stopped') stopped = { reason: 'user', detail: null };
      if (end === 'cost_budget') stopped = { reason: 'cost_budget', detail: `spent $${spentUsd().toFixed(4)} of the $${config.cost_budget_usd} budget` };
    } catch (err) {
      stopped = controller.signal.aborted ? { reason: 'user', detail: null } : { reason: 'error', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      await page?.close().catch(() => {});
    }

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

  return { run_id, stop: () => controller.abort(), done: execute() };
}
