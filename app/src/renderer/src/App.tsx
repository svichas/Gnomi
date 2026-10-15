import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import type { Audience, PersonaSchema, ProjectConfig, RunSettings } from '@gnomi/engine/types.ts';
import { AudienceTab } from './Audience.tsx';
import { call, connected, errorText, stopped } from './engine.ts';
import { initialDraft, toConfig } from './form.ts';
import type { Draft, Form } from './form.ts';
import { Project } from './Project.tsx';
import type { ProjectAction, ProjectCatalog } from '../../projects.ts';
import { ProjectDialog, Projects } from './Projects.tsx';
import { Run } from './Run.tsx';
import { Settings } from './Settings.tsx';
import { Note, primaryButton, secondaryButton } from './ui.tsx';

const TABS = [
  { id: 'settings', label: 'Settings' },
  { id: 'project', label: 'Project' },
  { id: 'audience', label: 'Audience' },
  { id: 'run', label: 'Run' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export function App() {
  const [tab, setTab] = useState<Tab>('project');
  const [draft, setDraft] = useState<Draft | null>(null); // null until the project has been read; everything shows after that
  const [problem, setProblem] = useState<string | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [sessionsPersist, setSessionsPersist] = useState(true);
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
  const [home, setHome] = useState(false);
  const [revision, setRevision] = useState(0);
  const baseline = useRef('');
  const [unsaved, setUnsaved] = useState<{ resolve(choice: 'save' | 'discard' | 'cancel'): void } | null>(null);
  const [savingChanges, setSavingChanges] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);

  function loadProject(project: ProjectInfo, projects: ProjectCatalog) {
    const next = initialDraft(project.project);
    if (!project.project) next.form.name = projects.projects.find((entry) => entry.id === projects.currentId)?.name ?? '';
    setInfo(project);
    setDraft(next);
    baseline.current = JSON.stringify(next);
    setCatalog(projects);
    setRunId(project.runs.find((run) => run.status === 'running')?.run_id ?? null);
    setRevision((was) => was + 1);
  }

  const refresh = useCallback(async () => setInfo(await call('get_project', {})), []);

  useEffect(() => {
    void stopped.then(setProblem);
    void (async () => {
      const { startupError, sessionsPersist } = await connected;
      setSessionsPersist(sessionsPersist);
      if (startupError) setProblem(`Gnomi could not start properly: ${startupError}`);
      let loaded: ProjectInfo | null = null;
      try {
        loaded = await call('get_project', {});
        const projects = await window.gnomi.listProjects();
        loadProject(loaded, projects);
        setHome(projects.currentId !== 'development');
        const running = loaded.runs.find((run) => run.status === 'running'); // the page was reloaded mid-run
        if (running) {
          setRunId(running.run_id);
          setTab('run');
          setHome(false);
        } else if (!(await window.gnomi.listProviders()).keys.length && !loaded.project?.settings.local_base_url) {
          setTab('settings');
        }
      } catch (err) {
        setProblem((was) => was ?? `Gnomi could not start properly: ${errorText(err)}`);
        setDraft(initialDraft(loaded?.project));
      }
      if (!loaded) setDraft(initialDraft(null));
    })();
  }, []);

  // One project, edited on three tabs and saved as a whole: a tab's Save writes what the others hold too.
  // `settings` is for a change made in the same moment, before the draft holds it (adding the local endpoint).
  async function save(settings?: RunSettings): Promise<ProjectConfig | string> {
    if (!draft) return 'Gnomi is still starting.';
    const next = settings ? { ...draft, settings } : draft;
    const config = toConfig(next);
    if (typeof config === 'string') return config;
    await call('save_project', { project: config });
    await refresh();
    baseline.current = JSON.stringify(next);
    setCatalog(await window.gnomi.listProjects());
    return config;
  }

  async function projectAction(action: ProjectAction): Promise<string | null> {
    if (draft && JSON.stringify(draft) !== baseline.current) {
      setSaveProblem(null);
      const choice = await new Promise<'save' | 'discard' | 'cancel'>((resolve) => setUnsaved({ resolve }));
      if (choice === 'cancel') return null;
    }
    const result = await window.gnomi.projectAction(action);
    if (result.canceled) return null;
    if (result.project) loadProject(result.project, result.catalog);
    else setCatalog(result.catalog);
    if (action.action === 'open' || action.action === 'create' || action.action === 'duplicate') {
      setHome(false);
      setTab('project');
    }
    return result.exportedTo ? `Project folder exported to ${result.exportedTo}` : ({ create: 'Project created.', open: 'Project opened.', rename: 'Project renamed.', duplicate: 'Project duplicated.', delete: 'Project moved to the Trash.', export: 'Project exported.' }[action.action]);
  }

  async function resolveUnsaved(choice: 'save' | 'discard' | 'cancel') {
    if (choice === 'save') {
      setSavingChanges(true);
      try {
        const result = await save();
        if (typeof result === 'string') { setSaveProblem(result); return; }
      } catch (err) {
        setSaveProblem(errorText(err));
        return;
      } finally { setSavingChanges(false); }
    }
    unsaved?.resolve(choice);
    setUnsaved(null);
  }

  const setForm = (update: (form: Form) => Form) => setDraft((was) => was && { ...was, form: update(was.form) });
  const setSettings = (settings: RunSettings) => setDraft((was) => was && { ...was, settings });
  const setAudience = (audience: Audience | null) => setDraft((was) => was && { ...was, audience });
  const setSchema = (persona_schema: PersonaSchema) => setDraft((was) => was && { ...was, persona_schema });

  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-8 px-6">
          <div className="flex items-center gap-4">
            <h1 className="py-3 text-lg font-semibold tracking-tight text-stone-900">Gnomi</h1>
            <button type="button" onClick={() => { setHome(true); void window.gnomi.listProjects().then(setCatalog); }} className="text-sm font-medium text-stone-600 hover:text-indigo-700">Projects</button>
          </div>
          <div role="tablist" aria-label="Screens" className="flex gap-1">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`tab-${id}`}
                aria-selected={!home && tab === id}
                aria-controls={`panel-${id}`}
                onClick={() => { setHome(false); setTab(id); }}
                className={`border-b-2 px-4 py-3.5 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600 ${
                  !home && tab === id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-stone-600 hover:text-stone-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6">
        {problem && (
          <div className="mb-5">
            <Note tone="error">{problem}</Note>
          </div>
        )}
        {home && catalog && <Projects catalog={catalog} onAction={projectAction} />}
        {!draft ? (
          <p className="text-sm text-stone-500">Starting Gnomi...</p>
        ) : (
          // All four stay mounted so a half-typed form or a run in progress survives a tab switch.
          <div key={revision} hidden={home}>
            <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" hidden={tab !== 'settings'} className="max-w-2xl">
              <Settings settings={draft.settings} onSettings={setSettings} save={save} />
            </div>
            <div role="tabpanel" id="panel-project" aria-labelledby="tab-project" hidden={tab !== 'project'} className="max-w-2xl">
              <Project
                info={info}
                draft={draft}
                onForm={setForm}
                save={save}
                sessionsPersist={sessionsPersist}
                onSaved={refresh}
                onStarted={(id) => {
                  setRunId(id);
                  setTab('run');
                  void refresh();
                }}
              />
            </div>
            <div role="tabpanel" id="panel-audience" aria-labelledby="tab-audience" hidden={tab !== 'audience'}>
              <AudienceTab audience={draft.audience} onAudience={setAudience} schema={draft.persona_schema} onSchema={setSchema} info={info} description={draft.form.description} projectName={draft.form.name} goal={draft.form.goal} save={save} refresh={refresh} />
            </div>
            <div role="tabpanel" id="panel-run" aria-labelledby="tab-run" hidden={tab !== 'run'}>
              <Run runId={runId} runs={info?.runs ?? []} onSelect={setRunId} onRunEnded={refresh} />
            </div>
          </div>
        )}
        {unsaved && <ProjectDialog title="Save your changes?" onCancel={() => { if (!savingChanges) void resolveUnsaved('cancel'); }}>
          <p className="text-sm text-stone-700">This project has unsaved changes. Save them before continuing, or discard them.</p>
          {saveProblem && <Note tone="error">{saveProblem}</Note>}
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => void resolveUnsaved('save')} disabled={savingChanges} className={primaryButton}>Save and continue</button>
            <button type="button" onClick={() => void resolveUnsaved('discard')} disabled={savingChanges} className={secondaryButton}>Discard changes</button>
            <button type="button" onClick={() => void resolveUnsaved('cancel')} disabled={savingChanges} className={secondaryButton}>Cancel</button>
          </div>
        </ProjectDialog>}
      </main>
    </div>
  );
}
