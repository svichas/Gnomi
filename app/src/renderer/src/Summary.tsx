import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Persona, ProjectConfig, SessionInfo } from '@gnomi/engine/types.ts';
import { call, errorText } from './engine.ts';
import { startHost } from './form.ts';
import { Check, Note, primaryButton, secondaryButton, useAction } from './ui.tsx';

type Login = 'checking' | { ok: boolean; reason: string | null };

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="break-words text-sm text-stone-900">{children}</dd>
    </div>
  );
}

/** The last stop before a run: everything it may touch, and the login it will use, checked now. */
export function Summary(props: {
  config: ProjectConfig;
  persona: Persona | undefined;
  sessions: SessionInfo[];
  onChecked(): Promise<void>;
  onRerecord(role: string): void;
  onStarted(runId: string): void;
  onClose(): void;
}) {
  const { config, persona, sessions, onChecked, onRerecord, onStarted, onClose } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [reset, setReset] = useState(false);
  const [login, setLogin] = useState<Login | null>(config.role === null ? null : 'checking');
  const { busy, outcome, run } = useAction();
  const { poi, role } = config;
  const startPage = sessions.find((session) => session.role === role)?.start_url ?? poi.start_url;
  const hosts = [startHost(poi.start_url) ?? poi.start_url, ...poi.allowed_hosts];

  useEffect(() => dialog.current?.showModal(), []);

  useEffect(() => {
    if (role === null) return;
    let current = true;
    call('check_session', { role }).then(
      (checked) => {
        if (!current) return;
        setLogin(checked);
        void onChecked(); // a good check updates when the login was last verified
      },
      (err) => current && setLogin({ ok: false, reason: errorText(err) }),
    );
    return () => {
      current = false;
    };
  }, [role]);

  const start = () =>
    run(async () => {
      const { run_id } = await call('start_run', { reset });
      onStarted(run_id);
      return null;
    });

  function loginStatus(): ReactNode {
    if (role === null) return 'None: the persona browses logged out.';
    if (login === 'checking' || login === null) return `Checking the recorded ${role} login...`;
    if (login.ok) return `The recorded ${role} login works.`;
    return (
      <span className="block space-y-2">
        <span className="block text-red-800">
          The recorded {role} login no longer works{login.reason ? `: ${login.reason}` : '.'}
        </span>
        <button type="button" onClick={() => onRerecord(role)} className={secondaryButton}>
          Re-record login
        </button>
      </span>
    );
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="summary-title"
      className="m-auto w-full max-w-lg rounded-xl border border-stone-200 bg-white p-0 shadow-xl backdrop:bg-stone-900/40"
    >
      <div className="space-y-4 p-5">
        <h2 id="summary-title" className="text-base font-semibold text-stone-900">
          Before you start
        </h2>
        <dl className="space-y-3">
          {persona && (
            <Item label="Persona">
              {persona.name}, {persona.job_title}
            </Item>
          )}
          <Item label="Start page">{startPage}</Item>
          <Item label="Login">{loginStatus()}</Item>
          <Item label="Allowed hosts">{hosts.join(', ')}. Everything else is blocked.</Item>
          <Item label="Production domains Gnomi must never touch">
            {poi.production_domains.length > 0 ? poi.production_domains.join(', ') : 'None listed.'}
          </Item>
        </dl>
        {poi.reset_hook_url !== null && (
          <div className="space-y-1">
            <Check checked={reset} onChange={setReset}>
              Reset staging before the run
            </Check>
            <p className="break-all pl-6 text-xs text-stone-500">Gnomi sends a POST to {poi.reset_hook_url} first.</p>
          </div>
        )}
        <p className="text-xs text-stone-500">
          Gnomi cannot see what staging does behind the scenes. Make sure it sends email to a test inbox and takes payments in test mode.
        </p>
        {outcome && <Note tone="error">{outcome.text}</Note>}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => dialog.current?.close()} className={secondaryButton}>
            Cancel
          </button>
          <button type="button" onClick={start} disabled={busy} className={primaryButton}>
            {busy ? 'Starting...' : 'Start run'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
