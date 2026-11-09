import { useEffect, useState } from 'react';
import { webPois, withPois } from '@gnomi/simulation/poi/pois.ts';
import type { RunEstimate, RunRow, SessionInfo } from '@gnomi/simulation/types.ts';
import { BRIEF_MAX } from '@gnomi/simulation/agent/prompt.ts';
import { QUESTION_WARNING } from '@gnomi/simulation/agent/interview.ts';
import { runSetup } from './activity.ts';
import { estimateText, unpricedText } from './cost.ts';
import { call, errorText } from './engine.ts';
import { Icon } from './Icon.tsx';
import { Button, Check, Dialog, Field, inputClass, Note, NumberInput, OutcomeNote, useAction, usd } from './ui.tsx';

/** A finished run again, on the personas, goal, models and limits it froze: only where the build lives, how often and a reset can change. */
export function RunAgain({ run, running, brief, onClose, onStarted }: { run: RunRow; running: boolean; brief?: { persona_id: string; text: string }; onClose(): void; onStarted(runId: string): void }) {
  const { project, repeat } = run.config;
  const persona = brief && run.config.personas.find((candidate) => candidate.id === brief.persona_id);
  const segment = project.audience?.segments.find((candidate) => candidate.id === persona?.segment_id);
  const [text, setText] = useState(brief?.text ?? '');
  const [role, setRole] = useState<string | null>(persona?.segment_id ? segment?.role ?? null : project.role);
  const [logins, setLogins] = useState<SessionInfo[]>([]);
  useEffect(() => { if (brief) void call('get_project', {}).then((loaded) => setLogins(loaded.sessions), () => {}); }, [brief]);
  const asBrief = brief && { persona_id: brief.persona_id, text: text.trim(), role };
  const personaId = brief?.persona_id;
  const pois = project.comparison ? [] : webPois(withPois(project).pois);
  const [urls, setUrls] = useState<Record<string, string>>(() => Object.fromEntries(pois.map((poi) => [poi.id, poi.start_url])));
  const [repeats, setRepeats] = useState(1);
  const [reset, setReset] = useState(false);
  const [returning, setReturning] = useState(!!brief);
  const [estimate, setEstimate] = useState<RunEstimate | { error: string } | null>(null);
  const { busy, outcome, run: act } = useAction();
  useEffect(() => {
    let current = true;
    // The words do not change the cost, so typing them does not ask again; any non-blank text stands in for them.
    call('estimate_run', { run_id: run.run_id, repeats, returning, brief: personaId ? { persona_id: personaId, text: 'x', role } : undefined }).then(
      (result) => current && setEstimate(result),
      (err) => current && setEstimate({ error: errorText(err) }),
    );
    return () => {
      current = false;
    };
  }, [run.run_id, repeats, returning, personaId, role]);
  const budget = (runSetup(run.config).costBudget ?? 0) * (repeat?.of ?? 1); // a run of a set froze its share
  const unpriced = estimate && !('error' in estimate) ? unpricedText(estimate) : null;
  const start = () =>
    act(async () => {
      const moved = pois.filter((poi) => urls[poi.id] !== poi.start_url).map((poi) => [poi.id, urls[poi.id]]);
      const { run_id } = await call('duplicate_run', { run_id: run.run_id, reset, repeats, urls: Object.fromEntries(moved), returning, brief: asBrief });
      onStarted(run_id);
      return null;
    });
  return (
    <Dialog title={brief ? 'Run again with a brief' : 'Run again'} onCancel={onClose}>
      {brief ? <p className="text-sm text-stone-700">{persona?.name ?? 'The persona'} runs again alone, on your words, signed in as {role ?? 'logged out'}, with social rounds off. Compare it with {run.run_id} afterwards: findings under a brief are not before-and-after evidence.</p> : <p className="text-sm text-stone-700">The same personas, goal, models and limits as {run.run_id}, as that run froze them. Point it at a new build, such as a preview, to compare the two afterwards.</p>}
      {brief && <Field label="Brief" hint={QUESTION_WARNING}><textarea className={inputClass} rows={4} maxLength={BRIEF_MAX} value={text} onChange={(e) => setText(e.target.value)} /></Field>}
      {brief && <Field label="Signed in as"><select className={inputClass} value={role ?? ''} onChange={(e) => setRole(e.target.value || null)}><option value="">Logged out</option>{[...new Set([...(role ? [role] : []), ...logins.map((login) => login.role)])].map((name) => <option key={name} value={name}>{name}</option>)}</select></Field>}
      {pois.map((poi) => <Field key={poi.id} label={`Address of ${poi.name}`} hint="A new host joins this run's allowed hosts."><input className={inputClass} value={urls[poi.id]} onChange={(e) => setUrls({ ...urls, [poi.id]: e.target.value })} /></Field>)}
      {!project.comparison && !brief && <Field label="Repeat runs"><NumberInput label="Repeat runs" value={repeats} onChange={setRepeats} min={1} max={10} step={1} /></Field>}
      {pois.some((poi) => poi.reset_hook_url !== null) && <Check checked={reset} onChange={setReset}>Reset staging before {repeats > 1 ? 'each run' : 'the run'}</Check>}
      {!project.comparison && <Check checked={returning} onChange={setReturning}>Personas remember {run.run_id}, though prior knowledge can hide first-use problems</Check>}
      <p className="text-sm text-stone-700">{estimate === null ? 'Working out the estimate…' : 'error' in estimate ? `No estimate: ${estimate.error}` : unpriced ? 'No estimate until every model has a price.' : `${estimateText(estimate)}, with a cost limit of ${usd(budget)}${repeats > 1 ? ` shared across ${repeats} runs` : ''}.`}</p>
      {estimate && !('error' in estimate) && estimate.cost_usd[1] > budget && <Note tone="info">The estimate may be more than the cost limit, so the run could stop early.</Note>}
      {unpriced && <Note tone="error">{`${unpriced} This run froze its models, so it cannot start again until they have a price.`}</Note>}
      {running && <Note tone="info">A simulation is already running for this project. Wait for it to end.</Note>}
      <OutcomeNote outcome={outcome} />
      <div className="flex flex-wrap justify-end gap-3">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void start()} loading={busy} disabled={running || (!!brief && !text.trim()) || estimate === null || 'error' in estimate || unpriced !== null}><Icon name="play" size={16} />Start run</Button>
      </div>
    </Dialog>
  );
}
