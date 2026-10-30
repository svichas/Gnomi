import type { RunRow } from '@gnomi/simulation/types.ts';
import { runSetup } from './activity.ts';
import { Icon } from './Icon.tsx';
import { when } from './ui.tsx';
import './project-run-history.css';

const STATUS = { running: 'Running', finished: 'Completed', stopped: 'Stopped', interrupted: 'Interrupted' };

type ListedRun = RunRow & { project_id?: string; project_name?: string };

/** Durable run history, its own page reached from the header and independent of the session dock: one project's runs, or every project's with their names. */
export function ProjectRunHistory<Run extends ListedRun>({ runs, selected, onSelect }: { runs: Run[]; selected: string | null; onSelect(run: Run): void }) {
  const sorted = [...runs].sort((a, b) => b.started_at - a.started_at || b.run_id.localeCompare(a.run_id, undefined, { numeric: true }));
  if (runs.length === 0) return <div className="project-history-empty"><Icon name="clock" size={24} /><strong>No simulations yet.</strong><p>Start a simulation from a project’s Review step. Its results will be saved here.</p></div>;
  return <ul className="project-history-list">
    {sorted.map((run) => {
      const people = runSetup(run.config).personas.length;
      return <li key={`${run.project_id ?? ''}/${run.run_id}`}><button type="button" className="project-history-run" aria-current={selected === run.run_id ? 'true' : undefined} onClick={() => onSelect(run)}>
        <span className="project-history-run-top"><span className="project-history-status" data-status={run.status}><Icon name={run.status === 'finished' ? 'check' : run.status === 'running' ? 'activity' : run.status === 'interrupted' ? 'alert' : 'clock'} size={13} />{STATUS[run.status]}</span><span>{when(run.started_at)}</span></span>
        <strong>{run.config.project.goal || 'Simulation'}</strong>
        <span className="project-history-run-bottom"><span>{run.project_name && <>{run.project_name} · </>}{run.run_id} · {people} {people === 1 ? 'person' : 'people'}{run.config.repeat && ` · repeat ${run.config.repeat.index} of ${run.config.repeat.of}`}</span><span>{selected === run.run_id ? 'Last viewed' : run.status === 'running' ? 'View simulation' : 'View report'}<Icon name="arrow" size={13} /></span></span>
      </button></li>;
    })}
  </ul>;
}
