import { useEffect, useRef, useState } from 'react';
import type { DiffStatus, ReportDiff, ThemeDiff } from '@gnomi/simulation/report/diff.ts';
import { changeText, DIFF_HINT, DIFF_LABEL, DIFF_NOTICE, diffText, diffTitle, pointsChange, spreadRows } from '@gnomi/simulation/report/markdown.ts';
import { call, errorText } from './engine.ts';
import { Icon } from './Icon.tsx';
import { SeverityChip } from './Report.tsx';
import { heading, SectionHeading, Th, Tile } from './reportParts.tsx';
import type { Tone } from './reportParts.tsx';
import { Button, Note } from './ui.tsx';

// Neutral, not good: the later run not showing a problem is not a win the screen may claim.
const STATUSES: { status: DiffStatus; tone: Tone; icon: 'alert' | 'activity' | 'clock' | 'search' }[] = [
  { status: 'new', tone: 'warn', icon: 'alert' },
  { status: 'unchanged', tone: 'neutral', icon: 'activity' },
  { status: 'not_retested', tone: 'neutral', icon: 'clock' },
  { status: 'fixed', tone: 'neutral', icon: 'search' },
];

function Theme({ theme, poi }: { theme: ThemeDiff; poi?: string }) {
  return (
    <li className="report-finding">
      <div className="report-finding-summary run-compare-theme">
        <div className="report-finding-copy"><h4>{diffTitle(theme)}</h4><p><span>{poi && `${poi}: `}{diffText(theme)}</span></p></div>
        <SeverityChip severity={theme.severity} />
      </div>
    </li>
  );
}

function Changes({ id, title, columns, rows }: { id: string; title: string; columns: string[]; rows: { name: string; cells: string[] }[] }) {
  return (
    <div className="space-y-3">
      <h3 id={id} className={heading}>{title}</h3>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling table region must be focusable so the keyboard can scroll it */}
      <div className="overflow-x-auto rounded-lg border border-stone-200" role="region" aria-labelledby={id} tabIndex={0}>
        <table className="w-full text-sm">
          <thead className="bg-stone-50"><tr>{columns.map((column) => <Th key={column}>{column}</Th>)}</tr></thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map(({ name, cells }) => (
              <tr key={name}>
                <th scope="row" className="px-3 py-2 text-left font-medium text-stone-900">{name}</th>
                {cells.map((text, i) => <td key={i} className="whitespace-nowrap px-3 py-2 tabular-nums text-stone-700">{text}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Two runs, or their repeat sets, side by side. It never says a problem is fixed: `fixed` is the data's word, for JSON readers. */
export function RunCompare({ base, run, onBack }: { base: string; run: string; onBack(): void }) {
  const [diff, setDiff] = useState<ReportDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  // The button that opened this view is gone, so focus would fall to the top of the window.
  useEffect(() => (diff ? title : error ? backButton : null)?.current?.focus(), [diff, error]);
  useEffect(() => {
    let current = true;
    call('compare_runs', { base, run }).then(
      (result) => current && setDiff(result),
      (err) => current && setError(errorText(err)),
    );
    return () => {
      current = false;
    };
  }, [base, run]);
  const poiName = (theme: ThemeDiff) => (diff && diff.pois.length > 1 ? diff.pois.find(({ id }) => id === theme.poi_id)?.name : undefined);
  const decimal = (n: number) => n.toFixed(2);
  return (
    <div className="run-compare">
      <Button ref={backButton} variant="quiet" className="back-button" onClick={onBack}><Icon name="back" size={18} />Back to past runs</Button>
      {error && <Note tone="error">{error}</Note>}
      {!diff && !error && <p role="status" className="text-sm text-stone-500">Comparing the two runs…</p>}
      {diff && <section aria-label="Comparison of two runs" className="report-page">
        <div className="report-header">
          <p className="report-eyebrow">Before and after</p>
          <h2 ref={title} tabIndex={-1}>{diff.before.join(', ')} to {diff.after.join(', ')}</h2>
        </div>
        <Note tone="info">{DIFF_NOTICE}</Note>
        <div className="report-stats run-compare-stats">
          {STATUSES.map(({ status, tone, icon }) => <Tile key={status} icon={icon} tone={tone} label={DIFF_LABEL[status]} value={String(diff.themes.filter((theme) => theme.status === status).length)} />)}
        </div>
        {diff.notes.length > 0 && <section aria-labelledby="compare-notes-title" className="space-y-2">
          <h3 id="compare-notes-title" className={heading}>What weakens this comparison</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-stone-700">{diff.notes.map((note) => <li key={note}>{note}</li>)}</ul>
        </section>}
        {diff.themes.length === 0 && <div className="report-empty"><Icon name="check" size={20} /><p>Neither side has any themes.</p></div>}
        {STATUSES.map(({ status }) => {
          const themes = diff.themes.filter((theme) => theme.status === status);
          return themes.length > 0 && <section key={status} aria-labelledby={`compare-${status}`}>
            <SectionHeading id={`compare-${status}`} title={<>{DIFF_LABEL[status]} <span>{themes.length}</span></>} hint={DIFF_HINT[status]} />
            <ol className="report-finding-list">{themes.map((theme, i) => <Theme key={i} theme={theme} poi={poiName(theme)} />)}</ol>
          </section>;
        })}
        {diff.segments.length > 0 && <Changes id="compare-segments" title="By segment" columns={['Segment', 'Mood, −2 to +2', 'Ran into friction']} rows={diff.segments.map((segment) => ({ name: segment.name, cells: [changeText(segment.sentiment, decimal), pointsChange(segment.with_friction)] }))} />}
        {diff.spread.length > 0 && <Changes id="compare-spread" title="Opinion spread" columns={['Product', 'Posts', 'Second-hand', 'Reached', 'Mean sentiment, last round']} rows={diff.spread.flatMap(spreadRows)} />}
      </section>}
    </div>
  );
}
