import { useState } from 'react';
import type { FormEvent } from 'react';
import { MAX_ROUNDS, PROVIDER_DEFAULTS } from '@gnomi/engine/settings.ts';
import type { LlmRole, ModelChoice, ProjectConfig, ProviderId, RunSettings } from '@gnomi/engine/types.ts';
import { configuredProviders, PROVIDER_LABELS, routeOptions, routeProblem } from '../../providers.ts';
import type { KeyTest, ProviderList } from '../../providers.ts';
import { problemFor, ROLES } from './form.ts';
import { ActionBar, Button, Card, Check, Field, inputClass, Note, NumberInput, useAction, when } from './ui.tsx';
import type { Outcome } from './ui.tsx';
import { Icon } from './Icon.tsx';

// What to know before sending product data to a provider (tech.md §10.2), shown when adding it and on its row.
const PROVIDER_NOTES: Partial<Record<ProviderId, string>> = {
  deepseek: 'Its servers are in China. It reads text only, so it never sees screenshots, and it has no strict answer format: Gnomi checks every answer and asks once more when one does not fit.',
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
function ProviderRow(props: { provider: ProviderId; detail: string; test: KeyTest | null; disabled: boolean; onTest(): Promise<string | null>; onRemove(): void }) {
  const { provider, detail, test, disabled, onTest, onRemove } = props;
  const testing = useAction();
  const label = PROVIDER_LABELS[provider];
  const note = PROVIDER_NOTES[provider];
  return (
    <li className="space-y-2 border-t border-stone-200 py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-medium text-stone-900">{label}</p>
          <p className="truncate font-mono text-xs text-stone-600">{detail}</p>
        </div>
        <div className="w-44">{testing.busy ? <p className="text-xs text-stone-500">Testing...</p> : <TestResult test={test} />}</div>
        <div className="flex gap-2">
          <Button
            onClick={() => testing.run(async () => { const problem = await onTest(); return problem ? { ok: false, text: problem } : null; })}
            disabled={disabled || testing.busy}
          >
            Test<span className="sr-only"> {label}</span>
          </Button>
          <Button onClick={onRemove} disabled={disabled || testing.busy}>
            Remove<span className="sr-only"> {label}</span>
          </Button>
        </div>
      </div>
      {test && !test.ok && test.error && <p className="text-xs text-red-800">{test.error}</p>}
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
    <form onSubmit={submit} className="space-y-2 rounded-lg bg-stone-50 p-4">
      <p className="text-sm font-medium text-stone-800">Add a provider</p>
      <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-end">
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

export function Settings(props: { settings: RunSettings; onSettings(next: RunSettings): void; save(settings?: RunSettings): Promise<ProjectConfig | string>; list: ProviderList | null; reloadProviders(): Promise<void> }) {
  const { settings, onSettings, save, list, reloadProviders } = props;
  const changing = useAction(); // adding and removing: the row it concerns may be gone when the outcome shows
  const saving = useAction();
  const set = <K extends keyof RunSettings>(key: K, value: RunSettings[K]) => onSettings({ ...settings, [key]: value });

  const localUrl = settings.local_base_url?.trim() || null;
  const configured = list && configuredProviders(list.keys, localUrl);
  const addable = (Object.keys(PROVIDER_LABELS) as ProviderId[]).filter((id) => configured && !configured.includes(id));

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

  async function test(provider: ProviderId): Promise<string | null> {
    if (provider === 'openai_compatible') {
      const saved = await save(); // the engine tests the address saved with the project
      if (typeof saved === 'string') return problemFor(saved, 'settings');
    }
    await window.gnomi.testKey(provider);
    await reloadProviders();
    return null;
  }

  const onSave = () =>
    saving.run(async () => {
      const saved = await save();
      return typeof saved === 'string' ? { ok: false, text: problemFor(saved, 'settings') } : { ok: true, text: 'Settings saved with the project.' };
    });

  return (
    <div className="space-y-5">
      <Card title="Providers">
        <p className="mb-4 text-sm text-stone-600">
          Gnomi uses your own keys. Each is stored encrypted by your operating system and is only ever sent to its provider. Add the ones you want to use.
        </p>
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
          list && <p className="mb-4 text-sm text-stone-500">No provider yet. Add one to run personas.</p>
        )}
        {addable.length > 0 && <AddProvider choices={addable} disabled={changing.busy} onAdd={add} />}
        {changing.busy && <p className="mt-3 text-sm text-stone-500">Working...</p>}
        {changing.outcome && <div className="mt-3"><Note tone={changing.outcome.ok ? 'ok' : 'error'}>{changing.outcome.text}</Note></div>}
      </Card>

      <details className="disclosure"><summary><Icon name="settings" />Model choices<span>Choose the AI model for each task</span></summary><div className="disclosure-body"><Card title="This project's models">
        <p className="mb-4 text-sm text-stone-600">With one connected provider, Gnomi assigns it to every task automatically. You can choose a provider and model for each task below. Changing the provider selects its recommended model.</p>
        <div className="space-y-3">
          {ROLES.map((role) => {
            const choice = settings.routing[role];
            const text = ROLE_TEXT[role];
            const warning = configured && routeProblem(choice.provider, configured);
            const blind = role === 'navigator' && choice.provider === 'deepseek' && settings.screenshots;
            return (
              <div key={role} className="grid gap-2 sm:grid-cols-[9rem_10rem_minmax(0,1fr)] sm:items-start">
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
                  {blind && <p className="mt-1 text-xs text-stone-500">DeepSeek reads text only, so the navigator will not see the screenshots.</p>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      </div></details>

      <Card title="Persona generation">
        <Field label="Writer concurrency (1-32)" hint="Profiles written at once. Lower this if your provider throttles requests or your local model slows down.">
          <NumberInput label="Writer concurrency (1-32)" value={settings.persona_concurrency ?? 32} onChange={(v) => set('persona_concurrency', v)} min={1} max={32} />
        </Field>
        <p className="mt-3 text-xs text-stone-500">Completed drafts are saved automatically. Retrying an interrupted build resumes the work already completed.</p>
      </Card>

      <Card title="Budgets">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
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

      <ActionBar>
        {saving.outcome && <Note tone={saving.outcome.ok ? 'ok' : 'error'}>{saving.outcome.text}</Note>}
        {saving.busy && <p className="text-sm text-stone-500">Working...</p>}
        <Button onClick={onSave} disabled={saving.busy} variant="primary">
          Save settings
        </Button>
      </ActionBar>
    </div>
  );
}
