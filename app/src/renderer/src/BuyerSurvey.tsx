import type { Report, ReportBuyers, ReportLike } from '@gnomi/simulation/types.ts';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`;
const th = 'px-3 py-2 text-left text-xs font-medium text-stone-500';

function Top({ title, items }: { title: string; items: ReportLike[] }) {
  return (
    <div>
      <p className="text-xs font-medium text-stone-700">{title}</p>
      {items.length === 0 ? (
        <p className="text-sm text-stone-500">None</p>
      ) : (
        <ol className="list-decimal space-y-0.5 pl-5 text-sm text-stone-800">
          {items.slice(0, 5).map((item, i) => (
            <li key={i}>
              {item.text} <span className="text-xs text-stone-500">({item.personas} {item.personas === 1 ? 'persona' : 'personas'})</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Rows({ rows }: { rows: ReportBuyers[] }) {
  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-stone-200">
        <table className="w-full text-sm">
          <thead className="bg-stone-50">
            <tr>
              <th scope="col" className={th}>Segment</th>
              <th scope="col" className={th}>Surveyed</th>
              <th scope="col" className={th}>Mean sentiment, −2 to +2</th>
              <th scope="col" className={th}>Would buy or recommend</th>
              <th scope="col" className={th}>Price: low / fair / high / unclear</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map((row) => (
              <tr key={row.segment_id ?? row.name}>
                <th scope="row" className="px-3 py-2 text-left font-medium text-stone-900">{row.name}</th>
                <td className="px-3 py-2 tabular-nums">{row.surveyed}</td>
                <td className="px-3 py-2 tabular-nums">{signed(row.sentiment)}</td>
                <td className="px-3 py-2 tabular-nums">{pct(row.would_buy)}</td>
                <td className="px-3 py-2 tabular-nums">{row.price.low} / {row.price.fair} / {row.price.high} / {row.price.unclear}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.map((row) => (
        <div key={row.segment_id ?? row.name} className="grid gap-3 sm:grid-cols-2">
          <Top title={`${row.name}: what would stop them buying`} items={row.objections} />
          <Top title={`${row.name}: what was unclear`} items={row.unclear} />
        </div>
      ))}
    </>
  );
}

/** The buying survey of buyer segments (simulation/src/report/buyers.ts), per point of interest when there are several. */
export function BuyerSurvey({ rows, pois }: { rows: ReportBuyers[]; pois: Report['pois'] }) {
  const shown = pois.filter((poi) => rows.some((row) => row.poi_id === poi.id));
  return (
    <section aria-labelledby="buyers-title" className="space-y-3">
      <h3 id="buyers-title" className="text-base font-semibold text-stone-900">
        Buying survey
      </h3>
      {shown.map((poi) => (
        <section key={poi.id} aria-label={`Buying survey on ${poi.name}`} className="space-y-3">
          {pois.length > 1 && <h4 className="text-sm font-medium text-stone-900">{poi.name}</h4>}
          <Rows rows={rows.filter((row) => row.poi_id === poi.id)} />
        </section>
      ))}
      <p className="text-xs text-stone-500">From each buyer's survey after what they looked at, 0 is neutral. Means are per segment, without weighting.</p>
    </section>
  );
}
