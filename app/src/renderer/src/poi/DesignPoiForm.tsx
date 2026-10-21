import { useRef, useState } from 'react';
import type { DesignPoi } from '@gnomi/simulation/types.ts';
import { call, errorText } from '../engine.ts';
import { Button, Field, inputClass, Note, Screenshot } from '../ui.tsx';
import { FRAME_TYPES } from './design.ts';
import { Icon } from '../Icon.tsx';
import { move, type PoiFormProps } from './index.ts';

/** The frames of a design in the order someone would see them: add images (pick or drop), name the steps, reorder, remove. */
export function DesignPoiForm({ draft, onChange }: PoiFormProps<DesignPoi>) {
  const picker = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const setFrames = (change: (frames: DesignPoi['frames']) => DesignPoi['frames']) => onChange((was) => ({ ...was, frames: change(was.frames) }));

  async function add(files: File[]) {
    if (adding || files.length === 0) return;
    setAdding(true);
    setProblem(null);
    const added: DesignPoi['frames'] = [];
    try {
      // One at a time, in the order chosen; a file that fails stops the rest, and the ones before it are kept.
      for (const file of files) added.push({ asset: (await call('import_asset', { path: window.gnomi.pathForFile(file) })).id, name: null });
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setAdding(false);
      if (added.length) setFrames((frames) => [...frames, ...added]);
      if (picker.current) picker.current.value = '';
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop zone for dragged image files; the file picker below is the keyboard path
    <div
      className="space-y-4"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void add([...e.dataTransfer.files]);
      }}
    >
      <p className="text-sm text-stone-600">
        Add screens in the order someone would see them. Personas tell you what they would do and what they expect to happen next.
      </p>
      {draft.frames.length > 0 && (
        <ol aria-label="Frames" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {draft.frames.map((frame, index) => {
            const label = `Frame ${index + 1}`;
            // Keyed by asset and its occurrence, so a thumbnail stays with its frame when frames move.
            const key = `${frame.asset}-${draft.frames.slice(0, index).filter((f) => f.asset === frame.asset).length}`;
            return (
              <li key={key} aria-label={label} className="space-y-2 rounded-lg border border-stone-200 p-3">
                <Screenshot path={`assets/${frame.asset}`} alt={frame.name?.trim() || label} />
                <Field label={`${label} step name`}>
                  <input
                    value={frame.name ?? ''}
                    onChange={(e) => setFrames((frames) => frames.map((f, i) => (i === index ? { ...f, name: e.target.value } : f)))}
                    placeholder="Optional"
                    className={inputClass}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button small variant="quiet" aria-label={`Move ${label} earlier`} disabled={index === 0} onClick={() => setFrames((frames) => move(frames, index, -1))}>Earlier</Button>
                  <Button small variant="quiet" aria-label={`Move ${label} later`} disabled={index === draft.frames.length - 1} onClick={() => setFrames((frames) => move(frames, index, 1))}>Later</Button>
                  <Button small variant="quiet" aria-label={`Remove ${label}`} onClick={() => setFrames((frames) => frames.filter((_, i) => i !== index))}>Remove</Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <input ref={picker} type="file" accept={FRAME_TYPES} multiple hidden aria-label="Frame images" onChange={(e) => void add([...(e.target.files ?? [])])} />
      <button type="button" className="poi-upload" disabled={adding} aria-busy={adding || undefined} onClick={() => picker.current?.click()}>
        <Icon name="image" size={24} /><strong>{adding ? 'Adding your screens…' : draft.frames.length ? 'Add more screens' : 'Add your first screens'}</strong><small>Drop images here, or click to browse</small><small>PNG, JPEG, or WebP · Multiple files welcome</small>
      </button>
      {problem && <Note tone="error">{problem}</Note>}
    </div>
  );
}
