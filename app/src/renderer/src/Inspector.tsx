import { useEffect, useRef, useState } from 'react';
import type { EventOf, GnomiEvent, Persona, PersonaSchema, Poi, Segment } from '@gnomi/simulation/types.ts';
import { foldOpinions } from '@gnomi/simulation/opinion/index.ts';
import { assetPlaces } from '@gnomi/simulation/poi/pois.ts';
import type { SocialMemory } from '@gnomi/engine/graph/feed.ts';
import { FEELINGS, personaProgress, shotLabels, stateWord, toRows, TONE_CLASSES } from './activity.ts';
import type { PersonaState, Row } from './activity.ts';
import { Button, Screenshot } from './ui.tsx';
import { PersonaHeader, personaLabel, ProfileFields } from './ProfileFields.tsx';
import { Icon } from './Icon.tsx';
import './results.css';

/**
 * A persona's steps as a flipbook, oldest first, so a live run's new steps never move the one on show. Only that step and its two
 * neighbours are in the page, and each loads its own image, so a long episode costs three images however far it is flipped.
 */
function Replay({ steps, name }: { steps: Row[]; name: string }) {
  const [index, setIndex] = useState(0);
  const go = (to: number) => setIndex(Math.max(0, Math.min(to, steps.length - 1)));
  const step = steps[index];
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the flipbook takes focus so its arrow keys work without tabbing to a button
    <div role="region" id="inspector-replay" aria-label="Replay" aria-keyshortcuts="ArrowLeft ArrowRight" tabIndex={0} className="inspector-replay" onKeyDown={(event) => {
      if (event.key === 'ArrowLeft') go(index - 1);
      if (event.key === 'ArrowRight') go(index + 1);
    }}>
      <div className="inspector-section-heading"><h3 className="text-sm font-semibold text-stone-900">Replay</h3><span>Left and right arrow keys</span></div>
      {/* Apart from the visible count, whose total grows with every step of a live run: only flipping should be announced. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{`Step ${index + 1}: ${step.title}`}</p>
      <div className="inspector-replay-frame">
        <div className="inspector-replay-stage">
          {/* Neighbours sit behind the step on show, so moving to one shows an image that has already loaded. */}
          {steps.slice(Math.max(0, index - 1), index + 2).map((row) => <div key={row.seq} data-current={row === step || undefined}>
            {row.screenshot ? <Screenshot path={row.screenshot} alt={`${name} at ${row.label.toLowerCase()}`} /> : <p className="text-sm text-stone-500">No screenshot for this step.</p>}
          </div>)}
        </div>
        <div className="inspector-replay-caption">
          <p className="font-medium text-stone-900">Step {index + 1} of {steps.length}</p>
          <p>{step.title}</p>
          {step.page && <p className="break-all text-xs text-stone-500">{step.page}</p>}
        </div>
      </div>
      <div className="inspector-replay-controls">
        {/* aria-disabled, because a button that disables itself under the keyboard drops focus out of the flipbook. */}
        <Button small aria-disabled={index === 0} onClick={() => go(index - 1)}><Icon name="back" size={15} />Previous</Button>
        <Button small aria-disabled={index === steps.length - 1} onClick={() => go(index + 1)}>Next<Icon name="arrow" size={15} /></Button>
      </div>
    </div>
  );
}

/** One persona of a run: who she is, how she feels now, and every step she took with what she saw (idea.md §6.3). */
export function Inspector(props: {
  runId: string; persona: Persona; schema?: PersonaSchema; pois?: Poi[]; segment: Segment | undefined; focusSeq: number | null; ended: boolean;
  state: PersonaState; // the run's own status for her: her events alone miss the run's end and a comparison's rules
  events: GnomiEvent[]; // hers only, in order
  social: SocialMemory | null; // null: the run had no social rounds
  names: Map<string, string>;
  onClose(): void;
}) {
  const { runId, persona, schema, pois, segment, focusSeq, ended, state, events, social, names, onClose } = props;
  const poiName = (id: string) => pois?.find((poi) => poi.id === id)?.name ?? id;
  const name = personaLabel(persona, schema);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  function close() {
    // Close while still mounted so the native dialog restores focus to its opener.
    dialog.current?.close();
    onClose();
  }
  const evidence = useRef(new Map<number, HTMLLIElement>());
  const [evidenceSeq, setEvidenceSeq] = useState<number | null>(null);
  function jumpTo(id: string) {
    const section = dialog.current?.querySelector<HTMLElement>(`#${id}`);
    if (section instanceof HTMLDetailsElement) section.open = true;
    section?.scrollIntoView({ block: 'start' });
    section?.focus({ preventScroll: true });
  }

  const rows = toRows(events, assetPlaces(pois ?? [])); // newest first, like the feed, so a live persona's latest step is at the top
  const shotLabel = shotLabels(events);
  const steps = rows.filter((row) => row.source?.type === 'persona.step').toReversed();
  const replayable = steps.some((row) => row.screenshot); // a text's steps have none, so there is nothing to flip through
  const feeling = personaProgress(events).get(persona.id)?.feeling ?? null;
  const opinions = foldOpinions(events).filter((entry) => entry.run_id === runId && entry.persona_id === persona.id);
  const surveys = events.filter((event): event is EventOf<'persona.survey'> => event.run_id === runId && event.type === 'persona.survey');
  const highlighted = evidenceSeq ?? focusSeq;
  // Opened from an event: bring that step into view once the timeline has it. Braces matter: scrollIntoView now returns a Promise, and an
  // effect that returns one is treated by React as its cleanup.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again once the timeline has rows, so the focused step's element exists
  useEffect(() => {
    setEvidenceSeq(null);
    if (focusSeq !== null) evidence.current.get(focusSeq)?.scrollIntoView({ block: 'center' });
  }, [rows.length > 0, focusSeq]);

  return (
    <dialog ref={dialog} aria-label="Persona details" className="inspector-dialog" onCancel={(event) => { event.preventDefault(); close(); }}>
    <aside aria-label="Persona inspector" className="flex h-full w-full flex-col bg-white">
      <div className="inspector-header flex items-start justify-between gap-3 border-b border-stone-200 px-5 py-4">
        <PersonaHeader persona={persona} schema={schema} detail={segment?.name} heading="h2" />
        <Button onClick={close} small>
          <Icon name="close" size={16} />Close
        </Button>
      </div>
      <nav className="inspector-jump-links" aria-label="Persona sections">
        {replayable && <button type="button" onClick={() => jumpTo('inspector-replay')}><Icon name="play" size={15} />Replay</button>}
        <button type="button" onClick={() => jumpTo('inspector-timeline')}><Icon name="activity" size={15} />Journey<span>{rows.length}</span></button>
        <button type="button" onClick={() => jumpTo('inspector-opinions')}><Icon name="message" size={15} />Opinions</button>
        <button type="button" onClick={() => jumpTo('inspector-profile')}><Icon name="people" size={15} />Profile</button>
      </nav>

      <div className="inspector-body flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <section aria-label="Right now" className="inspector-state space-y-1 rounded-lg bg-stone-50 px-4 py-3 text-sm">
          <p className="inspector-synthetic-label">Simulated persona · Generated opinions</p>
          <p>
            <span className="font-medium text-stone-900">{stateWord(state, ended)}.</span>{' '}
            {feeling !== null ? `Feeling ${FEELINGS[feeling] ?? feeling} (${feeling > 0 ? '+' : ''}${feeling}).` : 'No steps yet.'}
          </p>
        </section>

        {replayable && <Replay steps={steps} name={name} />}

        <section aria-label="Timeline" id="inspector-timeline" tabIndex={-1}>
          <div className="inspector-section-heading"><h3 className="text-sm font-semibold text-stone-900">Step by step</h3><span>Newest first</span></div>
          {rows.length === 0 && <div className="inspector-empty"><Icon name="activity" size={24} /><p>{ended ? 'No actions were recorded for this persona.' : 'This persona is waiting to explore.'}</p><span>{ended ? 'Explore their profile to review the audience assumptions.' : 'Recorded actions and screenshots will appear here.'}</span></div>}
          <ol className="inspector-timeline space-y-2">
            {rows.map((row) => (
              <li
                key={row.seq}
                ref={(node) => { if (node) evidence.current.set(row.seq, node); else evidence.current.delete(row.seq); }}
                className={`rounded-lg border px-3 py-2 text-sm ${TONE_CLASSES[row.tone]} ${row.seq === highlighted ? 'ring-2 ring-indigo-500' : ''}`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 break-words">
                    <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-stone-500">{row.label}</span>
                    <span className="font-medium text-stone-900">{row.title}</span>
                  </p>
                  {row.badge && <span className={`shrink-0 text-xs font-medium ${row.badge.ok ? 'text-green-700' : 'text-red-700'}`}>{row.badge.text}</span>}
                </div>
                {row.detail && <p className="mt-1 text-stone-700">{row.detail}</p>}
                {row.quote && <p className="mt-1 italic text-stone-600">&ldquo;{row.quote}&rdquo;</p>}
                {row.screenshot && (
                  <div className="mt-2">
                    <Screenshot path={row.screenshot} alt={`${name} at ${row.label.toLowerCase()}`} />
                    {shotLabel(row) && <p className="mt-1 text-xs text-stone-500">{shotLabel(row)}</p>}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section aria-label="Current opinions" id="inspector-opinions" tabIndex={-1} className="space-y-3">
          <h3 className="text-sm font-semibold text-stone-900">Current opinions</h3>
          {opinions.length === 0 && <p className="text-sm text-stone-500">No opinion recorded yet. Older runs may only have step feelings.</p>}
          {opinions.map((entry) => <div key={entry.poi_id} className="space-y-3 rounded-lg border border-stone-200 px-4 py-3 text-sm">
            <h4 className="font-medium text-stone-900">{poiName(entry.poi_id)}</h4>
            <dl className="grid grid-cols-2 gap-3">
              <div><dt className="text-xs text-stone-500">Sentiment</dt><dd>{entry.opinion.sentiment > 0 ? '+' : ''}{entry.opinion.sentiment} of −2 to +2</dd></div>
              <div><dt className="text-xs text-stone-500">Self-reported confidence</dt><dd>{Math.round(entry.opinion.confidence * 100)}%</dd></div>
            </dl>
            {([['Likes', entry.opinion.likes], ['Frictions', entry.opinion.frictions]] as const).map(([label, items]) => <div key={label}>
              <h5 className="text-xs font-medium text-stone-500">{label}</h5>
              {items.length ? <ul className="list-disc space-y-1 pl-4">{items.map((item, i) => <li key={i} className="break-words">{item}</li>)}</ul> : <p className="text-stone-500">None reported</p>}
            </div>)}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
              <span>Round {entry.round}</span>
              {entry.cause.step_ids.map((seq) => {
                const step = events.find((event) => event.seq === seq && event.type === 'persona.step');
                if (step?.type !== 'persona.step') return null;
                return <button type="button" key={seq} className="text-indigo-700 underline" onClick={() => { setEvidenceSeq(seq); evidence.current.get(seq)?.scrollIntoView({ block: 'center' }); }}>View source step {step.payload.step_no}</button>;
              })}
            </div>
          </div>)}
        </section>

        <details aria-label="Survey" className="inspector-fold" open={surveys.length > 0}>
          <summary><h3>End-of-episode survey</h3><span>{surveys.length || 'Not recorded'}</span></summary>
          <div className="space-y-3">
          {surveys.length === 0 && <p className="text-sm text-stone-500">No survey yet. A persona answers one when its episode ends; older runs have none.</p>}
          {surveys.map(({ seq, payload: survey }) => <div key={seq} className="space-y-3 rounded-lg border border-stone-200 px-4 py-3 text-sm">
            <h4 className="font-medium text-stone-900">{poiName(survey.poi_id)}</h4>
            <dl className="grid grid-cols-3 gap-3">
              <div><dt className="text-xs text-stone-500">Would keep using it</dt><dd>{survey.would_continue ? 'Yes' : 'No'}</dd></div>
              <div><dt className="text-xs text-stone-500">Sentiment</dt><dd>{survey.sentiment > 0 ? '+' : ''}{survey.sentiment} of −2 to +2</dd></div>
              <div><dt className="text-xs text-stone-500">Self-reported confidence</dt><dd>{Math.round(survey.confidence * 100)}%</dd></div>
            </dl>
            <p className="italic text-stone-600">&ldquo;{survey.reason}&rdquo;</p>
            {(survey.items
              ? ([['Frictions', 'friction'], ['Objections', 'objection'], ['Likes', 'like']] as const).map(([label, kind]) => [label, survey.items!.filter((i) => i.kind === kind).map((i) => `${i.where}: ${i.what}${i.severity ? ` (severity ${i.severity} of 4)` : ''}`)] as const)
              : ([['Frictions', survey.frictions], ['Likes', survey.likes]] as const)
            ).map(([label, items]) => <div key={label}>
              <h5 className="text-xs font-medium text-stone-500">{label}</h5>
              {items.length ? <ul className="list-disc space-y-1 pl-4">{items.map((item, i) => <li key={i} className="break-words">{item}</li>)}</ul> : <p className="text-stone-500">None reported</p>}
            </div>)}
          </div>)}
          </div>
        </details>

        <details aria-label="Social memory" className="inspector-fold">
          <summary><h3>Social memory</h3><span>{social ? `${social.seen.length} posts seen` : 'No social rounds'}</span></summary>
          <div className="space-y-3">
          {!social ? (
            <p className="text-sm text-stone-500">This run had no social rounds, so there is nothing to remember from the feed.</p>
          ) : (
            <div className="space-y-3 rounded-lg border border-stone-200 px-4 py-3 text-sm">
              <div>
                <h4 className="text-xs font-medium text-stone-500">Follows ({social.follows.length})</h4>
                <p className="break-words">{social.follows.length ? social.follows.map((id) => names.get(id) ?? id).join(', ') : 'Nobody'}</p>
              </div>
              {([['Posts seen', social.seen], ['Own posts', social.own]] as const).map(([label, posts]) => <div key={label}>
                <h4 className="text-xs font-medium text-stone-500">{label} ({posts.length})</h4>
                {posts.length ? (
                  <ul className="mt-1 max-h-48 space-y-2 overflow-y-auto">
                    {posts.map(({ seq, persona_id, round, payload }) => (
                      <li key={seq} className="break-words">
                        <span className="text-xs text-stone-500">{names.get(persona_id ?? '') ?? persona_id}, round {round}{payload.parent_id ? ', a reply' : ''}{payload.injected ? ', injected by the test harness' : ''}: </span>
                        {payload.text}
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-stone-500">None</p>}
              </div>)}
            </div>
          )}
          </div>
        </details>

        <details aria-label="Profile" id="inspector-profile" tabIndex={-1} className="rounded-lg border border-stone-200">
          <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-stone-900">Full profile</summary>
          <div className="space-y-3 border-t border-stone-200 px-4 py-3">
            <ProfileFields persona={persona} schema={schema} purpose="all" />
          </div>
        </details>


      </div>
    </aside>
    </dialog>
  );
}
