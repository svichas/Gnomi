import { useEffect, useState } from 'react';
import { PROVIDER_DEFAULTS } from '@gnomi/engine/settings.ts';
import type { LlmRole, ProjectConfig, ProviderId, RunSettings } from '@gnomi/engine/types.ts';
import { call } from './engine.ts';
import { problemFor, ROLES } from './form.ts';
import { Card, Check, Field, inputClass, Note, NumberInput, primaryButton, secondaryButton, useAction } from './ui.tsx';

const KEYED: { id: KeyedProvider; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google' },
];

const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openai_compatible: 'Local endpoint',
};

const ROLE_TEXT: Record<LlmRole, { label: string; hint: string; used: boolean }> = {
  navigator: { label: 'Navigator', hint: 'Drives the browser, step by step.', used: true },
  persona_writer: { label: 'Persona writer', hint: 'Proposes segments and writes the personas.', used: true },
  socialiser: { label: 'Socialiser', hint: 'Posts and replies in the swarm.', used: false },
  judge: { label: 'Judge', hint: 'Groups and rates the findings.', used: false },
  author: { label: 'Author', hint: 'Writes the report text.', used: false },
};

function ProviderKey({ provider, label, onChange }: { provider: KeyedProvider; label: string; onChange(has: boolean): void }) {
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const { busy, outcome, run } = useAction();

  useEffect(() => {
    void window.gnomi.hasKey(provider).then((has) => {
      setHasKey(has);
      onChange(has);
    });
  }, []);

  const keep = (has: boolean) => {
    setHasKey(has);
    onChange(has);
  };

  // Returns whether the key will be remembered; the pasted text is dropped as soon as main has it.
  async function save() {
    const { remembered } = await window.gnomi.saveKey(provider, key);
    setKey('');
    keep(true);
    return remembered;
  }

  const onSave = () =>
    run(async () => {
      const remembered = await save();
      return {
        ok: true,
        text: remembered
          ? 'Key saved.'
          : 'Key accepted for this session only. This computer has no secure place to keep it, so it is forgotten when you quit.',
      };
    });

  const onTest = () =>
    run(async () => {
      if (key.trim()) await save(); // testing what was just pasted is what people expect
      const result = await call('test_key', { provider });
      return result.ok ? { ok: true, text: 'The key works.' } : { ok: false, text: `The key did not work: ${result.error ?? 'it was rejected'}` };
    });

  const onRemove = () =>
    run(async () => {
      await window.gnomi.clearKey(provider);
      keep(false);
      return { ok: true, text: 'Key removed.' };
    });

  return (
    <div className="space-y-3 rounded-lg border border-stone-200 p-4">
      <Field label={`${label} API key`} hint={hasKey ? 'A key is saved. Paste a new one to replace it.' : 'No key saved yet.'}>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Paste your key"
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onSave} disabled={busy || !key.trim()} className={primaryButton}>
          Save {label} key
        </button>
        <button type="button" onClick={onTest} disabled={busy || (!key.trim() && !hasKey)} className={secondaryButton}>
          Test {label} key
        </button>
        <button type="button" onClick={onRemove} disabled={busy || !hasKey} className={secondaryButton}>
          Remove {label} key
        </button>
        {busy && <p className="text-sm text-stone-500">Working...</p>}
      </div>
      {outcome && <Note tone={outcome.ok ? 'ok' : 'error'}>{outcome.text}</Note>}
    </div>
  );
}

export function Settings(props: { settings: RunSettings; onSettings(next: RunSettings): void; save(): Promise<ProjectConfig | string> }) {
  const { settings, onSettings, save } = props;
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const endpoint = useAction();
  const saving = useAction();
  const set = <K extends keyof RunSettings>(key: K, value: RunSettings[K]) => onSettings({ ...settings, [key]: value });

  const testEndpoint = () =>
    endpoint.run(async () => {
      const saved = await save(); // the engine tests the address saved with the project
      if (typeof saved === 'string') return { ok: false, text: problemFor(saved, 'settings') };
      const result = await call('test_key', { provider: 'openai_compatible' });
      return result.ok ? { ok: true, text: 'The endpoint answers.' } : { ok: false, text: `The endpoint did not answer: ${result.error ?? 'no reason given'}` };
    });

  const onSave = () =>
    saving.run(async () => {
      const saved = await save();
      return typeof saved === 'string' ? { ok: false, text: problemFor(saved, 'settings') } : { ok: true, text: 'Settings saved with the project.' };
    });

  function missing(provider: ProviderId): string | null {
    if (provider === 'openai_compatible') return settings.local_base_url?.trim() ? null : 'Give the local endpoint an address above.';
    return keys[provider] === false ? `No ${PROVIDER_LABELS[provider]} key is saved yet.` : null;
  }

  return (
    <div className="space-y-5">
      <Card title="Provider keys">
        <p className="mb-4 text-sm text-stone-600">
          Gnomi uses your own keys. Each is stored encrypted by your operating system and is only ever sent to its provider. Add the ones you want to use.
        </p>
        <div className="space-y-3">
          {KEYED.map(({ id, label }) => (
            <ProviderKey key={id} provider={id} label={label} onChange={(has) => setKeys((was) => ({ ...was, [id]: has }))} />
          ))}
        </div>
      </Card>

      <Card title="Local endpoint">
        <div className="space-y-3">
          <Field
            label="Base URL"
            hint="Any server that speaks the OpenAI API, such as Ollama or LM Studio, e.g. http://localhost:11434/v1. Leave empty if you do not use one."
          >
            <input
              value={settings.local_base_url ?? ''}
              onChange={(e) => set('local_base_url', e.target.value || null)}
              placeholder="http://localhost:11434/v1"
              spellCheck={false}
              className={inputClass}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={testEndpoint} disabled={endpoint.busy || !settings.local_base_url?.trim()} className={secondaryButton}>
              Test endpoint
            </button>
            <span className="text-xs text-stone-500">Testing saves the project first.</span>
            {endpoint.busy && <p className="text-sm text-stone-500">Working...</p>}
          </div>
          {endpoint.outcome && <Note tone={endpoint.outcome.ok ? 'ok' : 'error'}>{endpoint.outcome.text}</Note>}
        </div>
      </Card>

      <Card title="This project's models">
        <p className="mb-4 text-sm text-stone-600">Pick a provider and a model for each job. Changing the provider fills in its usual model.</p>
        <div className="space-y-3">
          {ROLES.map((role) => {
            const choice = settings.routing[role];
            const text = ROLE_TEXT[role];
            const warning = missing(choice.provider);
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
                  {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) => (
                    <option key={id} value={id}>
                      {PROVIDER_LABELS[id]}
                    </option>
                  ))}
                </select>
                <div>
                  <input
                    aria-label={`${text.label} model`}
                    value={choice.model}
                    onChange={(e) => set('routing', { ...settings.routing, [role]: { ...choice, model: e.target.value } })}
                    spellCheck={false}
                    className={inputClass}
                  />
                  {text.used && warning && <p className="mt-1 text-xs text-amber-800">{warning}</p>}
                </div>
              </div>
            );
          })}
        </div>
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

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onSave} disabled={saving.busy} className={primaryButton}>
            Save settings
          </button>
          {saving.busy && <p className="text-sm text-stone-500">Working...</p>}
        </div>
        {saving.outcome && <Note tone={saving.outcome.ok ? 'ok' : 'error'}>{saving.outcome.text}</Note>}
      </div>
    </div>
  );
}
