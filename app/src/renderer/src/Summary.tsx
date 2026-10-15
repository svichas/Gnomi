import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Persona, ProjectConfig, RunEstimate, SessionInfo } from '@gnomi/engine/types.ts';
import { call, errorText } from './engine.ts';
import { rolesInUse, startHost } from './form.ts';
import { Check, Note, primaryButton, secondaryButton, useAction, usd } from './ui.tsx';

type Login = 'checking' | { ok: boolean; reason: string | null };

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="break-words text-sm text-stone-900">{children}</dd>
    </div>
  );
}

const range = (low: number, high: number, show: (n: number) => string) => (show(low) === show(high) ? show(low) : `${show(low)}–${show(high)}`);

/** "about $0.40–$0.90 and 3–6 minutes", with the models it could not price. */
export function estimateText(estimate: RunEstimate): string {
  const minutes = range(Math.max(1, Math.round(estimate.minutes[0])), Math.max(1, Math.round(estimate.minutes[1])), String);
  return `About ${range(estimate.cost_usd[0], estimate.cost_usd[1], (n) => `$${n.toFixed(2)}`)} and ${minutes} ${minutes === '1' ? 'minute' : 'minutes'}`;
}

/** The last stop before a run: who will browse, what they may touch, what it should cost, and the logins it will use, checked now. */
export function Summary(props: {
  config: ProjectConfig;
  builtin: Persona | undefined;
  personas: Persona[];
  sessions: SessionInfo[];
  onChecked(): Promise<void>;
  onRerecord(role: string): void;
  onStarted(runId: string): void;
  onClose(): void;
}) {
  const { config, builtin, personas, sessions, onChecked, onRerecord, onStarted, onClose } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [reset, setReset] = useState(false);
  const roles = rolesInUse(config);
  const [logins, setLogins] = useState<Record<string, Login>>(() => Object.fromEntries(roles.map((role) => [role, 'checking' as const])));
  const [estimate, setEstimate] = useState<RunEstimate | { error: string } | null>(null);
  const { busy, outcome, run } = useAction();
  const { poi, audience, settings } = config;
  const loggedOut = audience ? audience.segments.some((segment) => segment.share > 0 && segment.role === null) : config.role === null;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    let current = true;
    for (const role of roles) {
      call('check_session', { role }).then(
        (checked) => {
          if (!current) return;
          setLogins((was) => ({ ...was, [role]: checked }));
          void onChecked(); // a good check updates when the login was last verified
        },
        (err) => current && setLogins((was) => ({ ...was, [role]: { ok: false, reason: errorText(err) } })),
      );
    }
    call('estimate_run', {}).then(
      (result) => current && setEstimate(result),
      (err) => current && setEstimate({ error: errorText(err) }),
    );
    return () => {
      current = false;
    };
  }, []);

  const start = () =>
    run(async () => {
      const { run_id } = await call('start_run', { reset });
      onStarted(run_id);
      return null;
    });

  function population(): ReactNode {
    if (!audience) return builtin ? `${builtin.name}, ${builtin.job_title} (the built-in persona)` : 'One built-in persona';
    if (personas.length === 0) return 'No personas yet. Generate them on the Audience tab first.';
    const counts = audience.segments.map((segment) => [segment.name, personas.filter((p) => p.segment_id === segment.id).length] as const).filter(([, n]) => n > 0);
    return `${personas.length} personas: ${counts.map(([name, n]) => `${n} ${name}`).join(', ')}`;
  }

  function loginStatus(role: string): ReactNode {
    const login = logins[role];
    if (login === 'checking' || login === undefined) return `Checking the recorded ${role} login...`;
    if (login.ok) return `The recorded ${role} login works.`;
    return (
      <span className="block space-y-2">
        <span className="block text-red-800">
          The recorded {role} login no longer works{login.reason ? `: ${login.reason}` : '.'}
        </span>
        <button type="button" onClick={() => onRerecord(role)} className={secondaryButton}>
          Re-record {role} login
        </button>
      </span>
    );
  }

  const startPages = [...roles.map((role) => `${role}: ${sessions.find((session) => session.role === role)?.start_url ?? poi.start_url}`), ...(loggedOut ? [`logged out: ${poi.start_url}`] : [])];
  const hosts = [startHost(poi.start_url) ?? poi.start_url, ...poi.allowed_hosts];
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="summary-title"
      className="m-auto max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-stone-200 bg-white p-0 shadow-xl backdrop:bg-stone-900/40"
    >
      <div className="space-y-4 p-5">
        <h2 id="summary-title" className="text-base font-semibold text-stone-900">
          Before you start
        </h2>
        <dl className="space-y-3">
          <Item label="Who will browse">{population()}</Item>
          <Item label="Start pages">
            {startPages.map((page) => (
              <span key={page} className="block">
                {page}
              </span>
            ))}
          </Item>
          <Item label="Logins">
            {roles.length === 0 && 'None: the personas browse logged out.'}
            {roles.map((role) => (
              <span key={role} className="mb-1 block">
                {loginStatus(role)}
              </span>
            ))}
            {roles.length > 0 && loggedOut && <span className="block text-stone-600">The other personas browse logged out.</span>}
          </Item>
          <Item label="Estimate">
            {estimate === null && 'Working it out...'}
            {estimate && 'error' in estimate && <span className="text-stone-600">No estimate: {estimate.error}</span>}
            {estimate && !('error' in estimate) && (
              <span className="space-y-1">
                {estimate.unpriced.length === 0 && <span className="block">
                  {estimateText(estimate)}, about {estimate.calls.toLocaleString()} model calls.
                </span>}
                {estimate.unpriced.length > 0 && (
                  <span className="block text-amber-800">No price is known for {estimate.unpriced.join(', ')}. Choose a model with a known price in Settings before starting.</span>
                )}
                {estimate.cost_usd[1] > settings.cost_budget_usd && (
                  <span className="block text-amber-800">That may be more than your budget, so the run could stop early.</span>
                )}
              </span>
            )}
          </Item>
          <Item label="Budgets">
            Recorded cost limit: {usd(settings.cost_budget_usd)}. Time limit: {settings.wall_clock_budget_min} minutes. Up to {settings.concurrency} browsers at a time.
            <span className="mt-1 block text-xs text-stone-500">At the cost limit, new work stops and outstanding model requests are canceled. Browser actions already started can finish. Providers may still charge for requests in flight, so billed cost can exceed the limit. Persona generation is charged separately.</span>
          </Item>
          <Item label="Allowed hosts">{hosts.join(', ')}. Everything else is blocked.</Item>
          <Item label="Production domains Gnomi must never touch">{poi.production_domains.length > 0 ? poi.production_domains.join(', ') : 'None listed.'}</Item>
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
          <button type="button" onClick={start} disabled={busy || !estimate || 'error' in estimate || estimate.unpriced.length > 0} className={primaryButton}>
            {busy ? 'Starting...' : 'Start run'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
