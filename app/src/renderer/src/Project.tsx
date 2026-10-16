import { useEffect, useState } from 'react';
import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import type { ProjectConfig } from '@gnomi/engine/types.ts';
import { hostOf, hostToConfirm, offeredHosts, startHost } from './form.ts';
import type { Draft, Form } from './form.ts';
import { Logins } from './Logins.tsx';
import { useRecorder } from './Recorder.tsx';
import { Summary } from './Summary.tsx';
import { ActionBar, Card, Check, Field, inputClass, Note, primaryButton, secondaryButton, useAction } from './ui.tsx';
import { Icon } from './Icon.tsx';
import { PersonaHeader } from './ProfileFields.tsx';

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
          <button type="button" onClick={add} className={secondaryButton}>
            Add host
          </button>
        </div>
        {problem && <Note tone="error">{problem}</Note>}
      </div>
    </Card>
  );
}

export function Project(props: {
  info: ProjectInfo | null;
  draft: Draft;
  onForm(update: (form: Form) => Form): void;
  save(): Promise<ProjectConfig | string>;
  sessionsPersist: boolean;
  onSaved(): Promise<void>;
  onStarted(runId: string): void;
  onAudience(): void;
  onSettings(): void;
  reviewRequest: number;
  needsProvider: boolean;
}) {
  const { info, draft, onForm, save, sessionsPersist, onSaved, onStarted, onAudience, onSettings, reviewRequest, needsProvider } = props;
  const { form, audience } = draft;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => onForm((was) => ({ ...was, [key]: value }));
  const [added, setAdded] = useState<string[]>([]); // hosts typed in by hand, kept in the list even when unticked
  const [summary, setSummary] = useState<ProjectConfig | null>(null);
  const { busy, outcome, run } = useAction();
  const sessions = info?.sessions ?? [];
  const needsPersonas = audience !== null && !info?.personas.length;
  const confirmHost = hostToConfirm(form.url);
  const start = startHost(form.url);

  const saveFirst = async () => {
    const saved = await save();
    return typeof saved === 'string' ? saved : null;
  };

  const recorder = useRecorder(async (session) => {
    if (form.role === null && audience === null) set('role', session.role); // the first login recorded is the one the built-in persona uses
    await onSaved();
  });

  const onSave = () =>
    run(async () => {
      const saved = await save();
      return typeof saved === 'string' ? { ok: false, text: saved } : { ok: true, text: 'Project saved.' };
    });

  // Starting saves first, so a run never uses an older goal than the one on screen; the summary is the last stop before it begins.
  const onStart = () =>
    run(async () => {
      const saved = await save();
      if (typeof saved === 'string') return { ok: false, text: saved };
      setSummary(saved);
      return null;
    });

  const persona = info?.persona;
  useEffect(() => { if (reviewRequest > 0) void onStart(); }, [reviewRequest]);

  const continueToAudience = () => run(async () => {
    const saved = await save();
    if (typeof saved === 'string') return { ok: false, text: saved };
    onAudience();
    return null;
  });

  return (
    <div className="setup-layout">
      <div className="space-y-5">
      <Card title="What to test">
        <div className="space-y-4">
          <Field label="Project name">
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Your product" className={inputClass} />
          </Field>
          <Field label="What the product does" hint="One sentence. It helps the persona understand the site.">
            <input
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="An applicant tracking system for recruiters"
              className={inputClass}
            />
          </Field>
          <Field label="Start page URL" hint="The persona starts here and can reach this host. Use your staging address.">
            <input
              type="url"
              value={form.url}
              onChange={(e) => set('url', e.target.value)}
              placeholder="https://staging.example.com"
              spellCheck={false}
              className={inputClass}
            />
          </Field>
          {confirmHost !== null && (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm text-amber-900">
                {confirmHost} does not look like a staging site. Gnomi must never run against production, because personas click, type and submit like real
                users.
              </p>
              <Check checked={form.confirmedHost === confirmHost} onChange={(on) => set('confirmedHost', on ? confirmHost : null)}>
                This is not a production site
              </Check>
            </div>
          )}
          <Field label="Goal" hint="What the persona should try to do, in your own words.">
            <textarea
              value={form.goal}
              onChange={(e) => set('goal', e.target.value)}
              rows={3}
              placeholder="Post a job for a backend engineer"
              className={inputClass}
            />
          </Field>
        </div>
      </Card>

      <details className="disclosure">
        <summary><Icon name="settings" />Access & advanced options<span>Logins, allowed websites, and safety</span></summary>
        <div className="space-y-5 disclosure-body">
      <Card title="Safety">
        <div className="space-y-4">
          <Field
            label="Production domains Gnomi must never touch"
            hint="Separate several with commas. Gnomi blocks these and their subdomains, and never starts a run against them."
          >
            <input
              value={form.production}
              onChange={(e) => set('production', e.target.value)}
              placeholder="acme.com, app.acme.com"
              spellCheck={false}
              className={inputClass}
            />
          </Field>
          <Field
            label="Reset hook URL (optional)"
            hint="Gnomi sends a POST here before a run, when you tick the box in the summary, so your staging data starts fresh. It must be on the start page's host or an allowed host."
          >
            <input
              type="url"
              value={form.reset}
              onChange={(e) => set('reset', e.target.value)}
              placeholder="https://staging.example.com/internal/reset"
              spellCheck={false}
              className={inputClass}
            />
          </Field>
        </div>
      </Card>

      <Logins
        sessions={sessions}
        role={form.role}
        perSegment={audience !== null}
        onRole={(role) => set('role', role)}
        recorder={recorder}
        saveFirst={saveFirst}
        onChecked={onSaved}
        sessionsPersist={sessionsPersist}
      />

      <AllowedHosts
        hosts={offeredHosts(sessions, form.allowed, added, start)}
        allowed={form.allowed}
        start={start}
        onToggle={(host, on) => set('allowed', on ? [...form.allowed, host] : form.allowed.filter((allowed) => allowed !== host))}
        onAdd={(host) => {
          setAdded((was) => [...was, host]);
          set('allowed', [...new Set([...form.allowed, host])]);
        }}
      />
        </div>
      </details>

      <ActionBar>
        {outcome && <Note tone={outcome.ok ? 'ok' : 'error'}>{outcome.text}</Note>}
        <button type="button" onClick={onSave} disabled={busy} className={secondaryButton}>Save project</button>
        <button type="button" onClick={continueToAudience} disabled={busy} className={primaryButton}>{busy ? 'Saving…' : 'Continue to audience'}<Icon name="arrow" size={18} /></button>
      </ActionBar>
      </div>

      <aside className="setup-aside" aria-label="Your test at a glance">
        <div className="aside-intro"><span className="aside-icon"><Icon name="leaf" size={24} /></span><h2>A little perspective<br />goes a long way.</h2><p>Watch simulated people try your product, then explore the moments that matter.</p></div>
        <ol className="journey-preview"><li><span>1</span><div><strong>Set the scene</strong><p>A website and a task to try.</p></div></li><li><span>2</span><div><strong>Meet your audience</strong><p>Different people, different perspectives.</p></div></li><li><span>3</span><div><strong>Follow their experience</strong><p>Actions, opinions, and evidence.</p></div></li></ol>
      {audience !== null ? (
        <Card title="Who will try it">
          <p className="text-sm text-stone-700">
            {info?.personas.length ? `${info.personas.length} simulated users in ${audience.segments.length} groups.` : 'Your audience is defined. Generate its personas in the Audience step before starting a run.'}
          </p>
        </Card>
      ) : (
        persona && (
          <Card title="Who will try it">
            <PersonaHeader persona={persona} />
            <p className="mt-3 text-sm text-stone-600">Try a quick run with this simulated user, or create your own audience.</p>
          </Card>
        )
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={needsPersonas ? onAudience : onStart} disabled={busy || recorder.recording !== null} className={`${secondaryButton} w-full`}>
            <Icon name={needsPersonas ? 'people' : 'play'} size={16} />{needsPersonas ? 'Build personas first' : 'Start run'}
          </button>
          {busy && <p className="text-sm text-stone-500">Working...</p>}
        </div>
        {needsProvider && <p className="text-xs text-stone-600">Before your first run, connect the AI provider that will power your simulated users.</p>}
        <button type="button" className="text-link" onClick={onSettings}>{needsProvider ? 'Connect an AI provider' : 'AI connection & budget settings'}<Icon name="arrow" size={14} /></button>
      </div>
      </aside>

      {summary && (
        <Summary
          config={summary}
          builtin={persona}
          personas={info?.personas ?? []}
          sessions={sessions}
          onChecked={onSaved}
          onRerecord={(role) => {
            setSummary(null);
            void recorder.start(role, saveFirst);
          }}
          onStarted={(runId) => {
            setSummary(null);
            onStarted(runId);
          }}
          onClose={() => setSummary(null)}
        />
      )}
    </div>
  );
}
