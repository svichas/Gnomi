import { useEffect, useState } from 'react';
import { webPois, withPois } from '@gnomi/simulation/poi/pois.ts';
import type { RunEstimate, RunRow } from '@gnomi/simulation/types.ts';
import { runSetup } from './activity.ts';
import { estimateText } from './cost.ts';
import { call, errorText } from './engine.ts';
import { Icon } from './Icon.tsx';
import { Button, Check, Dialog, Field, inputClass, Note, NumberInput, OutcomeNote, useAction, usd } from './ui.tsx';

/** A finished run again, on the personas, goal, models and limits it froze: only where the build lives, how often and a reset can change. */
export function RunAgain({ run, running, onClose, onStarted }: { run: RunRow; running: boolean; onClose(): void; onStarted(runId: string): void }) {
  const { project, repeat } = run.config;
  const pois = project.comparison ? [] : webPois(withPois(project).pois);
  const [urls, setUrls] = useState<Record<string, string>>(() => Object.fromEntries(pois.map((poi) => [poi.id, poi.start_url])));
  const [repeats, setRepeats] = useState(1);
  const [reset, setReset] = useState(false);
  const [estimate, setEstimate] = useState<RunEstimate | { error: string } | null>(null);
  const { busy, outcome, run: act } = useAction();
  useEffect(() => {
    let current = true;
    call('estimate_run', { run_id: run.run_id, repeats }).then(
      (result) => current && setEstimate(result),
      (err) => current && setEstimate({ error: errorText(err) }),
    );
    return () => {
      current = false;
    };
  }, [run.run_id, repeats]);
  const budget = (runSetup(run.config).costBudget ?? 0) * (repeat?.of ?? 1); // a run of a set froze its share
  const start = () =>
    act(async () => {
      const moved = pois.filter((poi) => urls[poi.id] !== poi.start_url).map((poi) => [poi.id, urls[poi.id]]);
      const { run_id } = await call('duplicate_run', { run_id: run.run_id, reset, repeats, urls: Object.fromEntries(moved) });
      onStarted(run_id);
      return null;
    });
  return (
    <Dialog title="Run again" onCancel={onClose}>
      <p className="text-sm text-stone-700">The same personas, goal, models and limits as {run.run_id}, as that run froze them. Point it at a new build, such as a preview, to compare the two afterwards.</p>
      {pois.map((poi) => <Field key={poi.id} label={`Address of ${poi.name}`} hint="A new host joins this run's allowed hosts."><input className={inputClass} value={urls[poi.id]} onChange={(e) => setUrls({ ...urls, [poi.id]: e.target.value })} /></Field>)}
      {!project.comparison && <Field label="Repeat runs"><NumberInput label="Repeat runs" value={repeats} onChange={setRepeats} min={1} max={10} step={1} /></Field>}
      {pois.some((poi) => poi.reset_hook_url !== null) && <Check checked={reset} onChange={setReset}>Reset staging before {repeats > 1 ? 'each run' : 'the run'}</Check>}
      <p className="text-sm text-stone-700">{estimate === null ? 'Working out the estimate…' : 'error' in estimate ? `No estimate: ${estimate.error}` : `${estimateText(estimate)}, with a cost limit of ${usd(budget)}${repeats > 1 ? ` shared across ${repeats} runs` : ''}.`}</p>
      {estimate && !('error' in estimate) && estimate.cost_usd[1] > budget && <Note tone="info">The estimate may be more than the cost limit, so the run could stop early.</Note>}
      {running && <Note tone="info">A simulation is already running for this project. Wait for it to end.</Note>}
      <OutcomeNote outcome={outcome} />
      <div className="flex flex-wrap justify-end gap-3">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void start()} loading={busy} disabled={running || estimate === null || 'error' in estimate}><Icon name="play" size={16} />Start run</Button>
      </div>
    </Dialog>
  );
}
