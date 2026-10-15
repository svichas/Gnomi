import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { GnomiEvent, Persona, Segment } from '@gnomi/engine/types.ts';
import { countryName } from '@gnomi/engine/audience/locations.ts';
import { FEELINGS, merge, personaProgress, personaStates, stateWord, toRows, TONE_CLASSES } from './activity.ts';
import { call, errorText, onEvent } from './engine.ts';
import { Screenshot } from './ui.tsx';

function Trait({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="text-sm text-stone-900">{children}</dd>
    </div>
  );
}

/** One persona of a run: who she is, how she feels now, and every step she took with what she saw (idea.md §6.3). */
export function Inspector(props: { runId: string; persona: Persona; segment: Segment | undefined; focusSeq: number | null; ended: boolean; onClose(): void }) {
  const { runId, persona, segment, focusSeq, ended, onClose } = props;
  const [events, setEvents] = useState<GnomiEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef<HTMLLIElement>(null);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = toRows(events); // newest first, like the feed, so a live persona's latest step is at the top
  const logged = personaStates(events, [persona]).get(persona.id) ?? 'waiting'; // her own events do not include the run's end
  const state = ended && (logged === 'active' || logged === 'waiting') ? 'unfinished' : logged;
  const feeling = personaProgress(events).get(persona.id)?.feeling ?? null;
  // Opened from an event: bring that step into view once the timeline has it. Braces matter: scrollIntoView now returns a Promise, and an
  // effect that returns one is treated by React as its cleanup.
  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'center' });
  }, [rows.length > 0, focusSeq]);

  return (
    <aside aria-label="Persona inspector" className="fixed inset-y-0 right-0 z-30 flex w-full max-w-md flex-col border-l border-stone-200 bg-white shadow-2xl">
      <div className="flex items-start justify-between gap-3 border-b border-stone-200 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-stone-900">
            {persona.name} {persona.pronouns && <span className="font-normal text-stone-500">({persona.pronouns})</span>}
          </h2>
          <p className="text-sm text-stone-600">
            {persona.job_title}
            {segment && `, ${segment.name}`}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg border border-stone-300 px-3 py-1 text-sm text-stone-800 hover:bg-stone-100">
          Close
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <section aria-label="Right now" className="space-y-1 rounded-lg bg-stone-50 px-4 py-3 text-sm">
          <p>
            <span className="font-medium text-stone-900">{stateWord(state, ended)}.</span>{' '}
            {feeling !== null ? `Feeling ${FEELINGS[feeling] ?? feeling} (${feeling > 0 ? '+' : ''}${feeling}).` : 'No steps yet.'}
          </p>
          <p className="text-stone-600">
            {persona.seniority} level at a {persona.company_size}-person {persona.industry} company, on a {persona.device} browser. Tech skill {persona.tech_skill} of 5, patience{' '}
            {persona.patience} of 5.
          </p>
        </section>

        <details aria-label="Profile" className="rounded-lg border border-stone-200">
          <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-stone-900">Full profile</summary>
          <div className="space-y-3 border-t border-stone-200 px-4 py-3">
            <dl className="grid grid-cols-2 gap-3">
              <Trait label="Seniority">{persona.seniority}</Trait>
              <Trait label="Company">
                {persona.company_size} employees, {persona.industry}
              </Trait>
              <Trait label="Device">{persona.device}</Trait>
              <Trait label="First language">{persona.language}</Trait>
              {persona.country && <Trait label="Country">{countryName(persona.country)}</Trait>}
              {persona.city && <Trait label="City">{persona.city}</Trait>}
              {persona.timezone && <Trait label="Timezone">{persona.timezone}</Trait>}
              {persona.languages && <Trait label="Languages">{persona.languages.join(', ')}</Trait>}
              {persona.employer && <Trait label="Employer">{persona.employer}</Trait>}
              <Trait label="Tech skill">{persona.tech_skill} of 5</Trait>
              <Trait label="Patience">{persona.patience} of 5</Trait>
              <Trait label="Motivation">{persona.motivation} of 5</Trait>
              <Trait label="Knows the category">{persona.familiarity_with_category}</Trait>
              <Trait label="Accessibility">{persona.accessibility_needs.replace('_', ' ')}</Trait>
              <Trait label="Seed">{persona.seed}</Trait>
            </dl>
            <dl className="space-y-3">
              <Trait label="Background">{persona.background}</Trait>
              <Trait label="Where and when">{persona.context_of_use}</Trait>
              <Trait label="Reads the goal as">{persona.goal_interpretation}</Trait>
              <Trait label="Voice">{persona.voice}</Trait>
            </dl>
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
                ref={row.seq === focusSeq ? focused : undefined}
                className={`rounded-lg border px-3 py-2 text-sm ${TONE_CLASSES[row.tone]} ${row.seq === focusSeq ? 'ring-2 ring-indigo-500' : ''}`}
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
                    <Screenshot path={row.screenshot} alt={`${persona.name} at ${row.label.toLowerCase()}`} />
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </aside>
  );
}
