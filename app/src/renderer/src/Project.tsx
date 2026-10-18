import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import type { ProjectConfig } from '@gnomi/simulation/types.ts';
import type { Draft, Form } from './form.ts';
import { Logins } from './Logins.tsx';
import { PoiList } from './poi/PoiList.tsx';
import { useRecorder } from './Recorder.tsx';
import { ActionBar, Button, Card, Field, inputClass, Note, useAction } from './ui.tsx';
import { Icon } from './Icon.tsx';
import { PersonaHeader } from './ProfileFields.tsx';
import { ComparisonSetup } from './ComparisonSetup.tsx';

export function Project(props: {
  info: ProjectInfo | null;
  draft: Draft;
  onForm(update: (form: Form) => Form): void;
  save(): Promise<ProjectConfig | string>;
  sessionsPersist: boolean;
  onSaved(): Promise<void>;
  onAudience(): void;
  onReview(): void;
  onSettings(): void;
  needsProvider: boolean;
}) {
  const { info, draft, onForm, save, sessionsPersist, onSaved, onAudience, onReview, onSettings, needsProvider } = props;
  const { form, audience } = draft;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => onForm((was) => ({ ...was, [key]: value }));
  const { busy, outcome, run } = useAction();
  const sessions = info?.sessions ?? [];
  const needsPersonas = audience !== null && !info?.personas.length;

  const saveFirst = async () => {
    const saved = await save();
    return typeof saved === 'string' ? saved : null;
  };

  const recorder = useRecorder(async (session) => {
    if (!form.comparison && form.role === null && audience === null) set('role', session.role); // legacy single-product login
    await onSaved();
  });

  const onSave = () =>
    run(async () => {
      const saved = await save();
      return typeof saved === 'string' ? { ok: false, text: saved } : { ok: true, text: 'Project saved.' };
    });

  const persona = info?.persona;

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

      <PoiList pois={form.pois} onChange={(change) => onForm((was) => ({ ...was, pois: change(was.pois) }))} segments={audience?.segments ?? []} sessions={sessions} />

      <ComparisonSetup draft={draft} onChange={(study) => set('comparison', study)} sessions={sessions} sessionsPersist={sessionsPersist} recorder={recorder} saveFirst={saveFirst} />

      {/* Logins are recorded on, and used by, your own web apps only: a competitor's site is browsed logged out. */}
      {!form.comparison && form.pois.some((poi) => poi.type === 'web' && poi.mode === 'full') && <details className="disclosure">
        <summary><Icon name="settings" />Logins<span>Recorded logins for web apps</span></summary>
        <div className="space-y-5 disclosure-body">
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
        </div>
      </details>}

      <ActionBar>
        {outcome && <Note tone={outcome.ok ? 'ok' : 'error'}>{outcome.text}</Note>}
        <Button onClick={onSave} disabled={busy}>Save project</Button>
        <Button onClick={continueToAudience} disabled={busy} variant="primary">{busy ? 'Saving…' : 'Continue to audience'}<Icon name="arrow" size={18} /></Button>
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
          <Button onClick={needsPersonas ? onAudience : onReview} disabled={busy || recorder.recording !== null} className="w-full">
            <Icon name={needsPersonas ? 'people' : 'play'} size={16} />{needsPersonas ? 'Build personas first' : 'Review & start'}
          </Button>
          {busy && <p className="text-sm text-stone-500">Working...</p>}
        </div>
        {needsProvider && <p className="text-xs text-stone-600">Before your first run, connect the AI provider that will power your simulated users.</p>}
        <Button variant="link" onClick={onSettings}>{needsProvider ? 'Connect an AI provider' : 'AI connection & budget settings'}<Icon name="arrow" size={14} /></Button>
      </div>
      </aside>

    </div>
  );
}
