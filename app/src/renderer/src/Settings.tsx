import { useEffect, useState } from 'react';
import { call } from './engine.ts';
import { Card, Field, inputClass, Note, primaryButton, secondaryButton, useAction } from './ui.tsx';

export function Settings() {
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const { busy, outcome, run } = useAction();

  useEffect(() => {
    void window.gnomi.hasKey().then(setHasKey);
  }, []);

  // Returns whether the key will be remembered; the pasted text is dropped as soon as main has it.
  async function save() {
    const { remembered } = await window.gnomi.saveKey(key);
    setKey('');
    setHasKey(true);
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
      const result = await call('test_key', {});
      return result.ok ? { ok: true, text: 'The key works.' } : { ok: false, text: `The key did not work: ${result.error ?? 'it was rejected'}` };
    });

  const onRemove = () =>
    run(async () => {
      await window.gnomi.clearKey();
      setHasKey(false);
      return { ok: true, text: 'Key removed.' };
    });

  return (
    <Card title="Anthropic API key">
      <p className="mb-4 text-sm text-stone-600">
        Gnomi uses your key to run the persona. It is stored encrypted by your operating system and is only ever sent to Anthropic.
      </p>
      <div className="space-y-4">
        <Field label="API key" hint={hasKey ? 'A key is saved. Paste a new one to replace it.' : 'No key saved yet.'}>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-..."
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onSave} disabled={busy || !key.trim()} className={primaryButton}>
            Save key
          </button>
          <button type="button" onClick={onTest} disabled={busy || (!key.trim() && !hasKey)} className={secondaryButton}>
            Test key
          </button>
          <button type="button" onClick={onRemove} disabled={busy || !hasKey} className={secondaryButton}>
            Remove saved key
          </button>
        </div>
        {busy && <p className="text-sm text-stone-500">Working...</p>}
        {outcome && <Note tone={outcome.ok ? 'ok' : 'error'}>{outcome.text}</Note>}
      </div>
    </Card>
  );
}
