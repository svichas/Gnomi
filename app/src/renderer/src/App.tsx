import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectInfo, SessionRun } from '@gnomi/engine/protocol.ts';
import type { Audience, PersonaSchema, ProjectConfig, RunSettings } from '@gnomi/simulation/types.ts';
import { AudienceTab } from './Audience.tsx';
import { call, connected, errorText, onEvent, setEventProject, stopped } from './engine.ts';
import { isEnd } from './activity.ts';
import { initialDraft, toConfig } from './form.ts';
import type { Draft, Form } from './form.ts';
import { Project } from './Project.tsx';
import { ProjectRunHistory } from './ProjectRunHistory.tsx';
import type { ProjectAction, ProjectCatalog } from '../../projects.ts';
import { configuredProviders, withAvailableProvider, type ProviderList } from '../../providers.ts';
import { ProjectDialog, Projects } from './Projects.tsx';
import { Review } from './Review.tsx';
import type { ReviewScreen } from './Review.tsx';
import { Run } from './Run.tsx';
import { Settings } from './Settings.tsx';
import { Button, Note } from './ui.tsx';
import { SimulationDock } from './SimulationDock.tsx';
import { Icon } from './Icon.tsx';
import logo from '../../../../assets/brand/gnomi-logo.svg';

const TABS = [
  { id: 'project', label: 'Setup' },
  { id: 'audience', label: 'Audience' },
  { id: 'review', label: 'Review' },
  { id: 'run', label: 'Simulation' },
] as const;
type Tab = (typeof TABS)[number]['id'] | 'settings';

function rememberedProject(): string | null {
  try { return localStorage.getItem('gnomi.open-project'); } catch { return null; }
}
function rememberProject(id: string) {
  try { localStorage.setItem('gnomi.open-project', id); } catch { /* The main process still remembers the current project. */ }
}
/** Prefer the live run when revisiting a project. */
const liveRun = (project: ProjectInfo | null) => project?.runs.find((run) => run.status === 'running');

export function App() {
  const [tab, setTab] = useState<Tab>('project');
  const [draft, setDraft] = useState<Draft | null>(null); // null until the project has been read; everything shows after that
  const [problem, setProblem] = useState<string | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [sessionsPersist, setSessionsPersist] = useState(true);
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
  const [home, setHome] = useState(true);
  const [review, setReview] = useState<{ key: number; config: ProjectConfig | string } | null>(null);
  const reviews = useRef(0);
  const [returnTab, setReturnTab] = useState<Tab>('project');
  const [providers, setProviders] = useState<ProviderList | null>(null);
  const [revision, setRevision] = useState(0);
  const baseline = useRef('');
  const projectDir = useRef<string | null>(null);
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
    projectDir.current = project.dir;
    setEventProject(project.dir);
    const next = initialDraft(project.project);
    next.settings = withAvailableProvider(next.settings, available.keys);
    if (!project.project) next.form.name = projects.projects.find((entry) => entry.id === projects.currentId)?.name ?? '';
    setInfo(project);
    setDraft(next);
    setProviders(available);
    baseline.current = JSON.stringify(next);
    setCatalog(projects);
    setRunId(liveRun(project)?.run_id ?? project.runs[0]?.run_id ?? null);
    setReview(null);
    setRevision((was) => was + 1);
  }

  const refresh = useCallback(async () => {
    const project = await call('get_project', {});
    if (project.dir === projectDir.current) setInfo(project);
  }, []);
  useEffect(() => onEvent((event) => { if (isEnd(event)) void refresh().catch((err) => setProblem(errorText(err))); }, info?.dir), [refresh, info?.dir]);
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
        const running = liveRun(loaded); // the page was reloaded mid-run
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

  // The review describes what will start, so every visit saves the project first and checks again from scratch.
  async function openReview(settings?: RunSettings) {
    setTab('review');
    setReview(null);
    let config: ProjectConfig | string;
    try { config = await save(settings); } catch (err) { config = errorText(err); }
    setReview({ key: ++reviews.current, config });
  }
  const go = (to: Tab) => {
    if (to === 'review') void openReview();
    else setTab(to);
  };
  const fix = (screen: ReviewScreen) => {
    if (screen === 'settings') setReturnTab('review');
    setTab(screen);
  };

  const setForm = (update: (form: Form) => Form) => setDraft((was) => was && { ...was, form: update(was.form) });
  const setSettings = (settings: RunSettings) => setDraft((was) => was && { ...was, settings: providers ? withAvailableProvider(settings, providers.keys) : settings });
  const setAudience = (audience: Audience | null) => setDraft((was) => was && { ...was, audience });
  const setSchema = (persona_schema: PersonaSchema) => setDraft((was) => was && { ...was, persona_schema });

  const currentProject = catalog?.projects.find((entry) => entry.id === catalog.currentId);
  const showHome = () => {
    setHome(true);
    void window.gnomi.listProjects().then(setCatalog).catch((err) => setProblem(errorText(err)));
  };
  function showRun(id: string) {
    setRunId(id);
    setHome(false);
    setTab('run');
    requestAnimationFrame(() => main.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }));
  }
  async function openSessionRun(run: SessionRun): Promise<boolean> {
    if (!run.project_id || !catalog?.projects.some((project) => project.id === run.project_id)) throw new Error('This project is no longer in your workspace.');
    if (catalog.currentId !== run.project_id) {
      if (await projectAction({ action: 'open', id: run.project_id }) === null) return false;
    }
    showRun(run.run_id);
    return true;
  }
  const back = () => {
    if (tab === 'settings') go(returnTab);
    else if (tab === 'run') go('review');
    else if (tab === 'review') setTab(draft?.form.comparison?.execution.collection === 'shared_research' ? 'project' : 'audience');
    else if (tab === 'audience') setTab('project');
    else showHome();
  };
  const headings = {
    project: ['What would you like to learn?', draft?.form.study_intent === 'choose_tool' ? 'Define your company requirements and add the tools you want to compare.' : 'Give your simulated users a place to start and a goal to try.'],
    audience: ['A few different perspectives.', 'Choose who will try your product. These personas are simulated users.'],
    review: ['One last look before you start.', draft?.form.comparison ? 'Review the shared brief, source access and collection budget before starting.' : 'Check what will run, fix anything flagged, then start. These are simulated users on your staging site.'],
    run: ['Simulation', draft?.form.comparison?.execution.collection === 'shared_research' ? 'Follow source collection and review the evidence for your decision.' : 'Follow your audience’s experience, from first impressions to final findings.'],
    settings: ['Make Gnomi work for you.', 'Connect an AI provider and choose your limits.'],
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <button type="button" onClick={showHome} className="brand-link" aria-label="Projects"><img src={logo} alt="Gnomi" /></button>
        <span className="header-divider" />
        <span className="header-project">{home ? 'Your workspace' : currentProject?.name ?? 'Your project'}</span>
        {!home && <div className="header-actions">
          <ProjectRunHistory key={revision} runs={info?.runs ?? []} selected={tab === 'run' ? runId : null} onSelect={showRun} />
          <Button id="tab-settings" variant="quiet" className="header-settings" aria-label="Settings" aria-pressed={tab === 'settings'} onClick={() => { if (tab === 'settings') go(returnTab); else { setReturnTab(tab); setTab('settings'); } }}><Icon name="settings" /><span>Settings</span></Button>
        </div>}
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
              <Button variant="quiet" className="back-button" onClick={back}><Icon name="back" size={18} />{tab === 'project' ? 'All projects' : tab === 'settings' ? 'Back to project' : tab === 'run' ? 'Back to review' : tab === 'review' ? 'Back to audience' : 'Back to setup'}</Button>
              <nav aria-label="Project steps" className="step-nav">
                {TABS.map(({ id, label }, index) => <button key={id} type="button" id={`tab-${id}`} aria-current={tab === id ? 'step' : undefined} onClick={() => go(id)}><span className="step-number">{index + 1}</span>{label}</button>)}
              </nav>
            </div>
            <div className={`page-heading ${tab === 'run' ? 'simulation-page-heading' : ''}`}><p className="eyebrow">{tab === 'settings' ? 'Preferences' : currentProject?.name ?? 'Your project'}</p><h1 tabIndex={-1}>{headings[tab][0]}</h1><p>{headings[tab][1]}</p></div>
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
                onReview={() => void openReview()}
                onSettings={() => { setReturnTab('project'); setTab('settings'); }}
                needsProvider={providers !== null && configuredProviders(providers.keys, draft.settings.local_base_url).length === 0}
              />
            </div>
            <div role="region" id="panel-audience" aria-labelledby="tab-audience" hidden={tab !== 'audience'}>
              <AudienceTab audience={draft.audience} onAudience={setAudience} schema={draft.persona_schema} onSchema={setSchema} settings={draft.settings} onSettings={setSettings} info={info} description={draft.form.description} projectName={draft.form.name} goal={draft.form.goal} save={save} refresh={refresh} onBack={() => setTab('project')} onReview={() => void openReview()} />
            </div>
            <div role="region" id="panel-review" aria-labelledby="tab-review" hidden={tab !== 'review'}>
              {review ? (
                <Review
                  key={review.key}
                  config={review.config}
                  info={info}
                  onFix={fix}
                  onBack={() => setTab('audience')}
                  onRecheck={() => void openReview()}
                  onSocial={(social) => {
                    const settings = { ...draft.settings, social };
                    setSettings(settings);
                    void openReview(settings);
                  }}
                  onChecked={refresh}
                  onStarted={(id) => {
                    setRunId(id);
                    setTab('run');
                    void refresh();
                  }}
                />
              ) : <p className="text-sm text-stone-500">Saving your project and checking the run…</p>}
            </div>
            <div role="region" id="panel-run" aria-labelledby="tab-run" hidden={tab !== 'run'}>
              <Run active={!home && tab === 'run'} runId={runId} runs={info?.runs ?? []} onSetup={() => go('project')} />
            </div>
          </div>
        )}
        {unsaved && <ProjectDialog title="Save your changes?" onCancel={() => { if (!savingChanges) void resolveUnsaved('cancel'); }}>
          <p className="text-sm text-stone-700">This project has unsaved changes. Save them before continuing, or discard them.</p>
          {saveProblem && <Note tone="error">{saveProblem}</Note>}
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void resolveUnsaved('save')} disabled={savingChanges} variant="primary">Save and continue</Button>
            <Button onClick={() => void resolveUnsaved('discard')} disabled={savingChanges}>Discard changes</Button>
            <Button onClick={() => void resolveUnsaved('cancel')} disabled={savingChanges}>Cancel</Button>
          </div>
        </ProjectDialog>}
      </main>
      <SimulationDock onOpen={openSessionRun} projects={catalog?.projects ?? []} />
    </div>
  );
}
