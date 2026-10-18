import { useEffect, useId, useRef, useState } from 'react';
import type { RunRow } from '@gnomi/simulation/types.ts';
import { runSetup } from './activity.ts';
import { Icon } from './Icon.tsx';
import { when } from './ui.tsx';
import './project-run-history.css';

const STATUS = { running: 'Running', finished: 'Completed', stopped: 'Stopped', interrupted: 'Interrupted' };

/** Durable project history, available from every project screen and independent of the session dock. */
export function ProjectRunHistory({ runs, selected, onSelect }: { runs: RunRow[]; selected: string | null; onSelect(id: string): void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const sorted = [...runs].sort((a, b) => b.started_at - a.started_at || b.run_id.localeCompare(a.run_id, undefined, { numeric: true }));

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', dismiss);
    };
  }, [open]);

  return <div ref={container} className="project-run-history"
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => {
      if (open && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    }}>
    <button ref={trigger} type="button" className="project-history-trigger" aria-label="Past runs" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((was) => !was)}>
      <Icon name="clock" size={17} /><span>Past runs</span><span className="project-history-count">{runs.length}</span><span className="project-history-chevron"><Icon name="chevron" size={14} /></span>
    </button>
    <section id={panelId} hidden={!open} className="project-history-panel" aria-label="Project run history">
      <div className="project-history-heading"><h2>Past simulations</h2><p>All runs saved in this project, newest first.</p></div>
      {runs.length === 0 ? <div className="project-history-empty"><Icon name="clock" size={24} /><strong>No simulations yet.</strong><p>Start your first simulation from Review. Its results will be saved here.</p></div> :
        <ul className="project-history-list">
          {sorted.map((run) => {
            const people = runSetup(run.config).personas.length;
            return <li key={run.run_id}><button type="button" className="project-history-run" aria-current={selected === run.run_id ? 'true' : undefined} onClick={() => { setOpen(false); onSelect(run.run_id); }}>
              <span className="project-history-run-top"><span className="project-history-status" data-status={run.status}><Icon name={run.status === 'finished' ? 'check' : run.status === 'running' ? 'activity' : run.status === 'interrupted' ? 'alert' : 'clock'} size={13} />{STATUS[run.status]}</span><span>{when(run.started_at)}</span></span>
              <strong>{run.config.project.goal || 'Simulation'}</strong>
              <span className="project-history-run-bottom"><span>{run.run_id} · {people} {people === 1 ? 'person' : 'people'}</span><span>{selected === run.run_id ? 'Viewing' : run.status === 'running' ? 'View simulation' : 'View report'}<Icon name="arrow" size={13} /></span></span>
            </button></li>;
          })}
        </ul>}
    </section>
  </div>;
}
