import { useCallback, useEffect, useState } from 'react';
import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import { call, connected, errorText, stopped } from './engine.ts';
import { Project } from './Project.tsx';
import { Run } from './Run.tsx';
import { Settings } from './Settings.tsx';
import { Note } from './ui.tsx';

const TABS = [
  { id: 'settings', label: 'Settings' },
  { id: 'project', label: 'Project' },
  { id: 'run', label: 'Run' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export function App() {
  const [tab, setTab] = useState<Tab>('project');
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const refresh = useCallback(async () => setInfo(await call('get_project', {})), []);

  useEffect(() => {
    void stopped.then(setProblem);
    void (async () => {
      const { startupError } = await connected;
      if (startupError) setProblem(`Gnomi could not start properly: ${startupError}`);
      try {
        const loaded = await call('get_project', {});
        setInfo(loaded);
        const running = loaded.runs.find((run) => run.status === 'running'); // the page was reloaded mid-run
        if (running) {
          setRunId(running.run_id);
          setTab('run');
        } else if (!(await window.gnomi.hasKey())) {
          setTab('settings');
        }
      } catch (err) {
        setProblem((was) => was ?? `Gnomi could not start properly: ${errorText(err)}`);
      }
      setReady(true);
    })();
  }, []);

  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-8 px-6">
          <h1 className="py-3 text-lg font-semibold tracking-tight text-stone-900">Gnomi</h1>
          <div role="tablist" aria-label="Screens" className="flex gap-1">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`panel-${id}`}
                onClick={() => setTab(id)}
                className={`border-b-2 px-4 py-3.5 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600 ${
                  tab === id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-stone-600 hover:text-stone-900'
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
        {!ready ? (
          <p className="text-sm text-stone-500">Starting Gnomi...</p>
        ) : (
          // All three stay mounted so a half-typed form or a run in progress survives a tab switch.
          <>
            <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" hidden={tab !== 'settings'} className="max-w-2xl">
              <Settings />
            </div>
            <div role="tabpanel" id="panel-project" aria-labelledby="tab-project" hidden={tab !== 'project'} className="max-w-2xl">
              <Project
                info={info}
                onSaved={refresh}
                onStarted={(id) => {
                  setRunId(id);
                  setTab('run');
                  void refresh();
                }}
              />
            </div>
            <div role="tabpanel" id="panel-run" aria-labelledby="tab-run" hidden={tab !== 'run'}>
              <Run runId={runId} runs={info?.runs ?? []} onSelect={setRunId} onRunEnded={refresh} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
