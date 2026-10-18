import { useEffect, useId, useState } from 'react';
import type { PersonaProgress } from '@gnomi/simulation/types.ts';

/** Decorative motion surrounds real engine progress; audience planning has no invented percentage. */
export function BuildProgress({ kind, progress }: { kind: 'audience' | 'personas'; progress: PersonaProgress | null }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const titleId = useId();
  const writing = kind === 'personas';
  const counted = writing && progress !== null && progress.total > 0;
  const finishing = counted && progress.done === progress.total;
  // Two steps per persona, sketch then biography, so the meter moves from the first sketch.
  const steps = counted ? (progress.sketched ?? progress.done) + progress.done : 0;
  const stage = progress?.stage;
  const description = stage === 'sketching' ? 'Choosing varied profiles…' : stage === 'repairing_names' ? 'Resolving duplicate names…' : stage === 'writing' ? 'Writing the selected biographies…' : 'Preparing your personas…';
  return (
    <section className="build-progress" aria-labelledby={titleId}>
      <div className={`build-scene build-scene-${kind}`}>
        <svg viewBox="0 0 320 180" fill="none" aria-hidden="true">
          <ellipse cx="160" cy="91" rx="132" ry="68" className="build-orbit" />
          <path d="M58 90Q160 12 262 90M58 90Q160 168 262 90" className="build-thread" />
          {[{ x: 38, y: 47, color: 'var(--gnomi-segment-3)' }, { x: 214, y: 39, color: 'var(--gnomi-segment-2)' }, { x: 122, y: 27, color: 'var(--gnomi-action)' }].map(({ x, y, color }, i) => (
            <g key={i} transform={`translate(${x} ${y})`}>
              <g className={`build-person build-person-${i}`}>
                <rect width="68" height={writing ? 106 : 88} rx="12" className="build-card" />
                <circle cx="34" cy="30" r="20" fill={color} fillOpacity=".15" />
                <circle cx="34" cy="26" r="7" fill={color} />
                <path d="M21 43c0-13 26-13 26 0" fill={color} />
                <path d="M20 62h28M26 72h16" className="build-card-line" />
                {writing && <path d="M20 87h28" className="build-writing" />}
              </g>
            </g>
          ))}
          <g className="build-spark"><path d="M94 27v12m-6-6h12M236 137v12m-6-6h12" /></g>
          <circle cx="43" cy="139" r="4" className="build-dot" />
          <circle cx="279" cy="36" r="3" className="build-dot" />
        </svg>
        <div className="build-counter" role="status" aria-atomic="true">
          {writing ? <><strong>{counted ? <>{progress.done}<span> / {progress.total}</span></> : 'Getting ready'}</strong><span>{finishing ? 'Finishing touches' : counted ? 'personas written' : 'Preparing your personas'}</span></> : <><span className="build-thinking" aria-hidden="true"><i /><i /><i /></span><span>Finding your people</span></>}
        </div>
      </div>
      <div className="build-copy">
        <p className="eyebrow">{writing ? 'Step 2 · Build personas' : 'Step 1 · Define your audience'}</p>
        <h3 id={titleId}>{writing ? 'A little personality takes time.' : 'Finding the right mix.'}</h3>
        <p>{writing ? 'Giving each person their own background, goals, and point of view. Your audience is coming to life.' : 'Considering your product and goal to suggest groups with different needs and perspectives.'}</p>
        {counted && <div role="progressbar" aria-label="Writing personas" aria-valuemin={0} aria-valuemax={progress.total * 2} aria-valuenow={steps} aria-valuetext={`${progress.done} of ${progress.total} personas written`} className="build-meter"><span style={{ width: `${Math.min(100, steps / (progress.total * 2) * 100)}%` }} /></div>}
        <p className="build-caption">{finishing ? 'Checking the profiles and saving your people…' : writing ? description : 'This can take a few minutes. We’ll show you when it’s ready.'}</p>
        {!!progress?.recent?.length && <p className="build-recent">Just written: {progress.recent.join(', ')}</p>}
        <p className="text-xs text-stone-500">{Math.floor(seconds / 60)}m {seconds % 60}s elapsed{progress?.calls !== undefined && ` · ${progress.calls} model attempts`}{!!progress?.failed_attempts && ` · ${progress.failed_attempts} failed attempts`}</p>
        {writing && <p className="text-xs text-stone-500">Completed drafts are saved. If this build is interrupted, Generate personas will resume them.</p>}
      </div>
    </section>
  );
}
