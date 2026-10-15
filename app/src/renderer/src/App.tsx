import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import type { Audience, PersonaSchema, ProjectConfig, RunSettings } from '@gnomi/engine/types.ts';
import { AudienceTab } from './Audience.tsx';
import { call, connected, errorText, stopped } from './engine.ts';
import { initialDraft, toConfig } from './form.ts';
import type { Draft, Form } from './form.ts';
import { Project } from './Project.tsx';
import type { ProjectAction, ProjectCatalog } from '../../projects.ts';
import { configuredProviders, withAvailableProvider, type ProviderList } from '../../providers.ts';
import { ProjectDialog, Projects } from './Projects.tsx';
import { Run } from './Run.tsx';
import { Settings } from './Settings.tsx';
import { Note, primaryButton, secondaryButton } from './ui.tsx';
import { Icon } from './Icon.tsx';
import logo from '../../../../assets/brand/gnomi-logo.svg';

const TABS = [
  { id: 'project', label: 'Setup' },
  { id: 'audience', label: 'Audience' },
  { id: 'run', label: 'Activity' },
] as const;
type Tab = (typeof TABS)[number]['id'] | 'settings';

function rememberedProject(): string | null {
  try { return localStorage.getItem('gnomi.open-project'); } catch { return null; }
}
function rememberProject(id: string) {
  try { localStorage.setItem('gnomi.open-project', id); } catch { /* The main process still remembers the current project. */ }
}

export function App() {
  const [tab, setTab] = useState<Tab>('project');
  const [draft, setDraft] = useState<Draft | null>(null); // null until the project has been read; everything shows after that
  const [problem, setProblem] = useState<string | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [sessionsPersist, setSessionsPersist] = useState(true);
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
  const [home, setHome] = useState(true);
  const [reviewRequest, setReviewRequest] = useState(0);
  const [returnTab, setReturnTab] = useState<Tab>('project');
  const [providers, setProviders] = useState<ProviderList | null>(null);
  const [revision, setRevision] = useState(0);
  const baseline = useRef('');
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    window.scrollTo({ top: 0 });
    main.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }, [tab, home, revision]);
  const [unsaved, setUnsaved] = useState<{ resolve(choice: 'save' | 'discard' | 'cancel'): void } | null>(null);
  const [savingChanges, setSavingChanges] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);

  async function loadProject(project: ProjectInfo, projects: ProjectCatalog) {
    const available = await window.gnomi.listProviders();
    const next = initialDraft(project.project);
    next.settings = withAvailableProvider(next.settings, available.keys);
    if (!project.project) next.form.name = projects.projects.find((entry) => entry.id === projects.currentId)?.name ?? '';
    setInfo(project);
    setDraft(next);
    setProviders(available);
    baseline.current = JSON.stringify(next);
    setCatalog(projects);
    setRunId(project.runs.find((run) => run.status === 'running')?.run_id ?? project.runs[0]?.run_id ?? null);
    setReviewRequest(0);
    setRevision((was) => was + 1);
  }

  const refresh = useCallback(async () => setInfo(await call('get_project', {})), []);
  const refreshProviders = useCallback(async () => {
    const available = await window.gnomi.listProviders();
    setProviders(available);
    setDraft((current) => current && { ...current, settings: withAvailableProvider(current.settings, available.keys) });
  }, []);

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
        await loadProject(loaded, projects);
        setHome(projects.currentId !== 'development' && !loaded.project && rememberedProject() !== projects.currentId);
        const running = loaded.runs.find((run) => run.status === 'running'); // the page was reloaded mid-run
        if (running) {
          setRunId(running.run_id);
          setTab('run');
          setHome(false);
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
    const requested = settings ?? draft.settings;
    const resolved = providers ? withAvailableProvider(requested, providers.keys) : requested;
    const next = { ...draft, settings: resolved };
    if (resolved !== requested) setDraft((current) => current && current.settings === requested ? { ...current, settings: resolved } : current);
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
    if (result.project) await loadProject(result.project, result.catalog);
    else setCatalog(result.catalog);
    if (action.action === 'open' || action.action === 'create' || action.action === 'duplicate') {
      rememberProject(result.catalog.currentId);
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
  const setSettings = (settings: RunSettings) => setDraft((was) => was && { ...was, settings: providers ? withAvailableProvider(settings, providers.keys) : settings });
  const setAudience = (audience: Audience | null) => setDraft((was) => was && { ...was, audience });
  const setSchema = (persona_schema: PersonaSchema) => setDraft((was) => was && { ...was, persona_schema });

  const currentProject = catalog?.projects.find((entry) => entry.id === catalog.currentId);
  const showHome = () => {
    setHome(true);
    void window.gnomi.listProjects().then(setCatalog).catch((err) => setProblem(errorText(err)));
  };
  const back = () => {
    if (tab === 'settings') setTab(returnTab);
    else if (tab === 'run') setTab('audience');
    else if (tab === 'audience') setTab('project');
    else showHome();
  };
  const headings = {
    project: ['What would you like to learn?', 'Give your simulated users a place to start and a goal to try.'],
    audience: ['A few different perspectives.', 'Choose who will try your product. These personas are simulated users.'],
    run: ['See the experience unfold.', 'Follow what people try, where they pause, and what they have to say.'],
    settings: ['Make Gnomi work for you.', 'Connect an AI provider and choose your limits.'],
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <button type="button" onClick={showHome} className="brand-link" aria-label="Projects"><img src={logo} alt="Gnomi" /></button>
        <span className="header-divider" />
        <span className="header-project">{home ? 'Your workspace' : currentProject?.name ?? 'Your project'}</span>
        {!home && <button type="button" id="tab-settings" className="quiet-button header-settings" aria-label="Settings" aria-pressed={tab === 'settings'} onClick={() => { if (tab === 'settings') setTab(returnTab); else { setReturnTab(tab); setTab('settings'); } }}><Icon name="settings" /><span>Settings</span></button>}
      </header>

      <main ref={main} className={`app-main ${home ? 'projects-main' : ''}`}>
        {problem && (
          <div className="mb-5">
            <Note tone="error">{problem}</Note>
          </div>
        )}
        {home && catalog && <Projects catalog={catalog} onAction={projectAction} onReturn={() => setHome(false)} />}
        {!draft ? (
          <p className="text-sm text-stone-500">Starting Gnomi...</p>
        ) : (
          // All four stay mounted so a half-typed form or a run in progress survives a tab switch.
          <div key={revision} hidden={home}>
            <div className="journey-nav">
              <button type="button" className="quiet-button back-button" onClick={back}><Icon name="back" size={18} />{tab === 'project' ? 'All projects' : tab === 'settings' ? 'Back to project' : tab === 'run' ? 'Back to audience' : 'Back to setup'}</button>
              <nav aria-label="Project steps" className="step-nav">
                {TABS.map(({ id, label }, index) => <button key={id} type="button" id={`tab-${id}`} aria-current={tab === id ? 'step' : undefined} onClick={() => setTab(id)}><span className="step-number">{index + 1}</span>{label}</button>)}
              </nav>
            </div>
            <div className="page-heading"><p className="eyebrow">{tab === 'settings' ? 'Preferences' : currentProject?.name ?? 'Your project'}</p><h1 tabIndex={-1}>{headings[tab][0]}</h1><p>{headings[tab][1]}</p></div>
            <div role="region" id="panel-settings" aria-labelledby="tab-settings" hidden={tab !== 'settings'} className="max-w-2xl">
              <Settings settings={draft.settings} onSettings={setSettings} save={save} list={providers} reloadProviders={refreshProviders} />
            </div>
            <div role="region" id="panel-project" aria-labelledby="tab-project" hidden={tab !== 'project'}>
              <Project
                info={info}
                draft={draft}
                onForm={setForm}
                save={save}
                sessionsPersist={sessionsPersist}
                onSaved={refresh}
                onAudience={() => setTab('audience')}
                reviewRequest={reviewRequest}
                onSettings={() => { setReturnTab('project'); setTab('settings'); }}
                needsProvider={providers !== null && configuredProviders(providers.keys, draft.settings.local_base_url).length === 0}
                onStarted={(id) => {
                  setRunId(id);
                  setTab('run');
                  void refresh();
                }}
              />
            </div>
            <div role="region" id="panel-audience" aria-labelledby="tab-audience" hidden={tab !== 'audience'}>
              <AudienceTab audience={draft.audience} onAudience={setAudience} schema={draft.persona_schema} onSchema={setSchema} info={info} description={draft.form.description} projectName={draft.form.name} goal={draft.form.goal} save={save} refresh={refresh} onBack={() => setTab('project')} onReview={() => { setTab('project'); setReviewRequest((value) => value + 1); }} />
            </div>
            <div role="region" id="panel-run" aria-labelledby="tab-run" hidden={tab !== 'run'}>
              <Run active={!home && tab === 'run'} runId={runId} runs={info?.runs ?? []} onSelect={setRunId} onRunEnded={refresh} onSetup={() => setTab('project')} />
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
