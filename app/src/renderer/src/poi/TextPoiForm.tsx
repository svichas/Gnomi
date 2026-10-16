import { useEffect, useRef, useState } from 'react';
import type { TextPoi } from '@gnomi/engine/types.ts';
import { call, errorText } from '../engine.ts';
import { Button, Field, inputClass, Note } from '../ui.tsx';
import type { PoiFormProps } from './index.ts';

const MAX_BYTES = 2 * 1024 * 1024; // the engine's limit for a text asset (engine/src/assets.ts), checked here before a big file is read

/** Copy for personas to read: pasted, or a .md or .txt file, stored in the project's assets; the saved text shows as they will read it. */
export function TextPoiForm({ draft, onChange }: PoiFormProps<TextPoi>) {
  const [pasted, setPasted] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPreview(null);
    if (!draft.asset) return;
    let current = true;
    call('get_blob', { path: `assets/${draft.asset}` }).then(
      ({ base64 }) => current && setPreview(new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))),
      (err) => current && setError(errorText(err)),
    );
    return () => {
      current = false;
    };
  }, [draft.asset]);

  const save = async (params: { text: string; name?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await call('import_asset', params);
      // A file names a POI that has no name yet.
      onChange((was) => ({ ...was, asset: id, name: was.name || (params.name?.replace(/\.(md|txt)$/i, '') ?? '') }));
      setPasted('');
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (chosen: File | undefined) => {
    if (file.current) file.current.value = ''; // choosing the same file again still counts
    if (!chosen) return;
    if (chosen.size > MAX_BYTES) return setError(`"${chosen.name}" is larger than 2 MB.`);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(await chosen.arrayBuffer());
    } catch {
      return setError(`"${chosen.name}" is not UTF-8 text.`);
    }
    if (!content.trim()) return setError(`"${chosen.name}" is empty.`);
    await save({ text: content, name: chosen.name });
  };

  if (draft.asset && !editing) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-stone-700">The text personas read</p>
        {preview === null ? (
          error ? <Note tone="error">{error}</Note> : <p className="text-sm text-stone-500">Loading the text...</p>
        ) : (
          <pre aria-label="Text preview" tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-stone-200 bg-stone-50 p-3 font-sans text-sm text-stone-800">
            {preview}
          </pre>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {preview !== null && <span className="text-xs text-stone-500">{preview.length.toLocaleString()} characters</span>}
          <Button small onClick={() => { setPasted(preview ?? ''); setError(null); setEditing(true); }}>Replace the text</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field label="Paste the text" hint="Markdown or plain text, as a reader would see it: a pricing page, an email, onboarding copy.">
        <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={8} className={inputClass} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button small variant="primary" loading={busy} disabled={!pasted.trim()} onClick={() => void save({ text: pasted })}>
          Use this text
        </Button>
        <Button small disabled={busy} onClick={() => file.current?.click()}>
          Choose a .md or .txt file
        </Button>
        <input ref={file} type="file" accept=".md,.txt,text/markdown,text/plain" aria-label="Text file" className="sr-only" tabIndex={-1} onChange={(e) => void choose(e.target.files?.[0])} />
        {editing && (
          <Button small variant="quiet" disabled={busy} onClick={() => { setEditing(false); setError(null); }}>
            Keep the current text
          </Button>
        )}
      </div>
      {error && <Note tone="error">{error}</Note>}
    </div>
  );
}
