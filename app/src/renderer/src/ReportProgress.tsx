import { useEffect, useId, useMemo, useState } from 'react';
import type { GnomiEvent } from '@gnomi/engine/types.ts';
import { reportProgress } from './activity.ts';
import { Icon } from './Icon.tsx';

const STAGES = ['surveys', 'themes', 'suggestions'] as const;

/** What the report is doing between the last episode and the saved report: decorative motion around real progress from the log. */
export function ReportProgress({ events }: { events: GnomiEvent[] }) {
  const progress = useMemo(() => reportProgress(events), [events]);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const titleId = useId();
  const { surveys, pois } = progress;
  const percent = Math.round(progress.fraction * 100);
  const several = pois.total > 1 ? ` · ${pois.total} points of interest` : '';
  const steps: Record<(typeof STAGES)[number], { label: string; detail: string | null }> = {
    surveys: { label: 'Collecting their survey answers', detail: surveys.total ? `${surveys.done} of ${surveys.total}` : null },
    themes: { label: 'Grouping frictions into themes', detail: pois.total > 1 ? `${pois.themed} of ${pois.total} points of interest` : null },
    suggestions: { label: 'Writing suggested changes', detail: pois.total > 1 ? `${pois.suggested} of ${pois.total} points of interest` : null },
  };
  const current = STAGES.indexOf(progress.stage);
  return (
    <section className="build-progress report-progress" aria-labelledby={titleId}>
      <div className="build-scene">
        <ReportIllustration />
        <div className="build-counter" role="status" aria-atomic="true">
          <strong>{percent}%</strong>
          <span>{steps[progress.stage].label}</span>
        </div>
      </div>
      <div className="build-copy">
        <p className="eyebrow">Preparing the report{several}</p>
        <h3 id={titleId}>Turning their experiences into findings.</h3>
        <p>Gnomi gathers what each persona said, groups the frictions into themes and suggests changes. The report opens when it is ready.</p>
        <div role="progressbar" aria-label="Preparing the report" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${steps[progress.stage].label}, ${percent}%`} className="build-meter report-meter">
          <span style={{ width: `${Math.max(4, percent)}%` }} />
        </div>
        <ol className="report-steps">
          {STAGES.map((id, index) => {
            const state = index < current ? 'done' : index === current ? 'active' : 'pending';
            return (
              <li key={id} data-state={state} aria-current={state === 'active' ? 'step' : undefined}>
                <span className="report-step-mark">{state === 'done' ? <Icon name="check" size={12} /> : state === 'active' ? <span className="build-thinking" aria-hidden="true"><i /><i /><i /></span> : index + 1}</span>
                <span>{steps[id].label}{steps[id].detail && <small>{steps[id].detail}</small>}</span>
              </li>
            );
          })}
        </ol>
        <p className="build-caption">{Math.floor(seconds / 60)}m {seconds % 60}s elapsed</p>
      </div>
    </section>
  );
}

/** Notes from three personas drift into a report whose bars keep growing. */
function ReportIllustration() {
  const notes = [{ x: 22, y: 26, color: 'var(--gnomi-segment-3)' }, { x: 34, y: 78, color: 'var(--gnomi-segment-2)' }, { x: 18, y: 128, color: 'var(--gnomi-action)' }];
  return (
    <svg viewBox="0 0 320 180" fill="none" aria-hidden="true">
      <ellipse cx="160" cy="91" rx="132" ry="68" className="build-orbit" />
      <path d="M96 44C140 44 150 70 186 78M108 96H186M92 146C140 146 150 116 186 108" className="build-thread" />
      {notes.map(({ x, y, color }, i) => (
        <g key={i} transform={`translate(${x} ${y})`}>
          <g className={`build-person build-person-${i}`}>
            <rect width="74" height="34" rx="8" className="build-card" />
            <circle cx="16" cy="17" r="8" fill={color} fillOpacity=".2" />
            <circle cx="16" cy="15" r="3" fill={color} />
            <path d="M30 13h32M30 22h20" className="build-card-line" strokeWidth="3" />
          </g>
        </g>
      ))}
      <g transform="translate(190 30)">
        <rect width="104" height="124" rx="12" className="build-card" />
        <path d="M18 24h48" className="build-writing" />
        <path d="M18 38h68M18 50h52" className="build-card-line" strokeWidth="3" />
        {[0, 1, 2].map((i) => <rect key={i} x={22 + i * 24} y="66" width="14" height="40" rx="3" className={`report-bar report-bar-${i}`} />)}
      </g>
      <g className="build-spark"><path d="M176 22v10m-5-5h10M302 160v10m-5-5h10" /></g>
      <circle cx="152" cy="160" r="4" className="build-dot" />
    </svg>
  );
}
