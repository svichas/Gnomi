import type { EventOf, Persona } from '@gnomi/engine/types.ts';
import { call } from './engine.ts';
import { RecordingPanel, useRecorder } from './Recorder.tsx';
import { Button, Note, useAction } from './ui.tsx';

/** The engine words a CAPTCHA block as "A recaptcha challenge is showing. ..."; the banner only needs the name of the challenge. */
function challengeKind(detail: string): string | null {
  const named = /^An? (.+?) challenge is showing/.exec(detail);
  return named ? named[1] : detail.length <= 40 ? detail : null;
}

const waitText = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`);

const listed = (names: string[]) => (names.length <= 3 ? names.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`);

/** Paused personas need the user: logins to record again (one group per role) and CAPTCHAs to turn off on staging. */
export function BlockedBanner(props: {
  blocks: EventOf<'persona.blocked'>[];
  personas: Map<string, Persona>;
  roleOf(persona: Persona | undefined): string | null;
  runId: string;
  pauseMs: number | null;
  ending: boolean;
  onEnd(): void;
}) {
  const { blocks, personas, roleOf, runId, pauseMs, ending, onEnd } = props;
  const retry = useAction();
  const resume = (ids: string[]) => call('resume_personas', { run_id: runId, persona_ids: ids });
  const named = (block: EventOf<'persona.blocked'>) => personas.get(block.persona_id ?? '')?.name ?? 'A persona';
  const expired = blocks.filter((block) => block.payload.reason === 'session_expired');
  const captchas = blocks.filter((block) => block.payload.reason === 'captcha');
  const roles = [...new Set(expired.map((block) => roleOf(personas.get(block.persona_id ?? ''))))];
  // Re-recording a role's login frees every persona that was waiting on it.
  const recorder = useRecorder(async (session) => {
    await resume(expired.filter((block) => roleOf(personas.get(block.persona_id ?? '')) === session.role).map((block) => block.persona_id ?? ''));
  });
  const busy = retry.busy || recorder.busy || ending;

  return (
    <section role="alert" aria-label="Personas are waiting for you" className="space-y-4 rounded-xl border-2 border-red-300 bg-red-50 p-5">
      {roles.map((role) => {
        const group = expired.filter((block) => roleOf(personas.get(block.persona_id ?? '')) === role);
        const names = group.map(named);
        return (
          <div key={role ?? 'none'} className="space-y-2">
            <h2 className="text-base font-semibold text-red-950">
              {group.length === 1 ? `${names[0]}’s login expired` : `${group.length} personas’ logins expired${role ? ` (${role})` : ''}`}
            </h2>
            <p className="text-sm text-red-900">
              {group.length > 1 && `${listed(names)}. `}Record the login again and {group.length === 1 ? 'the persona carries' : 'they carry'} on from where {group.length === 1 ? 'she' : 'they'} stopped.
            </p>
            <Button onClick={() => role !== null && recorder.start(role)} disabled={busy || role === null || recorder.recording !== null} variant="primary">
              Re-record {role ?? ''} login
            </Button>
          </div>
        );
      })}
      {captchas.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-red-950">
            {captchas.length === 1 ? named(captchas[0]) : `${captchas.length} personas (${listed(captchas.map(named))})`} hit a CAPTCHA
            {challengeKind(captchas[0].payload.detail) && ` (${challengeKind(captchas[0].payload.detail)})`}. Gnomi never solves these: turn the challenge off on staging or use the
            provider&rsquo;s test keys, then retry.
          </p>
          <Button
            onClick={() =>
              retry.run(async () => {
                await resume(captchas.map((block) => block.persona_id ?? ''));
                return null;
              })
            }
            disabled={busy}
            variant="primary"
          >
            Retry
          </Button>
        </div>
      )}
      {pauseMs !== null && <p className="text-xs text-red-900">Gnomi waits {waitText(pauseMs)} for you, then ends their runs.</p>}
      <RecordingPanel recorder={recorder} />
      <div>
        <Button onClick={onEnd} disabled={busy}>
          End run
        </Button>
      </div>
      {retry.outcome && <Note tone={retry.outcome.ok ? 'ok' : 'error'}>{retry.outcome.text}</Note>}
      {recorder.outcome && <Note tone={recorder.outcome.ok ? 'ok' : 'error'}>{recorder.outcome.text}</Note>}
    </section>
  );
}
