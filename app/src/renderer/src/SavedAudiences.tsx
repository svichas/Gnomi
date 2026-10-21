import { useEffect, useState } from 'react';
import type { SavedAudience } from '../../audiences.ts';
import { errorText } from './engine.ts';
import { Icon } from './Icon.tsx';
import { ProjectDialog } from './Projects.tsx';
import { Button, Field, inputClass, Note, when } from './ui.tsx';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The saved audiences a new audience can start from; nothing while there are none. */
export function SavedAudienceList({ onUse }: { onUse(saved: SavedAudience): void }) {
  const [saved, setSaved] = useState<SavedAudience[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SavedAudience | null>(null);
  useEffect(() => { window.gnomi.listAudiences().then(setSaved, (err) => setError(errorText(err))); }, []);
  const remove = (id: string) => {
    setDeleting(null);
    window.gnomi.deleteAudience(id).then(setSaved, (err) => setError(errorText(err)));
  };
  if (!saved.length) return error ? <Note tone="error">{error}</Note> : null;
  return (
    <section className="saved-audiences" aria-labelledby="saved-audiences-title">
      <h4 id="saved-audiences-title">Or start from a saved audience</h4>
      {error && <Note tone="error">{error}</Note>}
      <ul>
        {saved.map((entry) => (
          <li key={entry.id}>
            <div><strong>{entry.name}</strong><span>{plural(entry.audience.segments.length, 'segment', 'segments')} · {plural(entry.audience.persona_count, 'persona', 'personas')} · Saved {when(entry.savedAt)}</span></div>
            <Button small onClick={() => onUse(entry)} aria-label={`Use ${entry.name}`}>Use</Button>
            <button type="button" onClick={() => setDeleting(entry)} aria-label={`Delete ${entry.name}`} title="Delete saved audience" className="icon-button"><Icon name="trash" size={16} /></button>
          </li>
        ))}
      </ul>
      {deleting && (
        <ProjectDialog title="Delete saved audience?" onCancel={() => setDeleting(null)}>
          <p className="text-sm text-stone-700">Remove <strong>{deleting.name}</strong> from your saved audiences? Projects that started from it keep their own copy.</p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => remove(deleting.id)} variant="primary">Delete</Button>
            <Button autoFocus onClick={() => setDeleting(null)}>Cancel</Button>
          </div>
        </ProjectDialog>
      )}
    </section>
  );
}

/** Asks for a name to save the audience being edited under; a name already saved is replaced, and the dialog says so first. */
export function SaveToLibrary({ defaultName, disabled, onSave }: { defaultName: string; disabled: boolean; onSave(name: string): void }) {
  const [name, setName] = useState<string | null>(null);
  const [taken, setTaken] = useState<string[]>([]);
  const open = () => {
    setName(defaultName);
    window.gnomi.listAudiences().then((list) => setTaken(list.map((entry) => entry.name.toLowerCase())), () => setTaken([]));
  };
  const replacing = name !== null && taken.includes(name.trim().toLowerCase());
  return (
    <>
      <Button onClick={open} disabled={disabled} small><Icon name="folder" size={14} />Save to library</Button>
      {name !== null && (
        <ProjectDialog title="Save to your audience library" onCancel={() => setName(null)}>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); setName(null); onSave(name.trim()); }}>
            <Field label="Audience name" hint={replacing ? 'An audience with this name is already saved. Saving replaces it.' : undefined}>
              <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} className={inputClass} />
            </Field>
            <p className="text-sm text-stone-600">Keeps the segments, countries, profile attributes and seed, so any project can start from them. Personas are written fresh for each product.</p>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={!name.trim()} variant="primary">{replacing ? 'Replace saved audience' : 'Save to library'}</Button>
              <Button onClick={() => setName(null)}>Cancel</Button>
            </div>
          </form>
        </ProjectDialog>
      )}
    </>
  );
}
