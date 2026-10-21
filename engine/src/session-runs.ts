import type { GnomiEvent } from '@gnomi/simulation/types.ts';
import type { SessionRun } from './protocol.ts';

export const runKey = (dir: string, id: string) => JSON.stringify([dir, id]);

/** Keep only summary state, never transcripts, screenshots or the full event log. */
export class SessionRuns {
  private runs = new Map<string, SessionRun>();
  private blocked = new Map<string, Set<string>>();

  private emit: (run: SessionRun) => void;
  constructor(emit: (run: SessionRun) => void) { this.emit = emit; }

  list(): SessionRun[] {
    return [...this.runs.values()].sort((a, b) => b.started_at - a.started_at);
  }

  record(dir: string, event: GnomiEvent, project_id?: string) {
    const key = runKey(dir, event.run_id);
    if (event.type === 'run.started') {
      this.runs.set(key, { project_id, project_dir: dir, project_name: event.payload.config.project.name, run_id: event.run_id,
        started_at: event.ts, ended_at: null, status: 'running', phase: 'starting', waiting: 0, stop_reason: null });
      // A comparison never waits for the user: a blocked task ends at once, so there is nothing to resume.
      if (!event.payload.config.project.comparison) this.blocked.set(key, new Set());
    }
    const run = this.runs.get(key);
    if (!run) return;
    const before = JSON.stringify(run);
    if (event.type === 'persona.episode_started') run.phase = 'exploring';
    else if (event.type.startsWith('social.')) run.phase = 'discussing';
    else if (event.type === 'report.started') { run.phase = 'reporting'; this.blocked.delete(key); }
    else if (event.type === 'run.finished' || event.type === 'run.stopped') {
      run.phase = 'saving';
      this.blocked.delete(key);
      if (event.type === 'run.stopped') run.stop_reason = event.payload.detail ?? event.payload.reason;
    } else if (event.type === 'report.generated') {
      run.status = run.stop_reason === null ? 'finished' : 'stopped';
      run.ended_at = event.ts;
      this.blocked.delete(key);
    }
    const waiting = this.blocked.get(key);
    if (event.persona_id && waiting) {
      if (event.type === 'persona.blocked') waiting.add(event.persona_id);
      else if (['persona.resumed', 'persona.goal_done', 'persona.abandoned', 'signal.budget_exceeded', 'signal.repeated_failure'].includes(event.type)) waiting.delete(event.persona_id);
    }
    run.waiting = waiting?.size ?? 0;
    if (event.type === 'run.started' || before !== JSON.stringify(run)) this.emit({ ...run });
  }

  fail(dir: string, id: string) {
    const key = runKey(dir, id);
    const run = this.runs.get(key);
    if (!run) return;
    Object.assign(run, { status: 'interrupted', ended_at: Date.now(), waiting: 0, stop_reason: 'The simulation could not finish saving its results.' });
    this.blocked.delete(key);
    this.emit({ ...run });
  }
}
