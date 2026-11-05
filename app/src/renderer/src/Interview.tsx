import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { EventOf, GnomiEvent, Persona, PersonaSchema, Poi, Report as ReportData } from '@gnomi/simulation/types.ts';
import { INTERVIEW_LABEL, QUESTION_MAX, QUESTION_WARNING } from '@gnomi/simulation/agent/interview.ts';
import { assetPlaces } from '@gnomi/simulation/poi/pois.ts';
import { shotLabels, toRows } from './activity.ts';
import type { Row } from './activity.ts';
import { call, errorText } from './engine.ts';
import { Icon, PersonaAvatar } from './Icon.tsx';
import { PersonaProfile } from './PersonaProfile.tsx';
import { Replay } from './Replay.tsx';
import { count, OUTCOMES, SectionHeading } from './reportParts.tsx';
import { useCallCost } from './ReportStudy.tsx';
import { Button, Note, Screenshot } from './ui.tsx';
import './interview.css';

type Answer = EventOf<'persona.interviewed'>;
type Who = { id: string; name: string; pronouns?: Persona['pronouns'] };

/** The question being answered: one per run, whoever it is for, as the host answers one at a time. `answered` is how many answers the persona had when it was asked. */
interface Asking { persona_id: string; name: string; question: string; answered: number; error?: string }

/** A run's questions after the run, shared by every chat of the run so each knows when another is waiting. */
export function useInterview(runId: string) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);
  async function ask(next: Asking) {
    setAsking(next);
    setBusy(true);
    try {
      await call('ask_persona', { run_id: runId, persona_id: next.persona_id, question: next.question }); // the answer arrives with the log, as persona.interviewed
    } catch (err) {
      setAsking({ ...next, error: errorText(err) });
    } finally {
      setBusy(false);
    }
  }
  return { asking, busy, ask };
}
export type Interview = ReturnType<typeof useInterview>;

/** The question still on its way to this persona: it stays on show until its answer is in the log, so the chat never blinks. */
const waitingOn = ({ asking }: Interview, id: string, answers: number) => (asking?.persona_id === id && asking.answered === answers ? asking : null);

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayOf = (ts: number) => new Date(ts).toDateString();
function dayLabel(ts: number) {
  const date = new Date();
  if (dayOf(ts) === date.toDateString()) return 'Today';
  date.setDate(date.getDate() - 1);
  return dayOf(ts) === date.toDateString() ? 'Yesterday' : new Date(ts).toLocaleDateString([], { dateStyle: 'medium' });
}

const STARTERS = ['What was hardest for you?', 'What did you expect to see?', 'What would you change first?'];

function Message({ from, text, note, at, status, onProfile }: { from: 'team' | Who; text: string; note?: string; at?: number; status?: 'check' | 'clock' | 'alert'; onProfile?(): void }) {
  const team = from === 'team';
  return (
    <div className="chat-row" data-from={team ? 'team' : 'persona'}>
      {/* Out of the tab order, as in a messenger: the header's name is the keyboard's way to the profile. */}
      {!team && (onProfile ? <button type="button" tabIndex={-1} className="chat-face" aria-label={`${from.name}'s profile`} onClick={onProfile}><PersonaAvatar name={from.name} id={from.id} pronouns={from.pronouns} /></button> : <PersonaAvatar name={from.name} id={from.id} pronouns={from.pronouns} />)}
      <div className="chat-bubble">
        <p><span className="sr-only">{team ? 'You asked: ' : `${from.name} answered: `}</span>{text}</p>
        <p className="chat-meta" title={team ? undefined : INTERVIEW_LABEL}>{note && <span>{note}</span>}{at !== undefined && <time>{clock(at)}</time>}{status && <Icon name={status} size={12} />}</p>
      </div>
    </div>
  );
}

function Composer({ runId, name, value, onChange, onSend, busy, waitingFor, field }: { runId: string; name: string; value: string; onChange(value: string): void; onSend(question: string): void; busy: boolean; waitingFor: string | null; field: RefObject<HTMLTextAreaElement | null> }) {
  const { cost, ready } = useCallCost('estimate_interview', runId);
  const hint = useId();
  const question = value.trim();
  const send = () => { if (question && ready && !busy) onSend(question); };
  return (
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <div className="chat-composer-row">
        <textarea
          ref={field}
          rows={1}
          aria-label={`Ask ${name} about this run`}
          aria-describedby={hint}
          placeholder="Ask a question…"
          maxLength={QUESTION_MAX}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          // Enter sends, as in any chat; Shift+Enter is a new line, and Enter that ends an input method's composition is not a send.
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }}
        />
        <button type="submit" className="chat-send" aria-label="Send" disabled={!question || !ready || busy}><Icon name="send" size={18} /></button>
      </div>
      <p id={hint} className="chat-hint">
        {waitingFor && `Waiting for ${waitingFor}'s answer first. `}{cost} {QUESTION_WARNING}
        {value.length > QUESTION_MAX - 100 && ` ${value.length} of ${QUESTION_MAX} characters.`}
      </p>
    </form>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * One persona's questions and answers as a chat, oldest first, then the question on its way and a box for the next one. In the report it
 * opens with the persona's session as a video message, which plays in place and can hand any of its steps to the box as a question.
 */
export function PersonaChat({ runId, persona, answers, interview, askable = true, autoFocus = false, starters = STARTERS, replay, watching = false, onWatch, onProfile }: {
  runId: string; persona: Who; answers: Answer[]; interview: Interview; askable?: boolean; autoFocus?: boolean;
  starters?: string[];
  replay?: { steps: Row[]; events: GnomiEvent[]; shotLabel(row: Row): string | undefined; summary: string };
  watching?: boolean; // the video message is playing, here or because the profile said so
  onWatch?(watching: boolean): void;
  onProfile?(): void;
}) {
  const [question, setQuestion] = useState('');
  const thread = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const waiting = waitingOn(interview, persona.id, answers.length);
  const other = interview.busy && interview.asking?.persona_id !== persona.id ? interview.asking?.name ?? null : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a message comes or goes, to show the newest
  useEffect(() => { thread.current?.scrollTo({ top: thread.current.scrollHeight }); }, [answers.length, waiting]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the chat opens from a click on its persona
  useEffect(() => { if (autoFocus) field.current?.focus({ preventScroll: true }); }, []); // the click was in view: the page stays put
  useEffect(() => { if (watching) thread.current?.scrollTo({ top: 0 }); }, [watching]); // the video message is first in the thread
  function askAbout(row: Row) {
    setQuestion(`About ${row.label.toLowerCase()}, when you ${lowerFirst(row.title)}: what were you trying to do?`.slice(0, QUESTION_MAX));
    field.current?.focus({ preventScroll: true });
  }
  const poster = replay?.steps.find((row) => row.screenshot)?.screenshot;
  return (
    <div className="chat">
      <div ref={thread} role="log" aria-label={`Conversation with ${persona.name}`} className="chat-thread">
        <p className="chat-notice"><Icon name="spark" size={14} />{INTERVIEW_LABEL} {persona.name} sees the earlier questions and answers here, which were generated the same way.</p>
        {replay && (watching ? <div className="chat-video-open">
          <Replay steps={replay.steps} events={replay.events} name={persona.name} shotLabel={replay.shotLabel} onAsk={askable ? askAbout : undefined} />
          <button type="button" className="chat-video-hide" onClick={() => onWatch?.(false)}>Hide the replay</button>
        </div> : <div className="chat-row" data-from="persona">
          <PersonaAvatar name={persona.name} id={persona.id} pronouns={persona.pronouns} />
          <div className="chat-video">
            <div className="chat-video-poster" aria-hidden="true">{poster && <Screenshot path={poster} alt="" />}</div>
            <button type="button" onClick={() => onWatch?.(true)}>
              <span className="chat-video-play"><Icon name="play" size={20} /></span>
              <span className="chat-video-copy"><strong>Session replay</strong><small>{replay.summary}</small></span>
            </button>
          </div>
        </div>)}
        {answers.map((answer, i) => <Fragment key={answer.seq}>
          {dayOf(answer.ts) !== dayOf(answers[i - 1]?.ts ?? 0) && <p className="chat-day">{dayLabel(answer.ts)}</p>}
          <Message from="team" text={answer.payload.question} at={answer.ts} status="check" />
          <Message from={persona} text={answer.payload.answer} note="Generated after the run" at={answer.ts} onProfile={onProfile} />
        </Fragment>)}
        {waiting && <Message from="team" text={waiting.question} note={waiting.error ? 'Not answered' : 'Waiting'} status={waiting.error ? 'alert' : 'clock'} />}
        {waiting && !waiting.error && <div className="chat-row" data-from="persona">
          <PersonaAvatar name={persona.name} id={persona.id} pronouns={persona.pronouns} />
          <div className="chat-bubble chat-typing"><span className="sr-only">{persona.name} is answering…</span><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></div>
        </div>}
        {waiting?.error && <div className="chat-failed">
          <Note tone="error">{waiting.error}</Note>
          {askable && <Button small onClick={() => void interview.ask({ ...waiting, error: undefined })} disabled={interview.busy}>Try again</Button>}
        </div>}
        {askable && !answers.length && !waiting && <div className="chat-starters" aria-label="Question ideas" role="group">
          {starters.map((starter) => <button key={starter} type="button" onClick={() => { setQuestion(starter); field.current?.focus({ preventScroll: true }); }}>{starter}</button>)}
        </div>}
      </div>
      {askable && <Composer
        runId={runId}
        name={persona.name}
        value={question}
        onChange={setQuestion}
        onSend={(asked) => { setQuestion(''); void interview.ask({ persona_id: persona.id, name: persona.name, question: asked, answered: answers.length }); }}
        busy={interview.busy}
        waitingFor={other}
        field={field}
      />}
    </div>
  );
}

/** Shortened for a suggestion: a whole friction can run long. */
const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The report's chats: everyone in the run, the latest conversation first, and the one picked beside the list (or in its place, when narrow). */
export function Interviews({ runId, report, answers, interview, personas, schema, events, pois, onInspect }: {
  runId: string; report: ReportData; answers: Answer[]; interview: Interview;
  personas: Persona[]; // the run's frozen profiles, for the profile card
  schema?: PersonaSchema;
  events: GnomiEvent[]; // the run's log, for each persona's replay
  pois?: Poi[];
  onInspect(personaId: string): void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [profile, setProfile] = useState(false);
  const [watching, setWatching] = useState(false);
  const section = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  type Who = ReportData['personas'][number];
  const threads = Map.groupBy(answers, (answer) => answer.persona_id);
  const latest = (id: string) => threads.get(id)?.at(-1)?.ts ?? 0;
  const segmentOf = (who: Who) => report.segments.find((segment) => segment.id === who.segment_id)?.name;
  const detail = (who: Who) => [segmentOf(who), OUTCOMES[who.outcome].text].filter(Boolean).join(' · ');
  const answering = (id: string) => { const waiting = waitingOn(interview, id, threads.get(id)?.length ?? 0); return !!waiting && !waiting.error; };
  const shown = report.personas.filter((who) => who.name.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => latest(b.id) - latest(a.id));
  const persona = report.personas.find((candidate) => candidate.id === open);
  const own = useMemo(() => events.filter((event) => event.persona_id === open), [events, open]);
  const steps = useMemo(() => toRows(own, assetPlaces(pois ?? [])).filter((row) => row.source?.type === 'persona.step').toReversed(), [own, pois]);
  const replay = persona && steps.some((row) => row.screenshot) ? { steps, events: own, shotLabel: shotLabels(own), summary: `${count(steps.length, 'step')} · ${OUTCOMES[persona.outcome].text}` } : undefined;
  // Questions from this persona's own run: its worst friction and how it ended, then, in a comparison, a requirement its segment left unknown (a must-have first), else one for anyone.
  const startersFor = (who: Who) => {
    const worst = report.frictions.filter((friction) => friction.persona_id === who.id).sort((a, b) => b.severity - a.severity)[0];
    const study = report.comparison?.study;
    const unknowns = (report.comparison?.cells ?? []).filter((cell) => cell.assessment === 'unknown' && cell.eligible > 0 && cell.segment_id === (who.segment_id ?? null));
    const open = unknowns.find((cell) => study?.criteria.find((criterion) => criterion.id === cell.criterion_id)?.importance === 'must_have') ?? unknowns[0];
    const criterion = study?.criteria.find((item) => item.id === open?.criterion_id)?.name;
    const target = study?.targets.find((item) => item.id === open?.target_id)?.name;
    return [
      worst && `At step ${worst.step_no} you reported “${clip(worst.what)}”. What did you expect?`,
      who.outcome === 'done' ? 'What made it easy to finish?' : who.outcome === 'abandoned' ? 'Why did you give up?' : 'What was hardest for you?',
      criterion && target ? `What did you see about ${lowerFirst(clip(criterion))} on ${clip(target, 40)}?` : 'What would you change first?',
    ].filter((starter): starter is string => !!starter);
  };
  function pick(id: string | null) {
    setOpen(id);
    setWatching(false);
    setProfile(false);
  }
  function back() {
    pick(null);
    // The list was hidden behind the chat on a narrow page: give focus back to the persona it came from.
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-persona="${CSS.escape(open ?? '')}"]`)?.focus());
  }
  return (
    <section ref={section} aria-labelledby="interviews-title" className="interviews">
      <SectionHeading id="interviews-title" title="Ask the personas" hint="Chat with anyone from this run about what they did, and watch their session. Each answer is new from the model: use it to find where to look in their steps, not as evidence." />
      <div className="interviews-layout" data-open={!!persona || undefined}>
        <div className="interviews-list">
          <input type="search" className="field-input" aria-label="Search personas" placeholder="Search personas" value={query} onChange={(event) => setQuery(event.target.value)} />
          <ul ref={list} aria-label="Personas">
            {shown.map((candidate) => {
              const last = threads.get(candidate.id)?.at(-1);
              const typing = answering(candidate.id);
              return <li key={candidate.id}>
                <button type="button" data-persona={candidate.id} aria-current={candidate.id === open || undefined} className="chat-contact" onClick={() => pick(candidate.id)}>
                  <PersonaAvatar name={candidate.name} id={candidate.id} pronouns={candidate.pronouns} />
                  <span className="chat-contact-copy">
                    <span className="chat-contact-top"><strong>{candidate.name}</strong>{last && <time>{dayLabel(last.ts) === 'Today' ? clock(last.ts) : dayLabel(last.ts)}</time>}</span>
                    <span className="chat-contact-preview" data-answering={typing || undefined}>{typing ? 'answering…' : last ? last.payload.answer : detail(candidate)}</span>
                  </span>
                  <span className="chat-contact-outcome" data-tone={OUTCOMES[candidate.outcome].tone} title={OUTCOMES[candidate.outcome].text} />
                </button>
              </li>;
            })}
            {!shown.length && query.trim() && <li className="chat-contact-none">No one matches “{query.trim()}”.</li>}
          </ul>
        </div>
        <div className="interviews-thread">
          {persona ? <>
            <header className="chat-header">
              <button type="button" className="chat-back" aria-label="All personas" onClick={back}><Icon name="back" size={18} /></button>
              <button type="button" className="chat-who" aria-label={`${persona.name}'s profile`} title="Open the profile" onClick={() => setProfile(true)}>
                <PersonaAvatar name={persona.name} id={persona.id} pronouns={persona.pronouns} />
                <span className="chat-header-copy"><strong>{persona.name}</strong><span data-answering={answering(persona.id) || undefined}>{answering(persona.id) ? 'answering…' : detail(persona)}</span></span>
              </button>
              {replay && <Button small variant="quiet" aria-label="Watch the replay" title="Watch the replay" onClick={() => setWatching(true)}><Icon name="play" size={15} /><span className="chat-header-label">Replay</span></Button>}
              <Button small variant="quiet" aria-label="Open timeline" title="Open timeline" onClick={() => onInspect(persona.id)}><Icon name="activity" size={15} /><span className="chat-header-label">Timeline</span></Button>
            </header>
            <PersonaChat key={persona.id} runId={runId} persona={persona} answers={threads.get(persona.id) ?? []} interview={interview} starters={startersFor(persona)} replay={replay} watching={watching} onWatch={setWatching} onProfile={() => setProfile(true)} autoFocus />
            {profile && <PersonaProfile
              persona={persona}
              profile={personas.find((candidate) => candidate.id === persona.id)}
              schema={schema}
              segment={segmentOf(persona)}
              onWatch={replay && (() => { setProfile(false); setWatching(true); })}
              onTimeline={() => { setProfile(false); onInspect(persona.id); }}
              onAsk={() => { setProfile(false); requestAnimationFrame(() => section.current?.querySelector('textarea')?.focus({ preventScroll: true })); }}
              onClose={() => setProfile(false)}
            />}
          </> : <div className="chat-empty">
            <span><Icon name="message" size={26} /></span>
            <h4>Pick someone to ask</h4>
            <p>Their answers come from what the log recorded of their session, so they can say they do not know.</p>
          </div>}
        </div>
      </div>
    </section>
  );
}
