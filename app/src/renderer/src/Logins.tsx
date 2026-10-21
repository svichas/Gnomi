import { useState } from 'react';
import type { SessionInfo } from '@gnomi/simulation/types.ts';
import { call, errorText } from './engine.ts';
import { Icon } from './Icon.tsx';
import { RecordingPanel } from './Recorder.tsx';
import type { Recorder } from './Recorder.tsx';
import { Button, Card, Field, inputClass, Note, OutcomeNote, when } from './ui.tsx';
import type { Outcome } from './ui.tsx';

function loginStatus(session: SessionInfo, checked: Outcome | 'checking' | undefined): { tone: string; label: string } {
  if (checked && checked !== 'checking') return checked.ok ? { tone: 'good', label: 'Works' } : { tone: 'bad', label: 'Not working' };
  if (session.expires_at !== null && session.expires_at < Date.now()) return { tone: 'bad', label: 'Expired' };
  return session.verified_at === null ? { tone: 'neutral', label: 'Not checked' } : { tone: 'good', label: 'Ready' };
}

function expiry(session: SessionInfo): string {
  if (session.expires_at === null) return 'Its cookies last until the browser session ends.';
  return `Its cookies ${session.expires_at < Date.now() ? 'expired' : 'expire'} ${when(session.expires_at)}.`;
}

export function Logins(props: {
  sessions: SessionInfo[];
  role: string | null;
  perSegment: boolean; // with an audience, each segment picks its own login
  onRole(role: string | null): void;
  recorder: Recorder;
  /** Recording opens the saved start page, so the form is saved first; resolves with what is wrong, or null. */
  saveFirst(): Promise<string | null>;
  onChecked(): Promise<void>;
  sessionsPersist: boolean;
}) {
  const { sessions, role, perSegment, onRole, recorder, saveFirst, onChecked, sessionsPersist } = props;
  const [newRole, setNewRole] = useState('');
  const [checks, setChecks] = useState<Record<string, Outcome | 'checking'>>({});

  // The name only matters once there are several logins to choose between, so the first one gets a default.
  const defaultRole = sessions.some((session) => session.role === 'user') ? null : 'user';
  const record = (name: string) =>
    recorder.start(name, async () => (name ? saveFirst() : 'Name this login, for example recruiter.'));

  async function check(name: string) {
    setChecks((was) => ({ ...was, [name]: 'checking' }));
    let result: Outcome;
    try {
      const checked = await call('check_session', { role: name });
      result = checked.ok ? { ok: true, text: 'The login works.' } : { ok: false, text: checked.reason ?? `The login no longer works. It ended on ${checked.url}.` };
      await onChecked(); // a good check updates when the login was last verified
    } catch (err) {
      result = { ok: false, text: errorText(err) };
    }
    setChecks((was) => ({ ...was, [name]: result }));
  }

  const recordingBusy = recorder.busy || recorder.recording !== null;

  return (
    <Card title="Logins">
      <div className="space-y-4">
        <p className="text-sm text-stone-600">
          If the site needs a login, log in once yourself and Gnomi reuses that session for the personas. It is kept encrypted on this computer, and
          Gnomi never sees your password.
        </p>
        {!sessionsPersist && (
          <Note tone="info">This computer has no secure key storage, so recorded logins will not survive a restart of Gnomi.</Note>
        )}

        {sessions.length > 0 && (
          <ul aria-label="Recorded logins" className="space-y-2">
            {sessions.map((session) => {
              const checked = checks[session.role];
              const status = loginStatus(session, checked);
              return (
                <li key={session.role} className="rounded-lg border border-stone-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-stone-900">{session.role}</p>
                        <span className="tone-chip" data-tone={status.tone}>{status.label}</span>
                      </div>
                      <p className="break-all text-xs text-stone-600">Starts on {session.start_url}</p>
                      <p className="text-xs text-stone-500">
                        Recorded {when(session.recorded_at)}. Last verified {session.verified_at === null ? 'never' : when(session.verified_at)}. {expiry(session)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button small onClick={() => check(session.role)} disabled={checked === 'checking'} aria-label={`Check ${session.role} login`}>
                        {checked === 'checking' ? 'Checking…' : 'Check'}
                      </Button>
                      <Button small onClick={() => record(session.role)} disabled={recordingBusy} aria-label={`Re-record ${session.role} login`}>
                        Re-record
                      </Button>
                    </div>
                  </div>
                  {checked && checked !== 'checking' && !checked.ok && (
                    <div className="mt-2">
                      <Note tone="error">{checked.text}</Note>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <RecordingPanel recorder={recorder} />
        <OutcomeNote outcome={recorder.outcome} />

        {recorder.recording === null && (
          <div className="rounded-lg border border-dashed border-stone-300 p-3">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Field label={defaultRole ? 'Login name (optional)' : 'Login name'}>
                  <input
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value.toLowerCase())}
                    placeholder={defaultRole ?? 'recruiter'}
                    spellCheck={false}
                    className={inputClass}
                  />
                </Field>
              </div>
              <Button onClick={() => record(newRole.trim().toLowerCase() || (defaultRole ?? ''))} disabled={recordingBusy} variant={sessions.length ? 'secondary' : 'primary'}>
                <Icon name="plus" size={16} />
                {sessions.length ? 'Record another login' : 'Record login'}
              </Button>
            </div>
            <p className="mt-2 text-xs text-stone-500">
              A name is only needed when personas log in as different kinds of user, such as recruiter and candidate: lowercase letters, digits, - or _.
              Recording saves the project first, then opens its start page in a new browser window.
            </p>
          </div>
        )}

        {perSegment ? (
          <p className="text-sm text-stone-600">Each segment picks its own login on the Audience tab.</p>
        ) : (
          <Field label="Personas log in as">
            <select value={role ?? ''} onChange={(e) => onRole(e.target.value || null)} className={inputClass}>
              <option value="">Logged out</option>
              {role !== null && !sessions.some((session) => session.role === role) && <option value={role}>{role} (no login recorded)</option>}
              {sessions.map((session) => (
                <option key={session.role} value={session.role}>
                  {session.role}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
    </Card>
  );
}
