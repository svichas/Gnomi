import { useEffect, useMemo, useState } from 'react';
import type { GnomiEvent, RunConfig, RunRow } from '@gnomi/engine/types.ts';
import { runSetup } from './activity.ts';
import { runProgress } from './runProgress.ts';
import { missingUsageText, recordedCost } from './cost.ts';
import { Button, usd } from './ui.tsx';
import { Icon } from './Icon.tsx';

function elapsedText(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function RunStatus({ events, config, row, reportAvailable, waiting, stopping, onStop, compact = false }: {
  events: GnomiEvent[];
  config?: RunConfig;
  row?: RunRow;
  reportAvailable: boolean;
  waiting: number;
  stopping: boolean;
  onStop(): void;
  compact?: boolean;
}) {
  const progress = useMemo(() => runProgress(events, config, row?.status, reportAvailable), [events, config, row?.status, reportAvailable]);
  const usage = useMemo(() => recordedCost(events), [events]);
  const budget = config?.project.settings?.cost_budget_usd;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (progress.ended) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress.ended]);
  const start = events.find((event) => event.type === 'run.started')?.ts ?? row?.started_at;
  const end = events.findLast((event) => event.type === 'run.finished' || event.type === 'run.stopped')?.ts ?? row?.ended_at;
  const elapsed = start ? elapsedText((progress.ended ? end ?? events.at(-1)?.ts ?? start : now) - start) : 'Starting…';
  const attention = waiting > 0 && !progress.ended;
  const status = stopping && !progress.ended ? 'Stopping safely' : attention ? 'Needs your attention' : progress.label;
  const currentStage = progress.phase === 'exploring' ? 'exploration' : progress.phase === 'discussing' ? 'discussion' : ['reporting', 'saving'].includes(progress.phase) ? 'report' : null;
  const partial = progress.phase === 'stopped' || progress.phase === 'interrupted';
  const state = progress.complete ? 'complete' : partial ? 'stopped' : attention ? 'attention' : 'live';
  const issue = missingUsageText(usage.unreported_usage_calls);

  return <section aria-label="Run status" className={`run-status simulation-status${compact ? ' simulation-status-compact' : ''}`} data-state={state}>
    <div className="simulation-status-heading">
      <div className="simulation-status-copy">
        <p className="simulation-state" role="status"><span className="simulation-state-dot" />{status}</p>
        <h2 className="run-title">{progress.complete ? 'Your findings are ready.' : partial ? 'This simulation has ended.' : attention ? 'Help your audience continue.' : progress.phase === 'reporting' || progress.phase === 'saving' ? 'Bringing the findings together.' : 'A closer look at their experience.'}</h2>
        {config && <p className="simulation-goal"><span>Goal</span>{config.project.goal}</p>}
      </div>
      {!progress.ended && <Button variant="quiet" className="simulation-stop" onClick={onStop} disabled={stopping}><span aria-hidden="true" className="stop-symbol" />{stopping ? 'Stopping…' : 'Stop run'}</Button>}
    </div>

    <div className="simulation-progress-heading"><span>{partial ? 'Work completed before ending' : 'Simulation progress'}</span><strong>{progress.percent}<span>%</span></strong></div>
    <div role="progressbar" aria-label="Simulation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-valuetext={`${progress.percent}% of planned work. ${progress.detail}`} className="simulation-meter"><span style={{ width: `${progress.percent}%` }} /></div>
    <p className="simulation-progress-detail">{stopping && !progress.ended ? 'Finishing actions already in progress and canceling outstanding requests.' : attention ? `${waiting} ${waiting === 1 ? 'person needs' : 'people need'} help. Resolve the request below to continue.` : progress.detail}</p>
    <ol className="simulation-stages" aria-label="Simulation stages">
      {progress.stages.map((stage, index) => <li key={stage.id} data-state={stage.state} aria-current={stage.id === currentStage ? 'step' : undefined}>
        <span className="simulation-stage-number">{stage.state === 'complete' ? <Icon name="check" size={12} /> : index + 1}</span>
        <span><strong>{stage.label}</strong><small>{stage.detail}</small></span>
      </li>)}
    </ol>
    <div className="simulation-metadata">
      <span><Icon name="clock" size={14} />{elapsed} {progress.ended ? 'duration' : 'elapsed'}</span>
      <span><Icon name="people" size={14} />{runSetup(config).personas.length} simulated people</span>
      <span className="simulation-cost">{usd(usage.cost_usd)} recorded{budget != null && ` · ${usd(budget)} limit`}</span>
    </div>
    {issue && <p className="simulation-usage-note" role="status">{issue}</p>}
  </section>;
}
