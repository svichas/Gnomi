import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import type { ProjectConfig } from '@gnomi/simulation/types.ts';
import type { Draft, Form } from './form.ts';
import { applyFormDecisionBrief, decisionBriefChanged, toConfig, withStudyIntent } from './form.ts';
import { Logins } from './Logins.tsx';
import { PoiList } from './poi/PoiList.tsx';
import { useRecorder } from './Recorder.tsx';
import { ActionBar, Button, Card, Field, inputClass, Note, useAction } from './ui.tsx';
import { Icon } from './Icon.tsx';
import { PersonaHeader } from './ProfileFields.tsx';
import { ComparisonSetup } from './ComparisonSetup.tsx';
import { DecisionBrief } from './DecisionBrief.tsx';

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
  const choosing = form.study_intent === 'choose_tool';
  const preview = choosing && !form.comparison ? toConfig(draft) : null;
  const study = form.comparison ?? (preview && typeof preview !== 'string' ? preview.comparison : null);
  const sharedResearch = study?.execution.collection === 'shared_research';
  const comparisonDraft = study && !form.comparison ? { ...draft, form: { ...form, comparison: study } } : draft;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => onForm((was) => ({ ...was, [key]: value }));
  const { busy, outcome, run } = useAction();
  const sessions = info?.sessions ?? [];
  const needsPersonas = !sharedResearch && audience !== null && (!info?.personas.length || audience.persona_count !== (info.generated_persona_count ?? info.project?.audience?.persona_count));

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
    if (sharedResearch) onReview(); else onAudience();
    return null;
  });

  return (
    <div className="setup-layout">
      <div className="space-y-5">
      <Card title={choosing ? 'What do you want to learn?' : 'What to test'}>
        <div className="space-y-4">
          <Field label="Study goal">
            <select className={inputClass} value={form.study_intent ?? ''} onChange={(e) => onForm((was) => withStudyIntent(was, e.target.value as Form['study_intent']))}>
              <option value="">{info?.project ? 'Existing product simulation' : 'Choose what you want to learn'}</option>
              <option value="choose_tool">Choose the best tool for my company</option>
              <option value="improve_product">Find ways to improve my product</option>
              <option value="test_workflow">Test a specific workflow</option>
            </select>
          </Field>
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
          <Field label={choosing ? 'Decision to make' : 'Goal'} hint={choosing ? 'The decision Gnomi should help you make after comparing evidence.' : 'What the persona should try to do, in your own words.'}>
            <textarea
              value={form.goal}
              onChange={(e) => set('goal', e.target.value)}
              rows={3}
              placeholder={choosing ? 'Choose an ATS for our hiring team' : 'Post a job for a backend engineer'}
              className={inputClass}
            />
          </Field>
          {choosing && <DecisionBrief value={form.decision_context} onChange={(value) => set('decision_context', value)} />}
          {decisionBriefChanged(form) && <Note tone="info">This brief differs from the saved tasks. Applying it replaces the current criteria, scenarios and tasks; review custom edits first. <Button small onClick={() => onForm(applyFormDecisionBrief)}>Apply decision brief</Button></Note>}
          {form.study_intent === 'test_workflow' && form.comparison && <Note tone="info">Personas will attempt the existing tasks. Review the tasks, prerequisites and each tool’s access below before running; changing the study goal preserves your tasks and permissions.</Note>}
        </div>
      </Card>

      <PoiList comparison={choosing || !!study} pois={form.pois} onChange={(change) => onForm((was) => ({ ...was, pois: change(was.pois).map((poi) => was.study_intent === 'choose_tool' && poi.type === 'web' && !was.comparison?.targets.some((target) => target.poi_ids.includes(poi.id) && target.access_scope === 'authenticated_workflow') ? { ...poi, mode: 'observe_only' as const } : poi) }))} segments={audience?.segments ?? []} sessions={sessions} />

      <ComparisonSetup draft={comparisonDraft} onChange={(study) => onForm((was) => ({ ...was, comparison: study, ...(choosing && study?.decision_context && was.decision_context === undefined ? { decision_context: study.decision_context } : {}) }))} sessions={sessions} sessionsPersist={sessionsPersist} recorder={recorder} saveFirst={saveFirst} />

      {/* Logins are recorded on, and used by, your own web apps only: a competitor's site is browsed logged out. */}
      {!choosing && !study && form.pois.some((poi) => poi.type === 'web' && poi.mode === 'full') && <details className="disclosure">
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
        <Button onClick={continueToAudience} disabled={busy} variant="primary">{busy ? 'Saving…' : sharedResearch ? 'Review research & start' : 'Continue to audience'}<Icon name="arrow" size={18} /></Button>
      </ActionBar>
      </div>

      <aside className="setup-aside" aria-label="Your test at a glance">
        <div className="aside-intro"><span className="aside-icon"><Icon name="leaf" size={24} /></span><h2>A little perspective<br />goes a long way.</h2><p>{choosing ? 'Compare the evidence that matters to your company and see what still needs checking.' : 'Watch simulated people try your product, then explore the moments that matter.'}</p></div>
        <ol className="journey-preview"><li><span>1</span><div><strong>{choosing ? 'Define your decision' : 'Set the scene'}</strong><p>{choosing ? 'One company and clear requirements.' : 'A website and a task to try.'}</p></div></li><li><span>2</span><div><strong>{choosing ? 'Compare tools' : 'Meet your audience'}</strong><p>{choosing ? 'Equal questions, captured sources.' : 'Different people, different perspectives.'}</p></div></li><li><span>3</span><div><strong>{choosing ? 'Review the decision' : 'Follow their experience'}</strong><p>{choosing ? 'Tradeoffs, unknowns and next checks.' : 'Actions, opinions, and evidence.'}</p></div></li></ol>
      {sharedResearch ? <Card title="Public evidence research"><p className="text-sm text-stone-700">One fixed company scenario, researched once per tool. No persona generation is required. Use persona tasks later to test how people discover information or complete workflows.</p></Card> : audience !== null ? (
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
