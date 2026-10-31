import { useRef, useState } from 'react';
import { EDIT_DESCRIPTION_MAX, EDIT_TITLE_MAX, EDIT_WARNING } from '@gnomi/simulation/report/edits.ts';
import { REWORDED_TEXT } from '@gnomi/simulation/report/markdown.ts';
import type { ReportTheme, UnmatchedEdit } from '@gnomi/simulation/types.ts';
import { call } from './engine.ts';
import { Button, Field, inputClass, OutcomeNote, useAction } from './ui.tsx';

// What a team changes before sharing. The original stays on screen, as only exports read an edit, and none of these controls reach a file.

/** On a finding's line: in the app what its export will do, in a shared copy that the words are the team's. */
export function EditMark({ theme }: { theme: ReportTheme }) {
  const text = theme.reworded ? REWORDED_TEXT : theme.edit?.hidden ? 'Hidden from exports' : theme.edit ? 'Reworded for exports' : null;
  return text && <p className="report-finding-outcome">{text}</p>;
}

/** The original and the new wording side by side; a field the team left alone is the original in both. */
function Wording({ theme: { title, description, edit } }: { theme: ReportTheme }) {
  if (!edit?.new_title && !edit?.new_description) return null;
  return (
    <div className="report-edit-compare">
      <div><h5>As the run found it</h5><p className="font-medium">{title}</p><p>{description}</p></div>
      <div><h5>In exports, in your team's words</h5><p className="font-medium">{edit.new_title ?? title}</p><p>{edit.new_description ?? description}</p></div>
    </div>
  );
}

/** Hides a finding from exports, shows it again or rewords it there. No model is involved, and the numbers from the run cannot be changed. */
export function EditFinding({ runId, theme }: { runId: string; theme: ReportTheme }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const toggle = useRef<HTMLButtonElement>(null);
  const { busy, outcome, run } = useAction();
  const hidden = !!theme.edit?.hidden;
  const change = (edit: { hidden?: boolean; title?: string; description?: string }) =>
    run(async () => {
      await call('edit_finding', { run_id: runId, theme_id: theme.id, ...edit });
      setOpen(false);
      toggle.current?.focus();
      return null;
    });
  const reword = () => {
    setTitle(theme.edit?.new_title ?? '');
    setDescription(theme.edit?.new_description ?? '');
    setOpen(!open);
  };
  return (
    <div className="report-outcome-form">
      <Wording theme={theme} />
      <div className="report-study-actions">
        <Button variant="link" disabled={busy} onClick={() => void change({ hidden: !hidden })}>{hidden ? 'Show in exports' : 'Hide from exports'}</Button>
        <Button ref={toggle} variant="link" aria-expanded={open} onClick={reword}>Reword for sharing</Button>
      </div>
      {hidden && <p className="text-xs text-stone-500">Hidden findings stay here and are left out of every export, which says how many your team hid.</p>}
      {open && <div className="space-y-3">
        <p className="text-xs text-stone-500">Only exports use these words, and they mark the finding as reworded by your team. Leave a field blank to keep the run's wording.</p>
        <Field label="Title for exports" hint={EDIT_WARNING}><input className={inputClass} maxLength={EDIT_TITLE_MAX} value={title} placeholder={theme.title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Description for exports" hint={EDIT_WARNING}><textarea className={inputClass} rows={3} maxLength={EDIT_DESCRIPTION_MAX} value={description} placeholder={theme.description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Button small onClick={() => void change({ title, description })} loading={busy}>Save wording</Button>
      </div>}
      <OutcomeNote outcome={outcome} />
    </div>
  );
}

/** Edits a rejudge left with no finding. Each says what it was for, as the finding it covered is back in exports as it stands. */
export function UnmatchedEdits({ edits }: { edits: UnmatchedEdit[] }) {
  return (
    <section aria-labelledby="unmatched-edits-title" className="space-y-2">
      <h4 id="unmatched-edits-title" className="text-sm font-medium text-stone-900">Edits with no matching finding</h4>
      <p className="text-xs text-stone-500">These edits no longer match a finding, for example after the findings were judged again. What they hid or reworded is back in exports as the run now has it, so check them before you share.</p>
      <ul className="space-y-2">
        {edits.map((edit, i) => <li key={i} className="report-study-entry">
          <p className="text-sm font-medium text-stone-900">{edit.title}</p>
          <p className="text-sm text-stone-800">{edit.hidden ? 'Was hidden from exports' : `Was reworded: ${[edit.new_title, edit.new_description].filter(Boolean).join(' ')}`}</p>
        </li>)}
      </ul>
    </section>
  );
}
