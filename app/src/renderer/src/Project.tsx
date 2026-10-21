import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import type { ProjectConfig } from '@gnomi/simulation/types.ts';
import type { Draft, Form } from './form.ts';
import { Logins } from './Logins.tsx';
import { PoiList } from './poi/PoiList.tsx';
import { poiOf } from './poi/index.ts';
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
  const needsPersonas = audience !== null && (!info?.personas.length || audience.persona_count !== (info.generated_persona_count ?? info.project?.audience?.persona_count));

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
  const readyMaterials = form.pois.filter((poi) => typeof poiOf(poi) !== 'string').length;
  const briefReady = !!(form.name.trim() && form.goal.trim());

  const continueToAudience = () => run(async () => {
    const saved = await save();
    if (typeof saved === 'string') return { ok: false, text: saved };
    onAudience();
    return null;
  });

  return (
    <div className="setup-layout">
      <div className="space-y-5">
      <Card id="study-brief" title="What to test" description="Start with a clear question. Everything in the study follows from here.">
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

      <div id="study-materials"><PoiList pois={form.pois} onChange={(change) => onForm((was) => ({ ...was, pois: change(was.pois) }))} segments={audience?.segments ?? []} sessions={sessions} /></div>

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

      <ActionBar notice={outcome && !outcome.ok && <Note tone="error">{outcome.text}</Note>}>
        {outcome?.ok && <Note tone="ok">{outcome.text}</Note>}
        <Button onClick={onSave} disabled={busy}>Save project</Button>
        <Button onClick={continueToAudience} disabled={busy} variant="primary">{busy ? 'Saving…' : 'Continue to audience'}<Icon name="arrow" size={18} /></Button>
      </ActionBar>
      </div>

      <aside className="setup-aside" aria-label="Your test at a glance">
        <div className="study-summary">
          <div className="study-summary-heading"><Icon name="report" size={18} /><h2>Your study at a glance</h2></div>
          <p className="study-summary-goal">{form.goal.trim() || 'What would you like to find out?'}</p>
          <dl className="study-summary-facts"><div><dt>Materials</dt><dd>{form.pois.length}<span>{form.pois.length === 1 ? 'source' : 'sources'} to explore</span></dd></div><div><dt>Audience</dt><dd>{audience?.persona_count ?? 1}<span>simulated people</span></dd></div></dl>
          <p className="study-summary-label">Before you continue</p>
          <ul className="setup-checklist">
            <li data-ready={briefReady}><Icon name={briefReady ? 'check' : 'plus'} size={15} /><a href="#study-brief">{briefReady ? 'Study brief added' : 'Define your study brief'}</a></li>
            <li data-ready={readyMaterials > 0 && readyMaterials === form.pois.length}><Icon name={readyMaterials > 0 && readyMaterials === form.pois.length ? 'check' : 'plus'} size={15} /><a href="#study-materials">{form.pois.length ? `${readyMaterials} of ${form.pois.length} materials ready` : 'Add something to explore'}</a></li>
            <li data-ready={!needsProvider}><Icon name={needsProvider ? 'plus' : 'check'} size={15} /><button type="button" onClick={onSettings}>{needsProvider ? 'Connect an AI provider' : 'AI provider configured'}</button></li>
          </ul>
        </div>
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
