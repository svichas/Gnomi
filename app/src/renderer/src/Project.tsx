import { useState } from 'react';
import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import type { ProjectConfig } from '@gnomi/engine/types.ts';
import { call } from './engine.ts';
import { Card, Field, inputClass, Note, primaryButton, secondaryButton, useAction } from './ui.tsx';

/** The project as the form describes it, or the sentence telling what is missing. */
function toConfig(form: { name: string; description: string; url: string; goal: string }): ProjectConfig | string {
  const name = form.name.trim();
  const goal = form.goal.trim();
  const url = form.url.trim();
  if (!name) return 'Give the project a name.';
  let host = '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not a web address');
    host = parsed.host;
  } catch {
    return 'The start page needs a full web address, such as https://staging.example.com.';
  }
  if (!goal) return 'Say what the persona should try to do.';
  // shortcut: one web POI with a fixed id; add a POI list when a project needs several
  return { name, description: form.description.trim(), poi: { id: 'poi-1', type: 'web', name: host, start_url: url }, goal };
}

export function Project({ info, onSaved, onStarted }: { info: ProjectInfo | null; onSaved(): Promise<void>; onStarted(runId: string): void }) {
  const saved = info?.project;
  const [name, setName] = useState(saved?.name ?? '');
  const [description, setDescription] = useState(saved?.description ?? '');
  const [url, setUrl] = useState(saved?.poi.start_url ?? '');
  const [goal, setGoal] = useState(saved?.goal ?? '');
  const { busy, outcome, run } = useAction();

  async function save(): Promise<string | null> {
    const config = toConfig({ name, description, url, goal });
    if (typeof config === 'string') return config;
    await call('save_project', { project: config });
    await onSaved();
    return null;
  }

  const onSave = () =>
    run(async () => {
      const problem = await save();
      return problem ? { ok: false, text: problem } : { ok: true, text: 'Project saved.' };
    });

  // Starting saves first, so a run never uses an older goal than the one on screen.
  const onStart = () =>
    run(async () => {
      const problem = await save();
      if (problem) return { ok: false, text: problem };
      const { run_id } = await call('start_run', {});
      onStarted(run_id);
      return null; // the Run screen takes over
    });

  const persona = info?.persona;
  return (
    <div className="space-y-5">
      <Card title="What to test">
        <div className="space-y-4">
          <Field label="Project name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Gym" className={inputClass} />
          </Field>
          <Field label="What the product does" hint="One sentence. It helps the persona understand the site.">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="An applicant tracking system for recruiters"
              className={inputClass}
            />
          </Field>
          <Field label="Start page URL" hint="The persona stays on this site. Use your staging address.">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://staging.example.com"
              spellCheck={false}
              className={inputClass}
            />
          </Field>
          <Field label="Goal" hint="What the persona should try to do, in your own words.">
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder="Post a job for a backend engineer"
              className={inputClass}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={onSave} disabled={busy} className={secondaryButton}>
              Save project
            </button>
            <button type="button" onClick={onStart} disabled={busy} className={primaryButton}>
              Start run
            </button>
          </div>
          {busy && <p className="text-sm text-stone-500">Working...</p>}
          {outcome && <Note tone={outcome.ok ? 'ok' : 'error'}>{outcome.text}</Note>}
        </div>
      </Card>

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
    </div>
  );
}
