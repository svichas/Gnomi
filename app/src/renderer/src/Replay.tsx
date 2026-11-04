import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { EventOf, GnomiEvent } from '@gnomi/simulation/types.ts';
import { FEELINGS } from './activity.ts';
import type { Row } from './activity.ts';
import { Icon } from './Icon.tsx';
import { Screenshot } from './ui.tsx';
import './replay.css';

type Ending = EventOf<'persona.goal_done'> | EventOf<'persona.abandoned'>;
type Frame = ReturnType<typeof frameOf>;

/** A step with what its screenshot cannot show: how the persona felt, what it reported there, and whether its episode ended there. */
function frameOf(row: Row, events: GnomiEvent[]) {
  const here = (event: GnomiEvent) => event.poi_id === row.source?.poi_id && 'step_no' in event.payload && event.payload.step_no === row.source?.step;
  const step = events.find((event) => event.seq === row.seq);
  return {
    row,
    feeling: step?.type === 'persona.step' ? step.payload.feeling : null,
    frictions: events.filter((event): event is EventOf<'persona.friction_reported'> => event.type === 'persona.friction_reported' && here(event)),
    end: events.find((event): event is Ending => (event.type === 'persona.goal_done' || event.type === 'persona.abandoned') && here(event)),
  };
}

const kindOf = ({ end }: Frame) => (end ? (end.type === 'persona.goal_done' ? 'done' : 'gave-up') : 'friction');

/** As subtitles are timed: long enough to read the thought on screen. */
const frameMs = (row: Row) => Math.min(6_000, 1_800 + (row.quote?.length ?? 0) * 40);

/**
 * A persona's steps as a video, oldest first, so a live run's new steps never move the one on show: play, step, scrub, its thoughts as
 * captions, full screen, and what happened at each frame. Only that frame and its two neighbours are in the page, each loading its own
 * image, so a long episode costs three images however far it is played.
 */
export function Replay({ id, steps, events, name, shotLabel, focusSeq = null, onAsk }: {
  id?: string;
  steps: Row[];
  events: GnomiEvent[]; // the persona's own
  name: string;
  shotLabel: (row: Row) => string | undefined;
  focusSeq?: number | null; // opened at a step: start there
  onAsk?: (row: Row) => void; // in a chat: a question about the frame on show
}) {
  const [index, setIndex] = useState(() => Math.max(0, steps.findIndex((row) => row.seq === focusSeq)));
  const [playing, setPlaying] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [full, setFull] = useState(false);
  const region = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDialogElement>(null);
  const frames = steps.map((row) => frameOf(row, events));
  const last = frames.length - 1;
  const { row, feeling, frictions, end } = frames[index];
  const go = (to: number) => setIndex(Math.max(0, Math.min(to, last)));
  const wait = frameMs(row);
  useEffect(() => {
    if (!playing) return;
    if (index >= last) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setIndex(index + 1), wait);
    return () => window.clearTimeout(timer);
  }, [playing, index, last, wait]);
  // Full screen is a modal dialog of its own: the top layer is above the inspector and escapes any container, and Esc closes only it.
  useEffect(() => {
    const dialog = shell.current;
    if (full && !dialog?.open) dialog?.showModal();
    if (!full && dialog?.open) {
      dialog.close();
      region.current?.focus({ preventScroll: true }); // what had focus went with the full screen copy
    }
  }, [full]);
  function toggle() {
    if (!playing && index === last) setIndex(0);
    setPlaying(!playing);
  }
  const body = (
    <div className="replay-body" data-full={full || undefined}>
      <div className="replay-player">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a click on the picture is the mouse's way to full screen; the keyboard's is the Full screen button */}
        <div className="replay-stage" title={full ? 'Click to leave full screen' : 'Click for full screen'} onClick={() => setFull(!full)}>
          {/* Neighbours sit behind the frame on show, so moving to one shows an image that has already loaded. */}
          <div className="replay-frames">
            {frames.slice(Math.max(0, index - 1), index + 2).map(({ row: frame }) => <div key={frame.seq} className="replay-frame" data-current={frame === row || undefined}>
              {frame.screenshot ? <Screenshot path={frame.screenshot} alt={`${name} at ${frame.label.toLowerCase()}`} /> : <p className="replay-empty"><Icon name="image" size={22} />No screenshot for this step.</p>}
            </div>)}
          </div>
          <div className="replay-flags" aria-hidden="true">
            {frictions.length > 0 && <span data-kind="friction">Friction</span>}
            {end && <span data-kind={kindOf(frames[index])}>{end.type === 'persona.goal_done' ? 'Goal reached' : 'Gave up'}</span>}
          </div>
          {captions && row.quote && <p className="replay-caption"><span className="sr-only">{name} thought: </span>{row.quote}</p>}
        </div>
        <div className="replay-scrubber" style={{ '--progress': `${last ? (index / last) * 100 : 100}%` } as CSSProperties}>
          {frames.map((frame, i) => (frame.frictions.length > 0 || frame.end) && <span key={frame.row.seq} aria-hidden="true" className="replay-mark" data-kind={kindOf(frame)} style={{ '--at': last ? i / last : 0 } as CSSProperties} />)}
          <input type="range" min={0} max={last} value={index} aria-label="Step" aria-valuetext={`Step ${index + 1} of ${frames.length}: ${row.title}`} onChange={(event) => setIndex(Number(event.target.value))} />
        </div>
        <div className="replay-controls">
          {/* aria-disabled, because a button that disables itself under the keyboard drops focus out of the player. */}
          <button type="button" aria-label="Previous step" aria-disabled={index === 0} onClick={() => go(index - 1)}><Icon name="previous" size={18} /></button>
          <button type="button" aria-label={playing ? 'Pause' : index === last ? 'Play from the start' : 'Play'} onClick={toggle}><Icon name={playing ? 'pause' : 'play'} size={20} /></button>
          <button type="button" aria-label="Next step" aria-disabled={index === last} onClick={() => go(index + 1)}><Icon name="next" size={18} /></button>
          <span className="replay-count">{index + 1} / {frames.length}</span>
          <button type="button" className="replay-cc" aria-pressed={captions} title="The persona's thoughts on the picture" onClick={() => setCaptions(!captions)}>CC<span className="sr-only"> captions</span></button>
          <button type="button" aria-label={full ? 'Leave full screen' : 'Full screen'} onClick={() => setFull(!full)}><Icon name={full ? 'shrink' : 'expand'} size={17} /></button>
        </div>
      </div>
      <div className="replay-info">
        <p className="replay-info-step">{row.label}{row.badge && <span data-ok={row.badge.ok}>{row.badge.ok ? 'Worked' : row.badge.text}</span>}</p>
        <h4>{row.title}</h4>
        {row.page && <p className="replay-info-page"><Icon name="globe" size={13} /><span>{row.page}</span></p>}
        {feeling !== null && <p className="replay-info-feeling">Feeling {FEELINGS[feeling] ?? feeling} <span>({feeling > 0 ? '+' : ''}{feeling} of −2 to +2)</span></p>}
        {!captions && row.quote && <blockquote>&ldquo;{row.quote}&rdquo;</blockquote>}
        {frictions.map(({ seq, payload: { severity, what, expected } }) => <div key={seq} className="replay-info-friction">
          <p><strong>Friction, severity {severity} of 4:</strong> {what}</p>
          <p>Expected: {expected}</p>
        </div>)}
        {end && <p className="replay-info-end" data-done={end.type === 'persona.goal_done' || undefined}>
          <strong>{end.type === 'persona.goal_done' ? 'Goal reached:' : 'Gave up:'}</strong> {end.type === 'persona.goal_done' ? end.payload.summary : end.payload.reason}
        </p>}
        {row.screenshot && shotLabel(row) && <p className="replay-info-note">{shotLabel(row)}</p>}
        {onAsk && <button type="button" className="replay-ask" onClick={() => { setFull(false); onAsk(row); }}><Icon name="message" size={15} />Ask about this step</button>}
      </div>
    </div>
  );
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the player takes focus so its keys work without tabbing to a button
    <div ref={region} role="region" id={id} aria-label="Replay" aria-keyshortcuts="Space ArrowLeft ArrowRight" tabIndex={0} className="replay" onKeyDown={(event) => {
      if (event.target instanceof HTMLInputElement) return; // the scrubber steps by itself
      if (event.key === 'ArrowLeft') go(index - 1);
      if (event.key === 'ArrowRight') go(index + 1);
      if (event.key === ' ' && event.target === event.currentTarget) {
        event.preventDefault();
        toggle();
      }
    }}>
      <div className="inspector-section-heading"><h3 className="text-sm font-semibold text-stone-900">Replay</h3><span>Space plays, arrow keys step</span></div>
      {/* Apart from the visible count, whose total grows with every step of a live run: only moving should be announced. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{`Step ${index + 1}: ${row.title}`}</p>
      {!full && body}
      {/* Its cancel stops here: React would hand it on to an inspector around it, which would close too. */}
      <dialog ref={shell} aria-label={`${name}, full screen replay`} className="replay-full" onCancel={(event) => { event.preventDefault(); event.stopPropagation(); setFull(false); }}>
        {full && body}
      </dialog>
    </div>
  );
}
