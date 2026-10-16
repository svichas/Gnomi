import { useEffect, useRef, useState } from 'react';
import type { EventOf, GnomiEvent, Persona, PersonaSchema, Segment } from '@gnomi/engine/types.ts';
import { foldOpinions } from '@gnomi/engine/opinion/index.ts';
import type { SocialMemory } from '@gnomi/engine/graph/feed.ts';
import { FEELINGS, merge, personaProgress, personaStates, stateWord, toRows, TONE_CLASSES } from './activity.ts';
import { call, errorText, onEvent } from './engine.ts';
import { Button, Screenshot } from './ui.tsx';
import { PersonaHeader, personaLabel, ProfileFields } from './ProfileFields.tsx';

/** One persona of a run: who she is, how she feels now, and every step she took with what she saw (idea.md §6.3). */
export function Inspector(props: {
  runId: string; persona: Persona; schema?: PersonaSchema; poi?: { id: string; name: string }; segment: Segment | undefined; focusSeq: number | null; ended: boolean;
  social: SocialMemory | null; // null: the run had no social rounds
  names: Map<string, string>;
  onClose(): void;
}) {
  const { runId, persona, schema, poi, segment, focusSeq, ended, social, names, onClose } = props;
  const name = personaLabel(persona, schema);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  function close() {
    // Close while still mounted so the native dialog restores focus to its opener.
    dialog.current?.close();
    onClose();
  }
  const [events, setEvents] = useState<GnomiEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const evidence = useRef(new Map<number, HTMLLIElement>());
  const [evidenceSeq, setEvidenceSeq] = useState<number | null>(null);

  useEffect(() => {
    let current = true;
    const off = onEvent((event) => {
      if (event.run_id === runId && event.persona_id === persona.id) setEvents((have) => merge(have, [event]));
    });
    call('get_events', { run_id: runId, after_seq: null, persona_id: persona.id }).then(
      (all) => current && setEvents((have) => merge(have, all)),
      (err) => current && setError(errorText(err)),
    );
    return () => {
      current = false;
      off();
    };
  }, [runId, persona.id]);

  const rows = toRows(events); // newest first, like the feed, so a live persona's latest step is at the top
  const logged = personaStates(events, [persona]).get(persona.id) ?? 'waiting'; // her own events do not include the run's end
  const state = ended && (logged === 'active' || logged === 'waiting') ? 'unfinished' : logged;
  const feeling = personaProgress(events).get(persona.id)?.feeling ?? null;
  const opinions = foldOpinions(events).filter((entry) => entry.run_id === runId && entry.persona_id === persona.id);
  const surveys = events.filter((event): event is EventOf<'persona.survey'> => event.run_id === runId && event.type === 'persona.survey');
  const highlighted = evidenceSeq ?? focusSeq;
  // Opened from an event: bring that step into view once the timeline has it. Braces matter: scrollIntoView now returns a Promise, and an
  // effect that returns one is treated by React as its cleanup.
  useEffect(() => {
    setEvidenceSeq(null);
    if (focusSeq !== null) evidence.current.get(focusSeq)?.scrollIntoView({ block: 'center' });
  }, [rows.length > 0, focusSeq]);

  return (
    <dialog ref={dialog} aria-label="Persona details" className="inspector-dialog" onCancel={(event) => { event.preventDefault(); close(); }}>
    <aside aria-label="Persona inspector" className="flex h-full w-full flex-col bg-white">
      <div className="flex items-start justify-between gap-3 border-b border-stone-200 px-5 py-4">
        <PersonaHeader persona={persona} schema={schema} detail={segment?.name} heading="h2" />
        <Button onClick={close} small>
          Close
        </Button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <section aria-label="Right now" className="space-y-1 rounded-lg bg-stone-50 px-4 py-3 text-sm">
          <p>
            <span className="font-medium text-stone-900">{stateWord(state, ended)}.</span>{' '}
            {feeling !== null ? `Feeling ${FEELINGS[feeling] ?? feeling} (${feeling > 0 ? '+' : ''}${feeling}).` : 'No steps yet.'}
          </p>
        </section>

        <section aria-label="Current opinions" className="space-y-3">
          <h3 className="text-sm font-semibold text-stone-900">Current opinions</h3>
          {opinions.length === 0 && <p className="text-sm text-stone-500">No opinion recorded yet. Older runs may only have step feelings.</p>}
          {opinions.map((entry) => <div key={entry.poi_id} className="space-y-3 rounded-lg border border-stone-200 px-4 py-3 text-sm">
            <h4 className="font-medium text-stone-900">{poi?.id === entry.poi_id ? poi.name : entry.poi_id}</h4>
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
                if (!step || step.type !== 'persona.step') return null;
                return <button type="button" key={seq} className="text-indigo-700 underline" onClick={() => { setEvidenceSeq(seq); evidence.current.get(seq)?.scrollIntoView({ block: 'center' }); }}>View source step {step.payload.step_no}</button>;
              })}
            </div>
          </div>)}
        </section>

        <section aria-label="Survey" className="space-y-3">
          <h3 className="text-sm font-semibold text-stone-900">End-of-episode survey</h3>
          {surveys.length === 0 && <p className="text-sm text-stone-500">No survey yet. A persona answers one when its episode ends; older runs have none.</p>}
          {surveys.map(({ seq, payload: survey }) => <div key={seq} className="space-y-3 rounded-lg border border-stone-200 px-4 py-3 text-sm">
            <h4 className="font-medium text-stone-900">{poi?.id === survey.poi_id ? poi.name : survey.poi_id}</h4>
            <dl className="grid grid-cols-3 gap-3">
              <div><dt className="text-xs text-stone-500">Would keep using it</dt><dd>{survey.would_continue ? 'Yes' : 'No'}</dd></div>
              <div><dt className="text-xs text-stone-500">Sentiment</dt><dd>{survey.sentiment > 0 ? '+' : ''}{survey.sentiment} of −2 to +2</dd></div>
              <div><dt className="text-xs text-stone-500">Self-reported confidence</dt><dd>{Math.round(survey.confidence * 100)}%</dd></div>
            </dl>
            <p className="italic text-stone-600">&ldquo;{survey.reason}&rdquo;</p>
            {([['Frictions', survey.frictions], ['Likes', survey.likes]] as const).map(([label, items]) => <div key={label}>
              <h5 className="text-xs font-medium text-stone-500">{label}</h5>
              {items.length ? <ul className="list-disc space-y-1 pl-4">{items.map((item, i) => <li key={i} className="break-words">{item}</li>)}</ul> : <p className="text-stone-500">None reported</p>}
            </div>)}
          </div>)}
        </section>

        <section aria-label="Social memory" className="space-y-3">
          <h3 className="text-sm font-semibold text-stone-900">Social memory</h3>
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
        </section>

        <details aria-label="Profile" className="rounded-lg border border-stone-200">
          <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-stone-900">Full profile</summary>
          <div className="space-y-3 border-t border-stone-200 px-4 py-3">
            <ProfileFields persona={persona} schema={schema} purpose="all" />
          </div>
        </details>

        <section aria-label="Timeline">
          <h3 className="mb-2 text-sm font-semibold text-stone-900">Step by step</h3>
          {error && <p className="text-sm text-red-800">{error}</p>}
          {rows.length === 0 && !error && <p className="text-sm text-stone-500">Nothing has happened for this persona yet.</p>}
          <ol className="space-y-2">
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
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </aside>
    </dialog>
  );
}
