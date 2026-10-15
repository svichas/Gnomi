import { useState } from 'react';
import type { SessionInfo } from '@gnomi/engine/types.ts';
import { call, errorText } from './engine.ts';
import { RecordingPanel } from './Recorder.tsx';
import type { Recorder } from './Recorder.tsx';
import { Card, Field, inputClass, Note, primaryButton, secondaryButton, when } from './ui.tsx';
import type { Outcome } from './ui.tsx';

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

  const record = (name: string) =>
    recorder.start(name, async () => (name ? saveFirst() : 'Name the role first, for example recruiter.'));

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

  return (
    <Card title="Logins">
      <div className="space-y-4">
        <p className="text-sm text-stone-600">
          For a site behind a login, record one session per role. You log in yourself in a separate browser window and Gnomi keeps the session,
          encrypted on this computer. Gnomi never sees your password.
        </p>
        {!sessionsPersist && (
          <Note tone="info">This computer has no secure key storage, so recorded logins will not survive a restart of Gnomi.</Note>
        )}

        <div>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Field label="Role name">
                <input
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value.toLowerCase())}
                  placeholder="recruiter"
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
            </div>
            <button type="button" onClick={() => record(newRole.trim().toLowerCase())} disabled={recorder.busy || recorder.recording !== null} className={primaryButton}>
              Record login
            </button>
          </div>
          <p className="mt-1 text-xs text-stone-500">
            One word of lowercase letters, digits, - or _, such as recruiter. Recording saves the project first, then opens its start page.
          </p>
        </div>

        <RecordingPanel recorder={recorder} />
        {recorder.outcome && <Note tone={recorder.outcome.ok ? 'ok' : 'error'}>{recorder.outcome.text}</Note>}

        {sessions.length > 0 && (
          <ul aria-label="Recorded logins" className="space-y-2">
            {sessions.map((session) => {
              const checked = checks[session.role];
              return (
                <li key={session.role} className="rounded-lg border border-stone-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-stone-900">{session.role}</p>
                      <p className="break-all text-xs text-stone-600">Starts on {session.start_url}</p>
                      <p className="text-xs text-stone-500">
                        Recorded {when(session.recorded_at)}. Last verified {session.verified_at === null ? 'never' : when(session.verified_at)}. {expiry(session)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => check(session.role)}
                        disabled={checked === 'checking'}
                        aria-label={`Check ${session.role} login`}
                        className={secondaryButton}
                      >
                        {checked === 'checking' ? 'Checking...' : 'Check'}
                      </button>
                      <button
                        type="button"
                        onClick={() => record(session.role)}
                        disabled={recorder.busy || recorder.recording !== null}
                        aria-label={`Re-record ${session.role} login`}
                        className={secondaryButton}
                      >
                        Re-record
                      </button>
                    </div>
                  </div>
                  {checked && checked !== 'checking' && (
                    <div className="mt-2">
                      <Note tone={checked.ok ? 'ok' : 'error'}>{checked.text}</Note>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
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
