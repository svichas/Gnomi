import { WHAT_IF_COLUMNS, whatIfCells, whatIfText } from '@gnomi/simulation/report/markdown.ts';
import type { WhatIfResult } from '@gnomi/simulation/report/repeats.ts';
import { SectionHeading, Th } from './reportParts.tsx';
import { Note } from './ui.tsx';

/** A what-if set's result, on the page of every run in the set: differences between matched runs, always with what they do not show. */
export function WhatIf({ whatIf }: { whatIf: WhatIfResult }) {
  return (
    <section aria-labelledby="what-if-title" className="space-y-3">
      <SectionHeading id="what-if-title" title="What-if post" hint="Matched runs with and without one post your team added." />
      <Note tone="info">{whatIf.note}</Note>
      <p className="report-goal report-study-entry">&ldquo;{whatIf.post}&rdquo;</p>
      <p className="text-sm text-stone-600">{whatIfText(whatIf)}</p>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling table region must be focusable so the keyboard can scroll it */}
      <div className="overflow-x-auto rounded-lg border border-stone-200" role="region" aria-label="What-if numbers" tabIndex={0}>
        <table className="w-full text-sm">
          <thead className="bg-stone-50"><tr>{WHAT_IF_COLUMNS.map((column) => <Th key={column}>{column}</Th>)}</tr></thead>
          <tbody className="divide-y divide-stone-100">
            {whatIf.numbers.map((number) => (
              <tr key={number.id}>
                <th scope="row" className="px-3 py-2 text-left font-medium text-stone-900">{number.label}</th>
                {whatIfCells(number).map((text, i) => <td key={i} className="whitespace-nowrap px-3 py-2 tabular-nums text-stone-700">{text}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
