import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectInfo, SessionRun } from '@gnomi/engine/protocol.ts';
import type { Audience, PersonaSchema, ProjectConfig, RunSettings } from '@gnomi/simulation/types.ts';
import { AudienceTab } from './Audience.tsx';
import { call, connected, errorText, onEvent, onRepeatFailed, setEventProject, stopped } from './engine.ts';
import { isEnd } from './activity.ts';
import { initialDraft, toConfig } from './form.ts';
import type { Draft, Form } from './form.ts';
import { Project } from './Project.tsx';
import { ProjectRunHistory } from './ProjectRunHistory.tsx';
import type { ProjectAction, ProjectCatalog, WorkspaceRun } from '../../projects.ts';
import { configuredProviders, withAvailableProvider, type ProviderList } from '../../providers.ts';
import { Projects } from './Projects.tsx';
import { Review } from './Review.tsx';
import type { ReviewScreen } from './Review.tsx';
import { Run } from './Run.tsx';
import { RunCompare } from './RunCompare.tsx';
import { Settings } from './Settings.tsx';
import { Button, Dialog, Note, OpenSettings } from './ui.tsx';
import type { SettingsSection } from './credentials.ts';
import { SimulationDock } from './SimulationDock.tsx';
import { Icon } from './Icon.tsx';
import logo from '../../../../assets/brand/gnomi-logo.svg';

const TABS = [
  { id: 'project', label: 'Setup', description: 'Your question & materials' },
  { id: 'audience', label: 'Audience', description: 'People & perspectives' },
  { id: 'review', label: 'Review', description: 'Readiness & run limits' },
  { id: 'run', label: 'Simulation', description: 'Activity & findings' },
] as const;
type Tab = (typeof TABS)[number]['id'] | 'settings' | 'runs';

/** Each page's heading, and where its Back button goes in words. */
const PAGES: Record<Tab, { eyebrow: string; title: string; intro: string; back: string }> = {
  project: { eyebrow: 'Study setup', title: 'What would you like to learn?', intro: 'Give your simulated users a place to start and a goal to try.', back: 'All projects' },
  audience: { eyebrow: 'Audience builder', title: 'A few different perspectives.', intro: 'Choose who will try your product. These personas are simulated users.', back: 'Back to setup' },
  review: { eyebrow: 'Ready to run', title: 'One last look before you start.', intro: 'Check what will run, fix anything flagged, then start. These are simulated users on your staging site.', back: 'Back to audience' },
  run: { eyebrow: 'Simulation workspace', title: 'Simulation', intro: 'Follow your audience’s experience, from first impressions to final findings.', back: 'Back to review' },
  settings: { eyebrow: 'Preferences', title: 'Make Gnomi work for you.', intro: 'Connect an AI provider and choose your limits.', back: 'Back to project' },
  runs: { eyebrow: 'Project history', title: 'Past runs', intro: 'Every simulation saved in this project, newest first. Open one to see its report.', back: 'Back to project' },
};

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
  const [comparing, setComparing] = useState<{ base: string; run: string } | null>(null);
  const [sessionsPersist, setSessionsPersist] = useState(true);
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
  const [home, setHome] = useState(true);
  const [homePage, setHomePage] = useState<'projects' | 'runs' | 'settings'>('projects');
  const [allRuns, setAllRuns] = useState<WorkspaceRun[] | null>(null);
  const [review, setReview] = useState<{ key: number; config: ProjectConfig | string } | null>(null);
  const reviews = useRef(0);
  const [returnTab, setReturnTab] = useState<Tab>('project');
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [providers, setProviders] = useState<ProviderList | null>(null);
  const [revision, setRevision] = useState(0);
  const baseline = useRef('');
  const projectDir = useRef<string | null>(null);
  const main = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: home, homePage and revision mark a new page, which moves focus to its heading
  useEffect(() => {
    const card = tab === 'settings' && settingsSection ? document.getElementById(`settings-${settingsSection}`) : null;
    if (card) { card.scrollIntoView({ block: 'start' }); card.focus({ preventScroll: true }); return; }
    window.scrollTo({ top: 0 });
    main.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }, [tab, home, homePage, revision, settingsSection]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: lists the runs again each time a home page opens
  useEffect(() => { if (home) void window.gnomi.listRuns().then(setAllRuns, (err) => setProblem(errorText(err))); }, [home, homePage]);
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
    setComparing(null);
    setRevision((was) => was + 1);
  }

  const refresh = useCallback(async () => {
    const project = await call('get_project', {});
    if (project.dir === projectDir.current) setInfo(project);
  }, []);
  // A start too: the next run of a repeat set starts by itself, and only the run list says a run is active.
  useEffect(() => onEvent((event) => { if (isEnd(event) || event.type === 'run.started') void refresh().catch((err) => setProblem(errorText(err))); }, info?.dir), [refresh, info?.dir]);
  useEffect(() => onRepeatFailed((error) => setProblem(`The repeat set ended early: ${error}`)), []);
  const refreshProviders = useCallback(async () => {
    const available = await window.gnomi.listProviders();
    setProviders(available);
    setDraft((current) => current && { ...current, settings: withAvailableProvider(current.settings, available.keys) });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: startup runs once; loadProject only uses setters and refs
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
    if (screen === 'settings') { setReturnTab('review'); setSettingsSection(null); }
    setTab(screen);
  };
  /** From an error anywhere in the workspace to the Settings card that fixes it; Back returns to where it was. */
  const openSettings = (section: SettingsSection | null) => {
    if (tab !== 'settings' && tab !== 'runs') setReturnTab(tab);
    setSettingsSection(section);
    setHome(false);
    setTab('settings');
  };
  const openRuns = () => {
    if (tab !== 'settings' && tab !== 'runs') setReturnTab(tab);
    setTab('runs');
  };

  const setForm = (update: (form: Form) => Form) => setDraft((was) => was && { ...was, form: update(was.form) });
  const setSettings = (settings: RunSettings) => setDraft((was) => was && { ...was, settings: providers ? withAvailableProvider(settings, providers.keys) : settings });
  const setAudience = (audience: Audience | null) => setDraft((was) => was && { ...was, audience });
  const setSchema = (persona_schema: PersonaSchema) => setDraft((was) => was && { ...was, persona_schema });

  const currentProject = catalog?.projects.find((entry) => entry.id === catalog.currentId);
  const dirty = draft !== null && JSON.stringify(draft) !== baseline.current;
  const showHome = () => {
    setHome(true);
    setHomePage('projects');
    void window.gnomi.listProjects().then(setCatalog).catch((err) => setProblem(errorText(err)));
  };
  function showRun(id: string) {
    setRunId(id);
    setHome(false);
    setTab('run');
    requestAnimationFrame(() => main.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }));
  }
  const started = (id: string) => {
    setProblem(null);
    setRunId(id);
    setTab('run');
    void refresh();
  };
  async function openSessionRun(run: Pick<SessionRun, 'project_id' | 'run_id'>): Promise<boolean> {
    if (!run.project_id || !catalog?.projects.some((project) => project.id === run.project_id)) throw new Error('This project is no longer in your workspace.');
    if (catalog.currentId !== run.project_id) {
      if (await projectAction({ action: 'open', id: run.project_id }) === null) return false;
    }
    showRun(run.run_id);
    return true;
  }
  const back = () => {
    if (tab === 'settings' || tab === 'runs') go(returnTab);
    else if (tab === 'run') go('review');
    else if (tab === 'review') setTab('audience');
    else if (tab === 'audience') setTab('project');
    else showHome();
  };

  return (
    <OpenSettings.Provider value={openSettings}>
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="app-header">
        <button type="button" onClick={showHome} className="brand-link" aria-label="Projects"><img src={logo} alt="Gnomi" /></button>
        <span className="header-divider" />
        <span className="header-project">{home ? 'Your workspace' : currentProject?.name ?? 'Your project'}</span>
        {home ? <div className="header-actions">
          <Button id="home-runs" variant="quiet" className="header-runs" aria-label="Past runs" aria-pressed={homePage === 'runs'} onClick={() => setHomePage(homePage === 'runs' ? 'projects' : 'runs')}><Icon name="clock" /><span>Past runs</span><span className="project-history-count">{allRuns?.length ?? 0}</span></Button>
          <Button id="home-settings" variant="quiet" className="header-settings" aria-label="Settings" aria-pressed={homePage === 'settings'} onClick={() => setHomePage(homePage === 'settings' ? 'projects' : 'settings')}><Icon name="settings" /><span>Settings</span></Button>
        </div> : <div className="header-actions">
          <Button id="tab-runs" variant="quiet" className="header-runs" aria-label="Past runs" aria-pressed={tab === 'runs'} onClick={() => { if (tab === 'runs') go(returnTab); else openRuns(); }}><Icon name="clock" /><span>Past runs</span><span className="project-history-count">{info?.runs.length ?? 0}</span></Button>
          <Button id="tab-settings" variant="quiet" className="header-settings" aria-label="Settings" aria-pressed={tab === 'settings'} onClick={() => { if (tab === 'settings') go(returnTab); else openSettings(null); }}><Icon name="settings" /><span>Settings</span></Button>
        </div>}
      </header>

      <main ref={main} id="main-content" tabIndex={-1} className={`app-main ${home ? 'projects-main' : ''}`}>
        {problem && (
          <div className="mb-5">
            <Note tone="error">{problem}</Note>
          </div>
        )}
        {home && catalog && homePage === 'projects' && <Projects catalog={catalog} onAction={projectAction} onReturn={() => setHome(false)} />}
        {home && homePage !== 'projects' && <div className="workspace-page">
          <Button variant="quiet" className="back-button" onClick={() => setHomePage('projects')}><Icon name="back" size={18} />All projects</Button>
          {homePage === 'runs'
            ? <div className="page-heading"><p className="eyebrow">Workspace history</p><h1 tabIndex={-1}>Past runs</h1><p>Every simulation from all your projects, newest first. Open one to see its report.</p></div>
            : <div className="page-heading"><p className="eyebrow">Preferences</p><h1 tabIndex={-1}>Connections</h1><p>AI providers and Figma, shared by all your projects. Budgets and models are set in each project’s Settings.</p></div>}
          {homePage === 'runs'
            ? allRuns ? <section aria-label="All project runs"><ProjectRunHistory runs={allRuns} selected={null} onSelect={(run) => void openSessionRun(run).catch((err) => setProblem(errorText(err)))} /></section> : <p className="text-sm text-stone-500">Loading your runs…</p>
            : draft && <OpenSettings.Provider value={null}><Settings workspace settings={draft.settings} onSettings={setSettings} save={save} list={providers} reloadProviders={refreshProviders} /></OpenSettings.Provider>}
        </div>}
        {!draft ? (
          <p className="text-sm text-stone-500">Starting Gnomi...</p>
        ) : (
          // All four stay mounted so a half-typed form or a run in progress survives a tab switch.
          <div key={revision} hidden={home} className="project-workspace">
            <div className="journey-nav">
              <Button variant="quiet" className="back-button" onClick={back}><Icon name="back" size={18} />{PAGES[tab].back}</Button>
              <p className="workflow-label">Your workflow</p>
              <nav aria-label="Project steps" className="step-nav">
                {TABS.map(({ id, label, description }, index) => <button key={id} type="button" id={`tab-${id}`} aria-label={label} aria-current={tab === id ? 'step' : undefined} onClick={() => go(id)}><span className="step-number">{index + 1}</span><span className="step-copy"><strong>{label}</strong><small>{description}</small></span><Icon name="chevron" size={14} /></button>)}
              </nav>
              <div className="workflow-note"><Icon name="leaf" size={20} /><p>Different perspectives. Better questions.</p><span>Findings are hypotheses to explore with real people.</span></div>
            </div>
            <div className="workspace-content">
            <div className={`page-heading ${tab === 'run' ? 'simulation-page-heading' : ''}`}><div className="page-heading-meta"><p className="eyebrow">{PAGES[tab].eyebrow}</p><span className="save-state" data-dirty={dirty}><Icon name={dirty ? 'clock' : 'check'} size={13} />{dirty ? 'Unsaved changes' : info?.project ? 'Saved locally' : 'New study'}</span></div><h1 tabIndex={-1}>{PAGES[tab].title}</h1><p>{PAGES[tab].intro}</p></div>
            <div role="region" id="panel-settings" aria-labelledby="tab-settings" hidden={tab !== 'settings'}>
              <OpenSettings.Provider value={null}>
                <Settings settings={draft.settings} onSettings={setSettings} save={save} list={providers} reloadProviders={refreshProviders} />
              </OpenSettings.Provider>
            </div>
            <div role="region" id="panel-runs" aria-label="Project run history" hidden={tab !== 'runs'}>
              {comparing
                ? <RunCompare key={`${comparing.base}/${comparing.run}`} {...comparing} onBack={() => setComparing(null)} />
                : <ProjectRunHistory runs={info?.runs ?? []} selected={runId} onSelect={(run) => showRun(run.run_id)} onCompare={(base, run) => setComparing({ base, run })} />}
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
                onSettings={() => openSettings(null)}
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
                  onStarted={started}
                />
              ) : <p className="text-sm text-stone-500">Saving your project and checking the run…</p>}
            </div>
            <div role="region" id="panel-run" aria-labelledby="tab-run" hidden={tab !== 'run'}>
              <Run active={!home && tab === 'run'} runId={runId} runs={info?.runs ?? []} onSetup={() => go('project')} onStarted={started} />
            </div>
            </div>
          </div>
        )}
        {unsaved && <Dialog title="Save your changes?" onCancel={() => { if (!savingChanges) void resolveUnsaved('cancel'); }}>
          <p className="text-sm text-stone-700">This project has unsaved changes. Save them before continuing, or discard them.</p>
          {saveProblem && <Note tone="error">{saveProblem}</Note>}
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void resolveUnsaved('save')} disabled={savingChanges} variant="primary">Save and continue</Button>
            <Button onClick={() => void resolveUnsaved('discard')} disabled={savingChanges}>Discard changes</Button>
            <Button onClick={() => void resolveUnsaved('cancel')} disabled={savingChanges}>Cancel</Button>
          </div>
        </Dialog>}
      </main>
      <SimulationDock onOpen={openSessionRun} projects={catalog?.projects ?? []} />
    </div>
    </OpenSettings.Provider>
  );
}
