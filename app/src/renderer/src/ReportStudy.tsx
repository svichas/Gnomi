import { useContext, useEffect, useRef, useState } from 'react';
import { droppedText, leftOutText, NO_SCREENER, NO_TASKS, OUTCOME_NOTE, outcomeDetails, outcomeText, OUTDATED_PLAN, STUDY_WARNING, studyCountText, studyPlanToMarkdown, UNMATCHED_NOTE } from '@gnomi/simulation/report/markdown.ts';
import { isTraitFree } from '@gnomi/simulation/report/repeats.ts';
import { competitorsOf, localDate, NOTE_MAX, NOTE_WARNING, topFindings } from '@gnomi/simulation/report/study.ts';
import { STUDY_STATUSES } from '@gnomi/simulation/types.ts';
import type { Report as ReportData, ReportStudyPlan, ReportTheme, RunEstimate, StudyStatus, ThemeValidation } from '@gnomi/simulation/types.ts';
import { unpricedText } from './cost.ts';
import { call, errorText } from './engine.ts';
import { Icon } from './Icon.tsx';
import { InFile, SectionHeading } from './reportParts.tsx';
import { Button, Field, inputClass, Note, OutcomeNote, useAction, usd } from './ui.tsx';

// What goes from a report to real people and back. Everything here sits apart from the simulated numbers and says whose it is.

/** An outcome's note, and the title it was recorded for when a rejudge has renamed the finding. */
export function OutcomeDetails({ outcome, title }: { outcome: ThemeValidation; title?: string }) {
  return outcomeDetails(outcome, title).map((text) => <p key={text} className="report-study-entry text-sm text-stone-700">{text}</p>);
}

/** Records what the team's own study found; a few clicks, as a team that has to type much will not do it. No model is involved. */
export function RecordOutcome({ runId, theme }: { runId: string; theme: ReportTheme }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<StudyStatus | ''>('');
  const [date, setDate] = useState(() => localDate());
  const [note, setNote] = useState('');
  const toggle = useRef<HTMLButtonElement>(null);
  const { busy, outcome, run } = useAction();
  const save = () =>
    run(async () => {
      await call('record_outcome', { run_id: runId, theme_id: theme.id, status: status as StudyStatus, study_date: date, note });
      // The outcome now shows on the finding, so a form left full would only invite a second record.
      setOpen(false);
      setStatus('');
      setNote('');
      toggle.current?.focus();
      return null;
    });
  return (
    <div className="report-outcome-form">
      <Button ref={toggle} variant="link" aria-expanded={open} onClick={() => setOpen(!open)}>{theme.validation ? 'Correct the study outcome' : 'Record a study outcome'}</Button>
      {open && <div className="space-y-3">
        <p className="text-xs text-stone-500">What your team saw with real people. The latest one counts, and it changes no simulated number.</p>
        <div className="report-outcome-fields">
          <Field label="What your study found">
            <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as StudyStatus)}>
              <option value="">Choose</option>
              {STUDY_STATUSES.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
            </select>
          </Field>
          <Field label="Study date"><input type="date" className={inputClass} value={date} max={localDate()} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Field label="Note, optional" hint={NOTE_WARNING}><textarea className={inputClass} rows={2} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Button small onClick={() => void save()} loading={busy} disabled={!status || !date}>Save study outcome</Button>
        <OutcomeNote outcome={outcome} />
      </div>}
    </div>
  );
}

function Entries({ items, empty, ordered }: { items: string[]; empty: string; ordered?: boolean }) {
  if (items.length === 0) return <p className="text-sm text-stone-600">{empty}</p>;
  const List = ordered ? 'ol' : 'ul';
  return <List className={`report-study-entry space-y-1 pl-5 text-sm text-stone-800 ${ordered ? 'list-decimal' : 'list-disc'}`}>{items.map((item, i) => <li key={i}>{item}</li>)}</List>;
}

function Plan({ plan }: { plan: ReportStudyPlan }) {
  const dropped = droppedText(plan.screener_dropped);
  const leftOut = leftOutText(plan.left_out);
  return (
    <div className="report-study-plan space-y-4">
      <Note tone="info">{STUDY_WARNING}</Note>
      {plan.outdated && <p className="text-sm text-stone-600">{OUTDATED_PLAN}</p>}
      <section aria-label="Screener" className="space-y-2">
        <h4>Screener</h4>
        <Entries items={plan.screener} empty={NO_SCREENER} />
        {dropped && <p className="text-xs text-stone-500">{dropped}</p>}
      </section>
      {plan.hypotheses.map((hypothesis, i) => {
        const left = droppedText(hypothesis.dropped);
        return (
          <section key={i} aria-label={`Hypothesis ${i + 1}`} className="space-y-2">
            <h4 className="report-study-entry">Hypothesis {i + 1}: {hypothesis.title}</h4>
            <h5>Tasks</h5>
            <Entries items={hypothesis.tasks} empty={NO_TASKS} ordered />
            {left && <p className="text-xs text-stone-500">{left}</p>}
            <h5>For the researcher, what to watch for</h5>
            <Entries items={hypothesis.observe} empty="Nothing was written." />
          </section>
        );
      })}
      {leftOut && <p className="text-xs text-stone-500">{leftOut}</p>}
    </div>
  );
}

/** The plan's words, as study-plan.md has them, so what is copied is what the CLI would hand over. */
function PlanActions({ report, plan }: { report: ReportData; plan: ReportStudyPlan }) {
  const { busy, outcome, run } = useAction();
  const markdown = studyPlanToMarkdown(report, plan);
  const copy = () => run(async () => { await navigator.clipboard.writeText(markdown); return { ok: true, text: 'Study plan copied.' }; });
  const save = () =>
    run(async () => {
      const path = await window.gnomi.saveReport('md', `${report.run_id}-study-plan`, markdown);
      return path === null ? null : { ok: true, text: `Study plan exported to ${path}` };
    });
  return (
    <div className="report-study-actions">
      <Button small onClick={() => void copy()} disabled={busy}>Copy the plan</Button>
      <Button small onClick={() => void save()} disabled={busy}><Icon name="down" size={16} />Export the plan</Button>
      <OutcomeNote outcome={outcome} />
    </div>
  );
}

/** Spends money, so it says how much at most and waits for a click. */
function PlanButton({ runId, again }: { runId: string; again: boolean }) {
  const [estimate, setEstimate] = useState<RunEstimate | { error: string } | null>(null);
  const { busy, outcome, run } = useAction();
  useEffect(() => {
    let current = true;
    call('estimate_study', { run_id: runId }).then(
      (result) => current && setEstimate(result),
      (err) => current && setEstimate({ error: errorText(err) }),
    );
    return () => {
      current = false;
    };
  }, [runId]);
  const unpriced = estimate && !('error' in estimate) ? unpricedText(estimate) : null;
  const cost = estimate === null ? 'Working out the cost…' : 'error' in estimate ? estimate.error : unpriced ?? `One model call. It costs at most ${usd(estimate.cost_usd[1])}, added to this run's cost.`;
  const plan = () =>
    run(async () => {
      await call('plan_study', { run_id: runId }); // the plan arrives with the report, on report.generated
      return { ok: true, text: 'Study plan written above.' };
    });
  return (
    <div className="report-export">
      <div className="report-export-copy"><Icon name="spark" size={20} /><div><strong>{again ? 'Plan the study again' : 'Turn the top findings into a study'}</strong><p>{cost}</p></div></div>
      <Button onClick={() => void plan()} loading={busy} disabled={estimate === null || 'error' in estimate || unpriced !== null}>{again ? 'Plan again' : 'Plan a study'}</Button>
      <OutcomeNote outcome={outcome} />
    </div>
  );
}

/** A generated plan and what the team's studies found, under the simulated findings and apart from them. An export carries what exists and no controls. */
export function Study({ report }: { report: ReportData }) {
  const inFile = useContext(InFile);
  const { study_plan: plan, study_count: tally, unmatched_outcomes: unmatched = [] } = report;
  const findings = isTraitFree(report) ? 0 : topFindings(report.themes ?? [], competitorsOf(report)).length; // a control is no sample to plan a study from
  if (!plan && !tally && unmatched.length === 0 && (inFile || findings === 0)) return null;
  return (
    <section aria-labelledby="study-title" className="report-study">
      <SectionHeading id="study-title" title="Check with real people" hint="Kept apart from the simulated numbers above." />
      <div className="space-y-4">
        {tally && <p className="report-goal">{studyCountText(tally)}</p>}
        {unmatched.length > 0 && (
          <section aria-labelledby="unmatched-title" className="space-y-2">
            <h4 id="unmatched-title">Study outcomes with no matching finding</h4>
            <p className="text-xs text-stone-500">{UNMATCHED_NOTE}</p>
            <ul className="space-y-2">
              {unmatched.map((outcome, i) => <li key={i} className="report-study-entry"><p className="text-sm font-medium text-stone-900">{outcome.title}</p><p className="text-sm text-stone-800">{outcomeText(outcome)}</p><OutcomeDetails outcome={outcome} /></li>)}
            </ul>
          </section>
        )}
        {(tally || unmatched.length > 0) && <p className="text-xs text-stone-500">{OUTCOME_NOTE}</p>}
        {plan && <Plan plan={plan} />}
        {!inFile && plan && <PlanActions report={report} plan={plan} />}
        {!inFile && findings > 0 && <PlanButton runId={report.run_id} again={!!plan} />}
      </div>
    </section>
  );
}
