import { FLOW_TEXT, flowEnded, flowLeftOut, poiName } from '@gnomi/simulation/report/markdown.ts';
import type { Report, ReportFlow } from '@gnomi/simulation/types.ts';
import { count, heading, OUTCOMES, Th } from './reportParts.tsx';

// No viewBox: the words stay at their size and only the bars stretch, so a 320 px screen reads as well as a wide one.
const ROW = 54; // px per page
const ARCS = 40; // px of the gutter the moves curve through
const TEXT = ARCS + 10; // px where a page's words and bar start
const BAR = 70; // percent of the width that everyone's bar takes; what is left holds the gutter on the narrowest screen
const NAME = 30; // characters of a page's name that fit a 320 px screen

/** The end of a long page name, which is what tells two pages apart; the table has them whole. */
const short = (page: string) => (page.length > NAME ? `…${page.slice(1 - NAME)}` : page);

const LEGEND = [['good', 'Ended here at the goal'], ['warn', 'Ended here otherwise'], ['neutral', 'Moved on']] as const;

function Moves({ flow }: { flow: ReportFlow }) {
  const rows = flow.pages.map(({ page }) => page);
  return flow.moves.map(({ from, to, personas }) => {
    const [a, b] = [rows.indexOf(from), rows.indexOf(to)];
    // Out below a page's middle and in above it, so the two directions between a pair never lie on one line.
    const [start, end] = [a * ROW + ROW / 2 + 5, b * ROW + ROW / 2 - 5];
    const bend = ARCS - Math.min(ARCS - 4, 6 + 6 * Math.abs(a - b)) * 4 / 3; // a Bézier reaches 3/4 of the way to its control points
    return (
      <g key={`${from}\u0000${to}`} className="report-flow-move">
        <title>{`${from} to ${to}: ${count(personas, 'persona')}`}</title>
        <path d={`M${ARCS} ${start}C${bend} ${start} ${bend} ${end} ${ARCS} ${end}`} strokeWidth={1 + (3 * personas) / flow.personas} />
        <path d={`M${ARCS} ${end}l-6 -3.5v7z`} />
      </g>
    );
  });
}

function Graph({ flow }: { flow: ReportFlow }) {
  const width = (n: number) => `${(n / flow.personas) * BAR}%`;
  return (
    <svg role="img" aria-label={`Moves of ${count(flow.personas, 'persona')} between ${count(flow.pages.length, 'page')}. The table below has the same counts.`} className="report-flow" width="100%" height={flow.pages.length * ROW}>
      <Moves flow={flow} />
      {flow.pages.map(({ page, reached, ended }, i) => {
        const top = i * ROW;
        const total = Object.values(ended).reduce((sum, n) => sum + n, 0);
        const bar = { x: TEXT, y: top + 36, height: 8 };
        return (
          <g key={page}>
            <title>{page}</title>
            <rect className="report-flow-node" x={ARCS} y={top + 6} width={2} height={ROW - 12} />
            <text className="report-flow-page" x={TEXT} y={top + 13}>{short(page)}</text>
            <text className="report-flow-count" x={TEXT} y={top + 29}>{reached} reached · {total} ended here</text>
            <rect {...bar} data-tone="neutral" width={width(reached)} />
            <rect {...bar} data-tone="warn" width={width(total)} />
            <rect {...bar} data-tone="good" width={width(ended.done ?? 0)} />
          </g>
        );
      })}
    </svg>
  );
}

function FlowTable({ flow }: { flow: ReportFlow }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200">
      <table className="w-full min-w-[30rem] text-sm">
        <thead className="bg-stone-50"><tr><Th>Page</Th><Th>Reached</Th><Th>Ended here</Th><Th>Moved on to</Th></tr></thead>
        <tbody className="divide-y divide-stone-100">
          {flow.pages.map(({ page, reached, ended }) => (
            <tr key={page}>
              <th scope="row" className="break-all px-3 py-2 text-left font-medium text-stone-900">{page}</th>
              <td className="px-3 py-2 tabular-nums">{reached}</td>
              <td className="px-3 py-2">{flowEnded(ended, (outcome) => OUTCOMES[outcome].text.toLowerCase())}</td>
              <td className="break-all px-3 py-2">{flow.moves.filter((move) => move.from === page).map((move) => `${move.to} (${move.personas})`).join(', ') || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How the personas moved through each web POI of the team's product, drawn and then counted in a table. */
export function Flow({ flows, pois }: { flows: ReportFlow[]; pois: Report['pois'] }) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-stone-600">{FLOW_TEXT}</p>
      {flows.map((flow) => {
        const poi = pois.find(({ id }) => id === flow.poi_id);
        const leftOut = flowLeftOut(flow);
        return (
          <section key={flow.poi_id} aria-label={poi?.name} className="space-y-3">
            {pois.length > 1 && poi && <h4 className={heading}>{poiName(poi)}</h4>}
            <Graph flow={flow} />
            <ul aria-label="Colours of the bars" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
              {LEGEND.map(([tone, text]) => <li key={tone} className="flex items-center gap-1.5"><span data-tone={tone} className="tone-dot" />{text}</li>)}
            </ul>
            {leftOut && <p className="text-sm text-stone-700">{leftOut}</p>}
            <FlowTable flow={flow} />
          </section>
        );
      })}
    </div>
  );
}
