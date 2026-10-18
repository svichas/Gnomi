import { useEffect, useRef, useState } from 'react';
import type { SessionRun } from '@gnomi/engine/protocol.ts';
import type { ProjectEntry } from '../../projects.ts';
import { call, errorText, onSessionRun, stopped } from './engine.ts';
import { Icon } from './Icon.tsx';
import './simulation-dock.css';

const keyOf = (run: SessionRun) => JSON.stringify([run.project_dir, run.run_id]);
const phases: Record<SessionRun['phase'], string> = {
  starting: 'Getting ready', exploring: 'Exploring the product', discussing: 'Exchanging perspectives', reporting: 'Building the report', saving: 'Saving results',
};
function duration(run: SessionRun, now: number) {
  const seconds = Math.max(0, Math.floor(((run.ended_at ?? now) - run.started_at) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

export function SimulationDock({ onOpen, projects }: { onOpen(run: SessionRun): Promise<boolean>; projects: ProjectEntry[] }) {
  const [runs, setRuns] = useState<SessionRun[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    const off = onSessionRun((run) => setRuns((previous) => [run, ...previous.filter((entry) => keyOf(entry) !== keyOf(run))]));
    void call('get_session_runs', {}).then((all) => { if (active) setRuns(all); }, (err) => { if (active) setProblem(errorText(err)); });
    void stopped.then(() => { if (active) setDisconnected(true); });
    return () => { active = false; off(); };
  }, []);
  const running = runs.filter((run) => run.status === 'running').length;
  const complete = runs.filter((run) => run.status === 'finished').length;
  const attention = runs.some((run) => run.waiting > 0 || run.status === 'interrupted');
  useEffect(() => {
    if (!expanded || !running || disconnected) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expanded, running, disconnected]);

  // Keep the subscription mounted so the first run reveals the pill without a reload.
  if (runs.length === 0) return null;

  async function openRun(run: SessionRun) {
    setOpening(keyOf(run));
    setProblem(null);
    try { if (await onOpen(run)) setExpanded(false); }
    catch (err) { setProblem(errorText(err)); }
    finally { setOpening(null); }
  }
  async function stopRun(run: SessionRun) {
    const key = keyOf(run);
    setStopping((previous) => new Set(previous).add(key));
    setProblem(null);
    try { await call('stop_run', { run_id: run.run_id, project_dir: run.project_dir }); }
    catch (err) {
      setProblem(errorText(err));
      setStopping((previous) => { const next = new Set(previous); next.delete(key); return next; });
    }
  }
  const summary = disconnected ? 'Connection lost' : running ? `${running} running` : complete ? `${complete} completed` : `${runs.length} ended`;
  const sorted = [...runs].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.started_at - a.started_at);

  return <aside className="simulation-dock" data-expanded={expanded} data-live={running > 0 && !disconnected} aria-label="Session simulations" onKeyDown={(event) => {
    if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setExpanded(false); trigger.current?.focus(); }
  }}>
    <div className="simulation-dock-expansion" id="session-simulations" inert={!expanded} aria-hidden={!expanded}>
      <div className="simulation-dock-content">
        <header className="simulation-dock-heading"><span className="simulation-dock-eyebrow">This session</span><h2>Your simulations</h2><p>Keep working. Your simulations stay here.</p></header>
        {disconnected && <p className="simulation-dock-error" role="alert">The engine disconnected. Reopen Gnomi to check saved results.</p>}
        {problem && <p className="simulation-dock-error" role="alert">{problem}</p>}
        <ul className="simulation-dock-list" aria-label="Simulations from this session">
            {sorted.map((run) => {
              const key = keyOf(run);
              const live = run.status === 'running';
              const isStopping = live && stopping.has(key);
              const project = projects.find((entry) => entry.id === run.project_id);
              const name = project?.name ?? run.project_name;
              const state = live ? disconnected ? 'interrupted' : run.waiting ? 'attention' : 'running' : run.status;
              const status = live ? disconnected ? 'Connection lost' : isStopping ? 'Stopping safely…' : run.waiting ? 'Needs your attention' : phases[run.phase] : run.status === 'finished' ? 'Completed · Report ready' : run.status === 'stopped' ? 'Stopped · Partial report' : 'Interrupted';
              return <li key={key} className="simulation-dock-run" data-state={state}>
                <button type="button" className="simulation-dock-open" disabled={opening !== null || !project || disconnected} aria-label={`Open ${name} simulation ${run.run_id}`} onClick={() => void openRun(run)}>
                  <span className="simulation-dock-run-icon"><Icon name={state === 'finished' ? 'check' : state === 'attention' || state === 'interrupted' ? 'alert' : state === 'stopped' ? 'clock' : 'activity'} size={18} /></span>
                  <span className="simulation-dock-run-copy"><strong>{name}</strong><span>{status}</span><small>{run.run_id} <span aria-hidden="true">·</span> {duration(run, now)}{!project && ' · Project removed'}</small></span>
                  <span className="simulation-dock-open-arrow"><Icon name="arrow" size={16} /></span>
                </button>
                {live && !disconnected && <button type="button" className="simulation-dock-stop" disabled={isStopping} onClick={() => void stopRun(run)} aria-label={`Stop ${name} simulation ${run.run_id}`} title="Stop simulation"><span aria-hidden="true" /></button>}
              </li>;
            })}
        </ul>
        <p className="simulation-dock-footnote">{running} running <span>·</span> {complete} completed <span>·</span> {runs.length} total</p>
      </div>
    </div>
    <button ref={trigger} type="button" className="simulation-dock-toggle" aria-label="Simulations" aria-expanded={expanded} aria-controls="session-simulations" onClick={() => setExpanded((was) => !was)}>
      <span className="simulation-dock-indicator" data-attention={attention || disconnected}><Icon name={running && !disconnected ? 'activity' : 'leaf'} size={18} /></span>
      <strong>Simulations</strong><span className="simulation-dock-summary" role="status">{summary}</span><span className="simulation-dock-chevron"><Icon name="chevron" size={16} /></span>
    </button>
  </aside>;
}
