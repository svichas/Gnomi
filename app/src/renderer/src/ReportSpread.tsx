import type { ReportPersona, ReportSpread, SpreadStats } from '@gnomi/simulation/types.ts';
import { count, PersonaLink, signed } from './reportParts.tsx';
import type { Inspect } from './reportParts.tsx';

/** Mean sentiment at each round's end on a −2…+2 scale, 0 dashed; each value is also written out beside it. */
function SentimentLine({ rows }: { rows: SpreadStats['sentiment'] }) {
  const points = rows.flatMap((r) => (r.mean === null ? [] : [{ ...r, mean: r.mean }]));
  if (points.length === 0) return <p className="text-xs text-stone-500">No opinions recorded.</p>;
  const width = 168;
  const x = (round: number) => (rows.length === 1 ? (width + 16) / 2 : 24 + ((round - 1) / (rows.length - 1)) * (width - 32));
  const y = (mean: number) => 8 + ((2 - mean) / 4) * 48;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <svg viewBox={`0 0 ${width} 64`} width={width} height={64} aria-hidden="true" className="shrink-0 overflow-visible">
        {([[2, '+2'], [0, '0'], [-2, '−2']] as const).map(([v, label]) => (
          <g key={v}>
            <text x={0} y={y(v) + 3} className="fill-stone-400 text-[9px] tabular-nums">{label}</text>
            <line x1={16} x2={width} y1={y(v)} y2={y(v)} strokeDasharray={v === 0 ? '3 3' : undefined} className={v === 0 ? 'stroke-stone-400' : 'stroke-stone-200'} />
          </g>
        ))}
        <polyline points={points.map((p) => `${x(p.round)},${y(p.mean)}`).join(' ')} fill="none" strokeWidth={2} strokeLinejoin="round" className="stroke-indigo-600" />
        {points.map((p) => (
          <circle key={p.round} cx={x(p.round)} cy={y(p.mean)} r={4} strokeWidth={2} className="fill-indigo-600 stroke-white">
            <title>{`Round ${p.round}: ${signed(p.mean)} (${count(p.personas, 'persona')})`}</title>
          </circle>
        ))}
      </svg>
      <ol className="flex flex-wrap gap-x-3 text-xs tabular-nums text-stone-600" aria-label="Mean sentiment by round, −2 to +2">
        {rows.map((r) => (
          <li key={r.round}>
            Round {r.round}: {r.mean === null ? 'no opinions' : signed(r.mean)}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** One POI's or theme's spread: counts, seed posts, repeats, segments reached, influence and the sentiment line. */
function SpreadBody({ stats, personas, onInspect }: { stats: SpreadStats; personas: ReportPersona[]; onInspect: Inspect }) {
  const name = (id: string) => personas.find((persona) => persona.id === id)?.name ?? id;
  const crossed = stats.segments.filter((segment) => !segment.seed).length;
  const figures = [
    ['Posts', stats.posts],
    ...(stats.posters ? [['Posted', stats.posters.length], ['Reached', stats.readers?.length ?? 0]] as const : []),
    ['First-hand', stats.first_hand.length],
    ['Second-hand', stats.second_hand.length],
    ['Influence edges', stats.influence.length],
  ] as const;
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {figures.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-stone-50 px-3 py-1.5">
            <dt className="text-xs text-stone-500">{label}</dt>
            <dd className="font-medium tabular-nums text-stone-900">{value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="text-xs font-medium text-stone-700">Seed posts</p>
        <ul className="mt-1 space-y-2">
          {stats.seeds.map((post) => (
            <li key={post.post_id} className="border-l-4 border-stone-200 pl-3">
              <p className="flex flex-wrap gap-x-2 text-xs text-stone-500">
                <PersonaLink id={post.persona_id} name={post.persona_name} seq={post.seq} onInspect={onInspect} />
                <span>round {post.round}</span>
                {post.injected && <span className="font-medium text-amber-800">added by your team</span>}
              </p>
              <p className="text-stone-900">&ldquo;{post.text}&rdquo;</p>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-stone-700">
        <span className="font-medium">Repeated without their own friction:</span>{' '}
        {stats.second_hand.length === 0 ? 'nobody' : stats.second_hand.map(name).join(', ')}
      </p>
      <p className="text-stone-700">
        <span className="font-medium">Segments reached:</span>{' '}
        {stats.segments.map((segment) => `${segment.name} ${segment.personas}${segment.seed ? ' (seed)' : ''}`).join(', ') || 'none'}. Crossed into {count(crossed, 'other segment')}.
      </p>
      {stats.influence.length > 0 && (
        <div>
          <p className="text-xs font-medium text-stone-700">Influence</p>
          <ul className="text-stone-700">
            {stats.influence.slice(0, 5).map((edge) => (
              <li key={`${edge.seq}/${edge.post_id}`}>
                {name(edge.from)} → {name(edge.to)}, round {edge.round}, sentiment {signed(edge.delta)}
              </li>
            ))}
          </ul>
          {stats.influence.length > 5 && <p className="text-xs text-stone-500">And {count(stats.influence.length - 5, 'more edge')}.</p>}
        </div>
      )}
      {stats.heard && stats.heard.length > 0 && (
        <div>
          <p className="text-xs font-medium text-stone-700">Heard before a change of mind, not counted as influence</p>
          <ul className="text-stone-700">
            {stats.heard.slice(0, 5).map((edge) => (
              <li key={`${edge.seq}/${edge.from}`}>
                {name(edge.from)} → {name(edge.to)}, round {edge.round}, sentiment {signed(edge.delta)}
              </li>
            ))}
          </ul>
          {stats.heard.length > 5 && <p className="text-xs text-stone-500">And {count(stats.heard.length - 5, 'more')}.</p>}
        </div>
      )}
      <div>
        <p className="text-xs font-medium text-stone-700">Mean sentiment by round, −2 to +2</p>
        <SentimentLine rows={stats.sentiment} />
      </div>
    </div>
  );
}

/** How talk about the product and each theme travelled on the simulated feed (tech.md §8.2 step 7). */
export function Spread({ spread, personas, onInspect }: { spread: ReportSpread[]; personas: ReportPersona[]; onInspect: Inspect }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-stone-500">
        First-hand: personas who met it before reading about it, as the problem counts them. Second-hand: personas who posted about it without meeting it first-hand. Reached: personas shown a post about it in a feed or at a step. Influence: a cited post moved a persona's sentiment by 0.5 or more, once per author and change.
      </p>
      {spread.length === 0 && <p className="text-sm text-stone-600">No post was about a particular text, design or site.</p>}
      {spread.map((poi) => (
        <div key={poi.poi_id} className="space-y-4">
          <div className="space-y-2 rounded-lg border border-stone-200 p-4">
            <h4 className="font-medium text-stone-900">About {poi.name}</h4>
            <SpreadBody stats={poi} personas={personas} onInspect={onInspect} />
          </div>
          {poi.themes.length > 0 && (
            <ol className="space-y-4" aria-label={`Themes talked about on the feed, about ${poi.name}`}>
              {poi.themes.map((theme) => (
                <li key={theme.theme_id} className="space-y-2 rounded-lg border border-stone-200 p-4">
                  <h4 className="font-medium text-stone-900">{theme.title}</h4>
                  <SpreadBody stats={theme} personas={personas} onInspect={onInspect} />
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </div>
  );
}
