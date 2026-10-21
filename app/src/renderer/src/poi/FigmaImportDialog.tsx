import { useContext, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { FigmaFile, FigmaImport } from '@gnomi/engine/figma/frames.ts';
import type { DesignPoi } from '@gnomi/simulation/types.ts';
import { call } from '../engine.ts';
import { Button, Check, Field, inputClass, Note, OpenSettings, useAction } from '../ui.tsx';

/** What the dialog hands back: the design to add, with the Figma frames as its steps. The engine has already stored the images. */
export type FigmaDesign = Pick<DesignPoi, 'name' | 'frames'>;

const MAX_FRAMES = 100; // the engine's limit per import

/**
 * Add a design from Figma: paste a link, list the file's top-level frames, choose and order them, import. The token never
 * reaches this page: the engine holds it and does the talking to Figma (engine/src/figma/).
 */
export function FigmaImportDialog({ onAdd, onClose }: { onAdd(design: FigmaDesign): void; onClose(): void }) {
  const element = useRef<HTMLDialogElement>(null);
  const [invoker] = useState(() => document.activeElement);
  useEffect(() => {
    const dialog = element.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus();
    };
  }, [invoker]);

  const [link, setLink] = useState('');
  const [file, setFile] = useState<FigmaFile | null>(null);
  const [picked, setPicked] = useState<string[]>([]); // frame ids, in the order they will be steps
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [stored, setStored] = useState<Record<string, string>>({}); // frame id → asset id, kept so a retry only redoes what failed
  const [failed, setFailed] = useState<FigmaImport['failed']>([]);
  const finding = useAction();
  const importing = useAction();
  const search = useRef(0); // which "Find frames" the previews that arrive belong to

  const frameOf = (id: string) => file?.frames.find((frame) => frame.id === id);
  const nameOf = (id: string) => frameOf(id)?.name ?? id;

  function find(event: FormEvent) {
    event.preventDefault();
    const mine = ++search.current;
    void finding.run(async () => {
      setFile(null);
      setFailed([]);
      setStored({});
      setPreviews({});
      const found = await call('figma_frames', { link });
      if (mine !== search.current) return null;
      setFile(found);
      setPicked(found.frames.some((frame) => frame.id === found.node) ? [found.node!] : []);
      // The list is already on screen; the previews fill in as Figma renders them.
      call('figma_previews', { file: found.key, version: found.version, frames: found.frames.map(({ id, width, height }) => ({ id, width, height })) }).then(
        (images) => mine === search.current && setPreviews(images),
        () => {}, // previews are only for looking at
      );
      return null;
    });
  }

  const move = (index: number, by: number) => {
    const next = [...picked];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    setPicked(next);
  };

  function finish(assets: Record<string, string>) {
    if (file) onAdd({ name: file.name, frames: picked.filter((id) => assets[id]).map((id) => ({ asset: assets[id], name: nameOf(id) })) });
  }

  const todo = picked.filter((id) => !stored[id]);
  const problems = failed.filter((item) => picked.includes(item.id));
  function start() {
    if (!file) return;
    if (!todo.length) return finish(stored);
    void importing.run(async () => {
      const result = await call('figma_import', {
        file: file.key,
        version: file.version,
        frames: todo.map((id) => ({ id, name: nameOf(id), width: frameOf(id)?.width ?? null, height: frameOf(id)?.height ?? null })),
      });
      const all = { ...stored, ...Object.fromEntries(result.frames.map(({ id, asset }) => [id, asset.id])) };
      setStored(all);
      setFailed(result.failed);
      if (!result.failed.length) finish(all);
      return null;
    });
  }

  const pages = file ? [...new Set(file.frames.map((frame) => (frame.section ? `${frame.page} › ${frame.section}` : frame.page)))] : [];
  const linked = file?.node && !file.frames.some((frame) => frame.id === file.node);
  const openSettings = useContext(OpenSettings);
  return (
    // A token problem closes the dialog on its way to Settings.
    <OpenSettings.Provider value={openSettings && ((section) => { onClose(); openSettings(section); })}>
    <dialog ref={element} aria-label="Add from Figma" onCancel={(event) => { event.preventDefault(); onClose(); }} className="m-auto max-h-[90vh] w-full max-w-3xl space-y-4 overflow-auto rounded-xl border border-stone-200 bg-white p-6 shadow-xl backdrop:bg-stone-900/30">
      <h2 className="text-base font-semibold text-stone-900">Add from Figma</h2>
      <form onSubmit={find} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Field label="Figma link" hint="A link to a Figma file or to one of its frames. Gnomi reads it through Figma’s API with the access token from Settings.">
          <input value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://www.figma.com/design/…" spellCheck={false} autoComplete="off" className={inputClass} />
        </Field>
        <Button type="submit" variant="primary" loading={finding.busy} disabled={!link.trim()}>
          Find frames
        </Button>
      </form>
      {finding.outcome && !finding.outcome.ok && <Note tone="error">{finding.outcome.text}</Note>}

      {file && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex-1 text-sm text-stone-700">
              <span className="font-medium text-stone-900">{file.name}</span> · {file.frames.length} {file.frames.length === 1 ? 'frame' : 'frames'}
            </p>
            <Button small variant="quiet" onClick={() => setPicked([...picked, ...file.frames.map((frame) => frame.id).filter((id) => !picked.includes(id))])}>Select all</Button>
            <Button small variant="quiet" onClick={() => setPicked([])} disabled={!picked.length}>Clear</Button>
          </div>
          {linked && <Note tone="info">The link points at a layer that is not a top-level frame, so it is not in the list. Choose the frames you want.</Note>}
          {!file.frames.length && <Note tone="info">This file has no top-level frames. Gnomi lists frames that sit directly on a page or inside a section.</Note>}
          <div className="max-h-80 space-y-4 overflow-auto rounded-lg border border-stone-200 p-3">
            {pages.map((heading) => (
              <fieldset key={heading} className="space-y-2">
                <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">{heading}</legend>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {file.frames.filter((frame) => (frame.section ? `${frame.page} › ${frame.section}` : frame.page) === heading).map((frame) => (
                    <li key={frame.id}>
                      <Check checked={picked.includes(frame.id)} onChange={(on) => setPicked(on ? [...picked, frame.id] : picked.filter((id) => id !== frame.id))}>
                        <span className="flex items-center gap-3">
                          {previews[frame.id] ? <img src={previews[frame.id]} alt="" className="h-14 w-14 shrink-0 rounded border border-stone-200 bg-stone-50 object-contain" /> : <span className="h-14 w-14 shrink-0 rounded border border-stone-200 bg-stone-100" aria-hidden="true" />}
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{frame.name}</span>
                            {frame.width && frame.height && <span className="block text-xs text-stone-500">{Math.round(frame.width)} × {Math.round(frame.height)}</span>}
                          </span>
                        </span>
                      </Check>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ))}
          </div>

          {picked.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-stone-700">Order of the steps</p>
              <ol aria-label="Frames to import, in order" className="max-h-48 space-y-1 overflow-auto">
                {picked.map((id, index) => (
                  <li key={id} className="flex items-center gap-2 text-sm text-stone-800">
                    <span className="w-6 text-right text-stone-500">{index + 1}.</span>
                    <span className="min-w-0 flex-1 truncate">{nameOf(id)}</span>
                    <Button small variant="quiet" aria-label={`Move ${nameOf(id)} up`} disabled={index === 0} onClick={() => move(index, -1)}>Up</Button>
                    <Button small variant="quiet" aria-label={`Move ${nameOf(id)} down`} disabled={index === picked.length - 1} onClick={() => move(index, 1)}>Down</Button>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {picked.length > MAX_FRAMES && <Note tone="error">Choose at most {MAX_FRAMES} frames at a time.</Note>}
        </div>
      )}

      {importing.outcome && !importing.outcome.ok && <Note tone="error">{importing.outcome.text}</Note>}
      {problems.length > 0 && (
        <div role="alert" className="space-y-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          <p>{problems.length === 1 ? '1 frame' : `${problems.length} frames`} could not be exported. Nothing was added yet.</p>
          <ul className="list-disc pl-5">
            {problems.map((item) => <li key={item.id}><span className="font-medium">{item.name}</span>: {item.reason}</li>)}
          </ul>
        </div>
      )}

      <div className="sticky bottom-0 -mx-6 -mb-6 flex flex-wrap justify-end gap-3 border-t border-stone-200 bg-white px-6 py-4">
        <Button onClick={onClose}>Cancel</Button>
        {problems.length > 0 && picked.some((id) => stored[id]) && <Button onClick={() => finish(stored)}>Add the {picked.filter((id) => stored[id]).length} that worked</Button>}
        {file && (
          <Button variant="primary" loading={importing.busy} disabled={!picked.length || picked.length > MAX_FRAMES} onClick={start}>
            {problems.length > 0 ? 'Retry the failed frames' : `Import ${picked.length || ''} ${picked.length === 1 ? 'frame' : 'frames'}`}
          </Button>
        )}
      </div>
    </dialog>
    </OpenSettings.Provider>
  );
}
