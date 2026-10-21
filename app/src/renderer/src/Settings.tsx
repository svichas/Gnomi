import { useState } from 'react';
import type { FormEvent } from 'react';
import { MAX_ROUNDS, PROVIDER_DEFAULTS, readsImages } from '@gnomi/simulation/settings.ts';
import type { LlmRole, ModelChoice, ProjectConfig, ProviderId, RunSettings } from '@gnomi/simulation/types.ts';
import { configuredProviders, egressList, PROVIDER_LABELS, routeOptions, routeProblem } from '../../providers.ts';
import type { KeyTest, ProviderList } from '../../providers.ts';
import { problemFor, ROLES } from './form.ts';
import { ActionBar, Button, Card, Check, Field, inputClass, Note, NumberInput, useAction, when } from './ui.tsx';
import type { Outcome } from './ui.tsx';
import { Icon } from './Icon.tsx';
import './audience-settings.css';

// What to know before sending product data to a provider (tech.md §10.2), shown when adding it and on its row.
const PROVIDER_NOTES: Partial<Record<ProviderId | 'figma', string>> = {
  deepseek: 'Its servers are in China. Its Flash model sees screenshots, V4 Pro reads text only, and it has no strict answer format: Gnomi checks every answer and asks once more when one does not fit.',
  openai_compatible: 'Any server that speaks the OpenAI API, such as Ollama or LM Studio. Saved with this project.',
};

export const ROLE_TEXT: Record<LlmRole, { label: string; hint: string; used: boolean }> = {
  navigator: { label: 'Navigator', hint: 'Drives the browser, step by step.', used: true },
  persona_writer: { label: 'Persona writer', hint: 'Proposes segments and writes the personas.', used: true },
  socialiser: { label: 'Socialiser', hint: 'Posts and replies in the swarm.', used: true },
  judge: { label: 'Judge', hint: 'Groups and rates the findings.', used: false },
  author: { label: 'Author', hint: 'Writes the report text.', used: false },
};

function TestResult({ test }: { test: KeyTest | null }) {
  if (!test) return <p className="text-xs text-stone-500">Not tested yet</p>;
  return (
    <div className="text-xs">
      <p className={`font-medium ${test.ok ? 'text-green-800' : 'text-red-800'}`}>
        <span aria-hidden="true">{test.ok ? '✓ ' : '✕ '}</span>
        {test.ok ? 'Works' : 'Did not work'}
      </p>
      <p className="text-stone-500">Tested {when(test.at)}</p>
    </div>
  );
}

/** One configured provider: its masked key or address, its last test, and Test and Remove. */
function ProviderRow(props: { provider: ProviderId | 'figma'; detail: string; test: KeyTest | null; disabled: boolean; onTest(): Promise<string | null>; onRemove(): void }) {
  const { provider, detail, test, disabled, onTest, onRemove } = props;
  const testing = useAction();
  const label = provider === 'figma' ? 'Figma' : PROVIDER_LABELS[provider];
  const note = PROVIDER_NOTES[provider];
  return (
    <li className="provider-row">
      <div className="provider-row-main">
        <div className="provider-identity">
          <p className="text-sm font-medium text-stone-900">{label}</p>
          <p className="truncate font-mono text-xs text-stone-600">{detail}</p>
        </div>
        <div className="provider-test-result" role="status">{testing.busy ? <p className="text-xs text-stone-500">Testing...</p> : <TestResult test={test} />}</div>
        <div className="provider-row-actions">
          <Button small
            onClick={() => testing.run(async () => { const problem = await onTest(); return problem ? { ok: false, text: problem } : null; })}
            disabled={disabled || testing.busy}
          >
            Test<span className="sr-only"> {label}</span>
          </Button>
          <Button small variant="quiet" onClick={onRemove} disabled={disabled || testing.busy}>
            Remove<span className="sr-only"> {label}</span>
          </Button>
        </div>
      </div>
      {test && !test.ok && test.error && <Note tone="error">{test.error}</Note>}
      {note && <p className="text-xs text-stone-500">{note}</p>}
      {testing.outcome && <Note tone="error">{testing.outcome.text}</Note>}
    </li>
  );
}

function AddProvider({ choices, disabled, onAdd }: { choices: ProviderId[]; disabled: boolean; onAdd(provider: ProviderId, value: string): Promise<boolean> }) {
  const [picked, setPicked] = useState<ProviderId>(choices[0]);
  const [value, setValue] = useState('');
  const provider = choices.includes(picked) ? picked : choices[0]; // the one just added leaves the list
  const local = provider === 'openai_compatible';
  const note = PROVIDER_NOTES[provider];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onAdd(provider, value)) setValue(''); // a pasted key is dropped as soon as main has it
  }

  return (
    <form onSubmit={submit} className="settings-add-provider">
      <p className="text-sm font-medium text-stone-800">Add a provider</p>
      <div className="settings-add-provider-controls">
        <Field label="Provider">
          <select value={provider} onChange={(e) => { setPicked(e.target.value as ProviderId); setValue(''); }} className={inputClass}>
            {choices.map((id) => (
              <option key={id} value={id}>
                {PROVIDER_LABELS[id]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={local ? 'Base URL' : 'API key'}>
          <input
            type={local ? 'url' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={local ? 'http://localhost:11434/v1' : 'Paste the key'}
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
        </Field>
        <Button type="submit" disabled={disabled || !value.trim()} variant="primary">
          Add provider
        </Button>
      </div>
      {note && <p className="text-xs text-stone-500">{note}</p>}
    </form>
  );
}

/** The Figma token field. Like a provider's key it is dropped from the page as soon as main has it. */
function AddFigmaToken({ disabled, onAdd }: { disabled: boolean; onAdd(token: string): Promise<boolean> }) {
  const [value, setValue] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onAdd(value)) setValue('');
  }
  return (
    <form onSubmit={submit} className="settings-figma-form">
      <Field label="Figma access token">
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste the token" autoComplete="off" spellCheck={false} className={inputClass} />
      </Field>
      <Button type="submit" disabled={disabled || !value.trim()} variant="primary">
        Save token
      </Button>
    </form>
  );
}

function ModelSelect({ role, choice, onChange }: { role: LlmRole; choice: ModelChoice; onChange(model: string): void }) {
  const models = [...new Set(Object.values(PROVIDER_DEFAULTS[choice.provider]).map((route) => route.model))];
  const [custom, setCustom] = useState(!models.includes(choice.model));
  const label = ROLE_TEXT[role].label;
  const recommended = PROVIDER_DEFAULTS[choice.provider][role].model;
  return (
    <div className="space-y-2">
      <select
        aria-label={`${label} model`}
        value={custom ? '__custom__' : choice.model}
        onChange={(event) => {
          const value = event.target.value;
          setCustom(value === '__custom__');
          if (value !== '__custom__') onChange(value);
        }}
        className={inputClass}
      >
        {models.map((model) => <option key={model} value={model}>{model}{model === recommended ? ' (recommended)' : ''}</option>)}
        <option value="__custom__">Custom model…</option>
      </select>
      {custom && <Field label={`${label} custom model`}><input value={choice.model} onChange={(event) => onChange(event.target.value)} spellCheck={false} className={inputClass} /></Field>}
    </div>
  );
}

export function Settings(props: { settings: RunSettings; onSettings(next: RunSettings): void; save(settings?: RunSettings): Promise<ProjectConfig | string>; list: ProviderList | null; reloadProviders(): Promise<void>; workspace?: boolean }) {
  const { settings, onSettings, save, list, reloadProviders, workspace } = props;
  const changing = useAction(); // adding and removing: the row it concerns may be gone when the outcome shows
  const saving = useAction();
  const set = <K extends keyof RunSettings>(key: K, value: RunSettings[K]) => onSettings({ ...settings, [key]: value });

  // The local endpoint is saved with a project, so the workspace's settings, with no project open, show only what every project shares.
  const localUrl = workspace ? null : settings.local_base_url?.trim() || null;
  const configured = list && configuredProviders(list.keys, localUrl);
  const addable = (Object.keys(PROVIDER_LABELS) as ProviderId[]).filter((id) => configured && !configured.includes(id) && !(workspace && id === 'openai_compatible'));

  /** Saves the project with the local endpoint changed; the engine only ever reaches the address saved with it. */
  async function saveLocal(local_base_url: string | null): Promise<Outcome | null> {
    const next = { ...settings, local_base_url };
    onSettings(next);
    const saved = await save(next);
    return typeof saved === 'string' ? { ok: false, text: problemFor(saved, 'settings') } : null;
  }

  /** Whether the provider was added, so the form can drop what was typed. */
  async function add(provider: ProviderId, value: string): Promise<boolean> {
    let added = false;
    await changing.run(async () => {
      if (provider === 'openai_compatible') {
        added = true; // in the draft even when the project cannot be saved yet
        return saveLocal(value.trim());
      }
      const entry = await window.gnomi.saveKey(provider, value);
      added = true;
      await reloadProviders();
      return entry.remembered ? null : { ok: true, text: 'Key accepted for this session only. This computer has no secure place to keep it, so it is forgotten when you quit.' };
    });
    return added;
  }

  const remove = (provider: ProviderId) =>
    changing.run(async () => {
      if (provider === 'openai_compatible') return saveLocal(null);
      await window.gnomi.clearKey(provider);
      await reloadProviders();
      return null;
    });

  async function addFigma(token: string): Promise<boolean> {
    let added = false;
    await changing.run(async () => {
      const entry = await window.gnomi.saveFigmaToken(token);
      added = true;
      await reloadProviders();
      return entry.remembered ? null : { ok: true, text: 'Token accepted for this session only. This computer has no secure place to keep it, so it is forgotten when you quit.' };
    });
    return added;
  }

  const removeFigma = () =>
    changing.run(async () => {
      await window.gnomi.clearFigmaToken();
      await reloadProviders();
      return null;
    });

  async function testFigma(): Promise<string | null> {
    await window.gnomi.testFigmaToken();
    await reloadProviders();
    return null;
  }

  async function test(provider: ProviderId): Promise<string | null> {
    if (provider === 'openai_compatible') {
      const saved = await save(); // the engine tests the address saved with the project
      if (typeof saved === 'string') return problemFor(saved, 'settings');
    }
    await window.gnomi.testKey(provider);
    await reloadProviders();
    return null;
  }

  const connectedCount = configured?.length ?? 0;

  const onSave = () =>
    saving.run(async () => {
      const saved = await save();
      return typeof saved === 'string' ? { ok: false, text: problemFor(saved, 'settings') } : { ok: true, text: 'Settings saved with the project.' };
    });

  return (
    <div className="settings-workspace">
      <div className="settings-overview" aria-label="Current settings">
        <div><Icon name="globe" /><span><strong>{list ? `${connectedCount} ${connectedCount === 1 ? 'provider' : 'providers'} connected` : 'Loading connections…'}</strong><small>{list && connectedCount === 0 ? 'Add a provider to generate personas' : 'AI access for your projects'}</small></span></div>
        {!workspace && <><div><Icon name="clock" /><span><strong>${settings.cost_budget_usd} · {settings.wall_clock_budget_min} min</strong><small>Limits for each simulation</small></span></div>
        <div><Icon name="people" /><span><strong>{settings.concurrency} at a time</strong><small>Personas exploring in parallel</small></span></div></>}
      </div>
      <div className={workspace ? 'settings-layout settings-layout-single' : 'settings-layout'}>
      <div className="settings-connections">
      <div className="settings-group-heading"><p>Connections</p><span>Manage AI and design access</span></div>
      <Card id="settings-providers" title="Providers">
        <p className="mb-4 text-sm text-stone-600">
          Connect an AI provider to create personas and run simulations. Keys are stored using your operating system’s secure storage and sent only to their provider.
        </p>
        {!list && <div className="settings-loading" role="status" aria-busy="true"><span /><span /><p>Loading your connections…</p></div>}
        {list && (list.keys.length || localUrl) ? (
          <ul className="mb-4">
            {list.keys.map(({ provider, masked, remembered, test: last }) => (
              <ProviderRow
                key={provider}
                provider={provider}
                detail={remembered ? masked : `${masked} · this session only`}
                test={last}
                disabled={changing.busy}
                onTest={() => test(provider)}
                onRemove={() => remove(provider)}
              />
            ))}
            {localUrl && (
              <ProviderRow
                provider="openai_compatible"
                detail={localUrl}
                test={list.local_test?.target === localUrl ? list.local_test : null}
                disabled={changing.busy}
                onTest={() => test('openai_compatible')}
                onRemove={() => remove('openai_compatible')}
              />
            )}
          </ul>
        ) : (
          list && <p className="settings-empty"><Icon name="plus" size={18} /><span>No provider yet. Add one below to get started.</span></p>
        )}
        {addable.length > 0 && <AddProvider choices={addable} disabled={changing.busy} onAdd={add} />}
        {changing.busy && <p className="mt-3 text-sm text-stone-500">Working...</p>}
        {changing.outcome && <div className="mt-3"><Note tone={changing.outcome.ok ? 'ok' : 'error'}>{changing.outcome.text}</Note></div>}
      </Card>

      <Card id="settings-figma" title="Figma">
        <p className="mb-4 text-sm text-stone-600">Optional. Connect Figma to import frames as designs for your audience to explore.</p>
        <details className="settings-help"><summary>How to create a Figma token</summary><p>In Figma, open Settings → Security and generate a personal access token with the file_content:read scope. Use an account with a Dev or Full seat; View and Collab seats have limited imports. Tokens expire, so check the expiry when creating one.</p></details>
        {list?.figma ? (
          <ul>
            <ProviderRow
              provider="figma"
              detail={list.figma.remembered ? list.figma.masked : `${list.figma.masked} · this session only`}
              test={list.figma.test}
              disabled={changing.busy}
              onTest={testFigma}
              onRemove={removeFigma}
            />
          </ul>
        ) : (
          list && <AddFigmaToken disabled={changing.busy} onAdd={addFigma} />
        )}
        <p className="mt-3 text-xs text-stone-500">Test checks that Figma accepts the token; whether it can open a particular file is checked when you import it. The token stays encrypted by your operating system, outside every project.</p>
      </Card>

      <Card title="Where Gnomi connects">
        <p className="mb-3 text-sm text-stone-600">Besides the sites you test, Gnomi sends data only to these addresses. There is no telemetry.</p>
        {list && (egressList(list, localUrl).length ? (
          <ul className="settings-egress">
            {egressList(list, localUrl).map(({ host, why }) => (
              <li key={host}><span className="font-mono text-stone-900">{host}</span> <span className="text-stone-500">· {why}</span></li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-stone-500">Nowhere yet: no provider is connected.</p>
        ))}
      </Card>

      </div>
      {!workspace && <div className="settings-run-options">
      <div className="settings-group-heading"><p>Run settings</p><span>Saved with this project</span></div>
      <Card title="Budgets">
        <div className="space-y-4">
          <div className="settings-budget-fields">
            <Field label="Cost budget (USD)" hint="Stops new work at the recorded cost limit and cancels outstanding model requests.">
              <NumberInput label="Cost budget (USD)" value={settings.cost_budget_usd} onChange={(v) => set('cost_budget_usd', v)} min={0} step={0.5} />
            </Field>
            <Field label="Time budget (minutes)" hint="The run stops after this long.">
              <NumberInput label="Time budget (minutes)" value={settings.wall_clock_budget_min} onChange={(v) => set('wall_clock_budget_min', v)} min={1} step={5} />
            </Field>
            <Field label="Concurrency (1-32)" hint="Personas browsing at once, each in its own browser.">
              <NumberInput label="Concurrency (1-32)" value={settings.concurrency} onChange={(v) => set('concurrency', v)} min={1} max={32} />
            </Field>
          </div>
          <p className="text-xs text-stone-500">Browser actions already started can finish. Providers may still charge for requests in flight, so billed cost can exceed this limit. Persona generation is charged separately.</p>
          <Check checked={settings.screenshots} onChange={(on) => set('screenshots', on)}>
            Show each page to the model as a screenshot
          </Check>
          <p className="pl-6 text-xs text-stone-500">Screenshots are always kept as evidence. Showing them to the model lets it see the page, and costs more.</p>
        </div>
      </Card>

      <Card title="Persona generation">
        <Field label="Writer concurrency (1-32)" hint="Profiles written at once. Lower this if your provider throttles requests or your local model slows down.">
          <NumberInput label="Writer concurrency (1-32)" value={settings.persona_concurrency ?? 32} onChange={(v) => set('persona_concurrency', v)} min={1} max={32} />
        </Field>
        <p className="mt-3 text-xs text-stone-500">Completed drafts are saved automatically. Retrying an interrupted build resumes the work already completed.</p>
      </Card>

      <Card title="Social rounds">
        <div className="space-y-4">
          <Check checked={settings.social ?? false} onChange={(on) => set('social', on)}>
            Let personas read and post in a shared feed between stretches of use
          </Check>
          <p className="pl-6 text-xs text-stone-500">
            Each round, every persona uses the product for part of its steps, then reads posts from the people it follows and may post, reply or react. Most stay silent. Needs an audience: the built-in persona runs alone.
          </p>
          {settings.social && (
            <Field label="Rounds (1-10)" hint="More rounds give opinions more chances to spread, with one socialiser call per persona each round.">
              <NumberInput label="Rounds (1-10)" value={settings.rounds ?? 5} onChange={(v) => set('rounds', v)} min={1} max={MAX_ROUNDS} />
            </Field>
          )}
        </div>
      </Card>

      </div>}
      </div>
      {!workspace && <details className="disclosure settings-models"><summary><Icon name="settings" />Model choices<span>Choose the AI model for each task</span></summary><div className="disclosure-body"><Card title="This project's models">
        <p className="mb-4 text-sm text-stone-600">With one connected provider, Gnomi assigns it to every task automatically. You can choose a provider and model for each task below. Changing the provider selects its recommended model.</p>
        <div className="space-y-3">
          {ROLES.map((role) => {
            const choice = settings.routing[role];
            const text = ROLE_TEXT[role];
            const warning = configured && routeProblem(choice.provider, configured);
            const blind = role === 'navigator' && !readsImages(choice) && settings.screenshots;
            return (
              <div key={role} className="settings-model-row">
                <div>
                  <p className="text-sm font-medium text-stone-800">{text.label}</p>
                  <p className="text-xs text-stone-500">{text.used ? text.hint : `${text.hint} Used from a later version.`}</p>
                </div>
                <select
                  aria-label={`${text.label} provider`}
                  value={choice.provider}
                  onChange={(e) => set('routing', { ...settings.routing, [role]: PROVIDER_DEFAULTS[e.target.value as ProviderId][role] })}
                  className={inputClass}
                >
                  {(configured ? routeOptions(configured, choice.provider) : [choice.provider]).map((id) => (
                    <option key={id} value={id}>
                      {PROVIDER_LABELS[id]}
                    </option>
                  ))}
                </select>
                <div>
                  <ModelSelect key={`${role}-${choice.provider}`} role={role} choice={choice} onChange={(model) => set('routing', { ...settings.routing, [role]: { ...choice, model } })} />
                  {warning && <p className="mt-1 text-xs text-amber-800">{warning}</p>}
                  {blind && <p className="mt-1 text-xs text-stone-500">This model reads text only, so the navigator will not see the screenshots.</p>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      </div></details>}

      <p className="text-xs text-stone-500">Gnomi is free software under the GNU AGPL v3.0. Source: github.com/svichas/Gnomi</p>

      {!workspace && <ActionBar notice={saving.outcome && !saving.outcome.ok && <Note tone="error">{saving.outcome.text}</Note>}>
        <p className="settings-save-hint">Provider keys save immediately. Save to apply this project’s run settings.</p>
        {saving.outcome?.ok && <Note tone="ok">{saving.outcome.text}</Note>}
        {saving.busy && <p className="text-sm text-stone-500">Working...</p>}
        <Button onClick={onSave} disabled={saving.busy} loading={saving.busy} variant="primary">
          Save settings
        </Button>
      </ActionBar>}
    </div>
  );
}
