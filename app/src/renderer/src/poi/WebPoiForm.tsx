import { useState } from 'react';
import { Button, Card, Check, Field, inputClass, Note } from '../ui.tsx';
import { Icon } from '../Icon.tsx';
import type { PoiFormProps } from './index.ts';
import { hostOf, hostToConfirm, offeredHosts, startHost, type WebDraft } from './web.ts';

function AllowedHosts(props: { hosts: string[]; allowed: string[]; start: string | null; onToggle(host: string, on: boolean): void; onAdd(host: string): void }) {
  const { hosts, allowed, start, onToggle, onAdd } = props;
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function add() {
    if (!typed.trim()) return;
    const host = hostOf(typed);
    if (host === null) return setProblem(`"${typed.trim()}" is not a host name. Use one such as cdn.example.com.`);
    setProblem(null);
    setTyped('');
    if (host !== start) onAdd(host);
  }

  return (
    <Card title="Allowed hosts">
      <div className="space-y-4">
        <p className="text-sm text-stone-600">
          {start ? `Personas can always reach ${start}, the start page.` : 'Personas can always reach the start page.'} Every other host is blocked, and each
          report lists what was blocked so you can allow a host and run again.
        </p>
        {hosts.length === 0 ? (
          <p className="text-sm text-stone-500">No other hosts yet. Record a login to see which hosts the site talks to, or add one by hand.</p>
        ) : (
          <ul aria-label="Hosts to allow" className="space-y-2">
            {hosts.map((host) => (
              <li key={host}>
                <Check checked={allowed.includes(host)} onChange={(on) => onToggle(host, on)}>
                  {host}
                </Check>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="Add a host">
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') add();
                }}
                placeholder="cdn.example.com"
                spellCheck={false}
                className={inputClass}
              />
            </Field>
          </div>
          <Button onClick={add}>
            Add host
          </Button>
        </div>
        {problem && <Note tone="error">{problem}</Note>}
      </div>
    </Card>
  );
}

/** A web app: whose it is, its start page, the production guard, and what personas may reach. */
export function WebPoiForm({ draft, onChange, sessions }: PoiFormProps<WebDraft>) {
  const set = <K extends keyof WebDraft>(key: K, value: WebDraft[K]) => onChange((was) => ({ ...was, [key]: value }));
  const [added, setAdded] = useState<string[]>([]); // hosts typed in by hand, kept in the list even when unticked
  const observing = draft.mode === 'observe_only';
  const confirmHost = observing ? null : hostToConfirm(draft.url);
  const start = startHost(draft.url);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div role="group" aria-label="Whose site this is" className="flex flex-wrap gap-2">
          <Button small variant="quiet" aria-pressed={!observing} onClick={() => set('mode', 'full')}>Our product</Button>
          <Button small variant="quiet" aria-pressed={observing} onClick={() => set('mode', 'observe_only')}>Competitor, observe only</Button>
        </div>
        <p className="text-sm text-stone-600">
          {observing
            ? 'Personas browse and read but never send anything: Gnomi blocks every form submission and other write, opens at most one page every two seconds, follows the site’s robots.txt and never uses a recorded login. Afterwards the survey asks them to compare it with your product.'
            : 'Personas use it as your users would: they click, type and submit, and can log in with a recorded login.'}
        </p>
      </div>
      <Field label="Start page URL" hint={observing ? 'The persona starts here and can reach this host.' : 'The persona starts here and can reach this host. Use your staging address.'}>
        <input type="url" value={draft.url} onChange={(e) => set('url', e.target.value)} placeholder={observing ? 'https://competitor.example.com' : 'https://staging.example.com'} spellCheck={false} className={inputClass} />
      </Field>
      {confirmHost !== null && (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">
            {confirmHost} does not look like a staging site. Gnomi must never run against production, because personas click, type and submit like real
            users.
          </p>
          <Check checked={draft.confirmedHost === confirmHost} onChange={(on) => set('confirmedHost', on ? confirmHost : null)}>
            This is not a production site
          </Check>
        </div>
      )}
      <details className="disclosure">
        <summary><Icon name="settings" />Access & advanced options<span>Allowed websites and safety</span></summary>
        <div className="space-y-5 disclosure-body">
          <Card title="Safety">
            <div className="space-y-4">
              <Field
                label="Production domains Gnomi must never touch"
                hint="Separate several with commas. Gnomi blocks these and their subdomains, and never starts a run against them."
              >
                <input value={draft.production} onChange={(e) => set('production', e.target.value)} placeholder="acme.com, app.acme.com" spellCheck={false} className={inputClass} />
              </Field>
              {!observing && (
                <Field
                  label="Reset hook URL (optional)"
                  hint="Gnomi sends a POST here before a run, when you tick the box on the Review step, so your staging data starts fresh. It must be on the start page's host or an allowed host."
                >
                  <input type="url" value={draft.reset} onChange={(e) => set('reset', e.target.value)} placeholder="https://staging.example.com/internal/reset" spellCheck={false} className={inputClass} />
                </Field>
              )}
            </div>
          </Card>
          <AllowedHosts
            hosts={offeredHosts(sessions, draft.allowed, added, start)}
            allowed={draft.allowed}
            start={start}
            onToggle={(host, on) => set('allowed', on ? [...draft.allowed, host] : draft.allowed.filter((allowed) => allowed !== host))}
            onAdd={(host) => {
              setAdded((was) => [...was, host]);
              set('allowed', [...new Set([...draft.allowed, host])]);
            }}
          />
        </div>
      </details>
    </div>
  );
}
