import { useState } from 'react';
import { repeatLabel } from '@gnomi/simulation/report/markdown.ts';
import { uncounted } from '@gnomi/simulation/report/repeats.ts';
import type { RunRow } from '@gnomi/simulation/types.ts';
import { runSetup } from './activity.ts';
import { Icon } from './Icon.tsx';
import { Button, Field, inputClass, when } from './ui.tsx';
import './project-run-history.css';

const STATUS = { running: 'Running', finished: 'Completed', stopped: 'Stopped', interrupted: 'Interrupted' };

type ListedRun = RunRow & { project_id?: string; project_name?: string };

/** Picks two ended runs of the project, the newest two to begin with, for RunCompare. A comparison study compares tools, not builds, and a what-if run has the team's post. */
function CompareRuns({ runs, onCompare }: { runs: RunRow[]; onCompare(base: string, run: string): void }) {
  const choices = runs.filter((run) => run.status !== 'running' && !run.config.project.comparison && uncounted(run.config) !== 'what_if');
  const [picked, setPicked] = useState<{ base?: string; run?: string }>({});
  if (choices.length < 2) return null;
  const { base = choices[1].run_id, run = choices[0].run_id } = picked;
  const options = choices.map((choice) => <option key={choice.run_id} value={choice.run_id}>{choice.run_id} · {when(choice.started_at)}</option>);
  return <section aria-label="Compare two runs" className="project-history-compare">
    <Field label="Earlier run"><select className={inputClass} value={base} onChange={(e) => setPicked({ ...picked, base: e.target.value })}>{options}</select></Field>
    <Field label="Later run"><select className={inputClass} value={run} onChange={(e) => setPicked({ ...picked, run: e.target.value })}>{options}</select></Field>
    <Button onClick={() => onCompare(base, run)} disabled={base === run}>Compare</Button>
  </section>;
}

/** Durable run history, its own page reached from the header and independent of the session dock: one project's runs, or every project's with their names. */
export function ProjectRunHistory<Run extends ListedRun>({ runs, selected, onSelect, onCompare }: { runs: Run[]; selected: string | null; onSelect(run: Run): void; onCompare?(base: string, run: string): void }) {
  const sorted = [...runs].sort((a, b) => b.started_at - a.started_at || b.run_id.localeCompare(a.run_id, undefined, { numeric: true }));
  if (runs.length === 0) return <div className="project-history-empty"><Icon name="clock" size={24} /><strong>No simulations yet.</strong><p>Start a simulation from a project’s Review step. Its results will be saved here.</p></div>;
  return <>{onCompare && <CompareRuns runs={sorted} onCompare={onCompare} />}<ul className="project-history-list">
    {sorted.map((run) => {
      const people = runSetup(run.config).personas.length;
      return <li key={`${run.project_id ?? ''}/${run.run_id}`}><button type="button" className="project-history-run" aria-current={selected === run.run_id ? 'true' : undefined} onClick={() => onSelect(run)}>
        <span className="project-history-run-top"><span className="project-history-status" data-status={run.status}><Icon name={run.status === 'finished' ? 'check' : run.status === 'running' ? 'activity' : run.status === 'interrupted' ? 'alert' : 'clock'} size={13} />{STATUS[run.status]}</span><span>{when(run.started_at)}</span></span>
        <strong>{run.config.project.goal || 'Simulation'}</strong>
        <span className="project-history-run-bottom"><span>{run.project_name && <>{run.project_name} · </>}{run.run_id} · {people} {people === 1 ? 'person' : 'people'}{run.config.repeat && ` · repeat ${run.config.repeat.index} of ${run.config.repeat.of}${repeatLabel(run.config)}`}</span><span>{selected === run.run_id ? 'Last viewed' : run.status === 'running' ? 'View simulation' : 'View report'}<Icon name="arrow" size={13} /></span></span>
      </button></li>;
    })}
  </ul></>;
}
