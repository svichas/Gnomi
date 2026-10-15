import { useState } from 'react';
import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import type { ProjectConfig } from '@gnomi/engine/types.ts';
import { call } from './engine.ts';
import { hostOf, hostToConfirm, initialForm, offeredHosts, startHost, toConfig } from './form.ts';
import type { Form } from './form.ts';
import { Logins } from './Logins.tsx';
import { useRecorder } from './Recorder.tsx';
import { Summary } from './Summary.tsx';
import { Card, Check, Field, inputClass, Note, primaryButton, secondaryButton, useAction } from './ui.tsx';

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
  sessionsPersist: boolean;
  onSaved(): Promise<void>;
  onStarted(runId: string): void;
}) {
  const { info, sessionsPersist, onSaved, onStarted } = props;
  const [form, setForm] = useState(() => initialForm(info?.project));
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((was) => ({ ...was, [key]: value }));
  const [added, setAdded] = useState<string[]>([]); // hosts typed in by hand, kept in the list even when unticked
  const [summary, setSummary] = useState<ProjectConfig | null>(null);
  const { busy, outcome, run } = useAction();
  const sessions = info?.sessions ?? [];
  const confirmHost = hostToConfirm(form.url);
  const start = startHost(form.url);

  async function save(): Promise<ProjectConfig | string> {
    const config = toConfig(form);
    if (typeof config === 'string') return config;
    await call('save_project', { project: config });
    await onSaved();
    return config;
  }
  const saveFirst = async () => {
    const saved = await save();
    return typeof saved === 'string' ? saved : null;
  };

  const recorder = useRecorder(async (session) => {
    if (form.role === null) set('role', session.role); // the first login recorded is the one personas use
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
  return (
    <div className="space-y-5">
      <Card title="What to test">
        <div className="space-y-4">
          <Field label="Project name">
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Gym" className={inputClass} />
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

      {persona && (
        <Card title="Who will try it">
          <p className="text-sm font-medium text-stone-900">
            {persona.name}, {persona.job_title}
          </p>
          <p className="mt-1 text-sm text-stone-600">
            A {persona.seniority}-level {persona.job_title.toLowerCase()} at a {persona.company_size}-person {persona.industry} company, on a{' '}
            {persona.device} browser. Tech skill {persona.tech_skill} of 5, patience {persona.patience} of 5.
          </p>
          <p className="mt-2 text-sm text-stone-600">{persona.context_of_use}.</p>
          <p className="mt-2 text-sm italic text-stone-600">{persona.voice}</p>
          <p className="mt-3 text-xs text-stone-500">Every run uses this built-in persona for now.</p>
        </Card>
      )}

      <div className="sticky bottom-0 space-y-3 rounded-xl border border-stone-200 bg-white p-4 shadow-md">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onSave} disabled={busy} className={secondaryButton}>
            Save project
          </button>
          <button type="button" onClick={onStart} disabled={busy || recorder.recording !== null} className={primaryButton}>
            Start run
          </button>
          {busy && <p className="text-sm text-stone-500">Working...</p>}
        </div>
        {outcome && <Note tone={outcome.ok ? 'ok' : 'error'}>{outcome.text}</Note>}
      </div>

      {summary && (
        <Summary
          config={summary}
          persona={persona}
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
