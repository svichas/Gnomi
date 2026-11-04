import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { EventOf, Report as ReportData } from '@gnomi/simulation/types.ts';
import { INTERVIEW_LABEL, QUESTION_MAX, QUESTION_WARNING } from '@gnomi/simulation/agent/interview.ts';
import { call, errorText } from './engine.ts';
import { Icon, PersonaAvatar } from './Icon.tsx';
import { OUTCOMES, SectionHeading } from './reportParts.tsx';
import { useCallCost } from './ReportStudy.tsx';
import { Button, Note } from './ui.tsx';
import './interview.css';

type Answer = EventOf<'persona.interviewed'>;
type Who = { id: string; name: string };

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

function Message({ from, text, note, at, status }: { from: 'team' | Who; text: string; note?: string; at?: number; status?: 'check' | 'clock' | 'alert' }) {
  const team = from === 'team';
  return (
    <div className="chat-row" data-from={team ? 'team' : 'persona'}>
      {!team && <PersonaAvatar name={from.name} id={from.id} />}
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

/** One persona's questions and answers as a chat, oldest first, then the question on its way and a box for the next one. */
export function PersonaChat({ runId, persona, answers, interview, askable = true, autoFocus = false }: { runId: string; persona: Who; answers: Answer[]; interview: Interview; askable?: boolean; autoFocus?: boolean }) {
  const [question, setQuestion] = useState('');
  const thread = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const waiting = waitingOn(interview, persona.id, answers.length);
  const other = interview.busy && interview.asking?.persona_id !== persona.id ? interview.asking?.name ?? null : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a message comes or goes, to show the newest
  useEffect(() => { thread.current?.scrollTo({ top: thread.current.scrollHeight }); }, [answers.length, waiting]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the chat opens from a click on its persona
  useEffect(() => { if (autoFocus) field.current?.focus(); }, []);
  return (
    <div className="chat">
      <div ref={thread} role="log" aria-label={`Conversation with ${persona.name}`} className="chat-thread">
        <p className="chat-notice"><Icon name="spark" size={14} />{INTERVIEW_LABEL} {persona.name} sees the earlier questions and answers here, which were generated the same way.</p>
        {answers.map((answer, i) => <Fragment key={answer.seq}>
          {dayOf(answer.ts) !== dayOf(answers[i - 1]?.ts ?? 0) && <p className="chat-day">{dayLabel(answer.ts)}</p>}
          <Message from="team" text={answer.payload.question} at={answer.ts} status="check" />
          <Message from={persona} text={answer.payload.answer} note="Generated after the run" at={answer.ts} />
        </Fragment>)}
        {waiting && <Message from="team" text={waiting.question} note={waiting.error ? 'Not answered' : 'Waiting'} status={waiting.error ? 'alert' : 'clock'} />}
        {waiting && !waiting.error && <div className="chat-row" data-from="persona">
          <PersonaAvatar name={persona.name} id={persona.id} />
          <div className="chat-bubble chat-typing"><span className="sr-only">{persona.name} is answering…</span><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></div>
        </div>}
        {waiting?.error && <div className="chat-failed">
          <Note tone="error">{waiting.error}</Note>
          {askable && <Button small onClick={() => void interview.ask({ ...waiting, error: undefined })} disabled={interview.busy}>Try again</Button>}
        </div>}
        {askable && !answers.length && !waiting && <div className="chat-starters" aria-label="Question ideas" role="group">
          {STARTERS.map((starter) => <button key={starter} type="button" onClick={() => { setQuestion(starter); field.current?.focus(); }}>{starter}</button>)}
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

/** The report's chats: everyone in the run, the latest conversation first, and the one picked beside the list (or in its place, when narrow). */
export function Interviews({ runId, report, answers, interview, onInspect }: { runId: string; report: ReportData; answers: Answer[]; interview: Interview; onInspect(personaId: string): void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const list = useRef<HTMLUListElement>(null);
  const threads = Map.groupBy(answers, (answer) => answer.persona_id);
  const latest = (id: string) => threads.get(id)?.at(-1)?.ts ?? 0;
  const detail = (persona: ReportData['personas'][number]) => [report.segments.find((segment) => segment.id === persona.segment_id)?.name, OUTCOMES[persona.outcome].text].filter(Boolean).join(' · ');
  const answering = (id: string) => { const waiting = waitingOn(interview, id, threads.get(id)?.length ?? 0); return !!waiting && !waiting.error; };
  const shown = report.personas.filter((persona) => persona.name.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => latest(b.id) - latest(a.id));
  const persona = report.personas.find((candidate) => candidate.id === open);
  function back() {
    setOpen(null);
    // The list was hidden behind the chat on a narrow page: give focus back to the persona it came from.
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-persona="${CSS.escape(open ?? '')}"]`)?.focus());
  }
  return (
    <section aria-labelledby="interviews-title" className="interviews">
      <SectionHeading id="interviews-title" title="Ask the personas" hint="Chat with anyone from this run about what they did. Each answer is new from the model: use it to find where to look in their steps, not as evidence." />
      <div className="interviews-layout" data-open={!!persona || undefined}>
        <div className="interviews-list">
          <input type="search" className="field-input" aria-label="Search personas" placeholder="Search personas" value={query} onChange={(event) => setQuery(event.target.value)} />
          <ul ref={list} aria-label="Personas">
            {shown.map((candidate) => {
              const last = threads.get(candidate.id)?.at(-1);
              const typing = answering(candidate.id);
              return <li key={candidate.id}>
                <button type="button" data-persona={candidate.id} aria-current={candidate.id === open || undefined} className="chat-contact" onClick={() => setOpen(candidate.id)}>
                  <PersonaAvatar name={candidate.name} id={candidate.id} />
                  <span className="chat-contact-copy">
                    <span className="chat-contact-top"><strong>{candidate.name}</strong>{last && <time>{dayLabel(last.ts) === 'Today' ? clock(last.ts) : dayLabel(last.ts)}</time>}</span>
                    <span className="chat-contact-preview" data-answering={typing || undefined}>{typing ? 'answering…' : last ? last.payload.answer : detail(candidate)}</span>
                  </span>
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
              <PersonaAvatar name={persona.name} id={persona.id} />
              <div className="chat-header-copy"><h4>{persona.name}</h4><p data-answering={answering(persona.id) || undefined}>{answering(persona.id) ? 'answering…' : detail(persona)}</p></div>
              <Button small variant="quiet" aria-label="Open timeline" title="Open timeline" onClick={() => onInspect(persona.id)}><Icon name="activity" size={15} /><span className="chat-header-label">Timeline</span></Button>
            </header>
            <PersonaChat key={persona.id} runId={runId} persona={persona} answers={threads.get(persona.id) ?? []} interview={interview} autoFocus />
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
