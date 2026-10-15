import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProjectAction, ProjectCatalog } from '../../projects.ts';
import { Card, Field, inputClass, Note, primaryButton, secondaryButton, useAction, when } from './ui.tsx';

/** Native dialog supplies focus containment, Escape handling and focus return to the invoking control. */
export function ProjectDialog({ title, onCancel, children }: { title: string; onCancel(): void; children: ReactNode }) {
  const element = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    element.current?.showModal();
  }, []);
  return (
    <dialog ref={element} aria-label={title} onCancel={(event) => { event.preventDefault(); onCancel(); }} className="m-auto w-full max-w-md space-y-4 rounded-xl border border-stone-200 bg-white p-6 shadow-xl backdrop:bg-stone-900/30">
      <h2 className="text-base font-semibold text-stone-900">{title}</h2>
      {children}
    </dialog>
  );
}

export function Projects({ catalog, onAction }: { catalog: ProjectCatalog; onAction(action: ProjectAction): Promise<string | null> }) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ action: 'rename' | 'duplicate'; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const action = useAction();
  const perform = (request: ProjectAction) => action.run(async () => {
    const text = await onAction(request);
    if (text === null) return null;
    setName('');
    return { ok: true, text };
  });

  return (
    <div className="space-y-5">
      <Card title="Projects">
        <p className="mb-5 text-sm text-stone-600">Keep each product's audience, runs and evidence in its own project.</p>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void perform({ action: 'create', name }); }}>
          <div className="min-w-56 flex-1">
            <Field label="New project name"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="For example, Hiring app" className={inputClass} /></Field>
          </div>
          <button type="submit" disabled={action.busy || !name.trim()} className={primaryButton}>Create project</button>
        </form>
      </Card>
      {action.outcome && <Note tone={action.outcome.ok ? 'ok' : 'error'}>{action.outcome.text}</Note>}
      {action.busy && <p role="status" className="text-sm text-stone-500">Working on the project…</p>}
      <ul aria-label="Projects" className="space-y-3">
        {catalog.projects.map((project) => (
          <li key={project.id} className="space-y-3 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold text-stone-900">{project.name}</h3>
                <p className="mt-1 text-xs text-stone-500">{project.configured ? `Updated ${when(project.updatedAt)}` : 'Ready to set up'}{project.id === catalog.currentId ? ' · Open now' : ''}</p>
              </div>
              <button type="button" onClick={() => void perform({ action: 'open', id: project.id })} disabled={action.busy} aria-label={`Open ${project.name}`} className={primaryButton}>Open</button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setEditing({ action: 'rename', id: project.id, name: project.name })} disabled={action.busy} aria-label={`Rename ${project.name}`} className={secondaryButton}>Rename</button>
              <button type="button" onClick={() => setEditing({ action: 'duplicate', id: project.id, name: `${project.name} copy` })} disabled={action.busy} aria-label={`Duplicate ${project.name}`} className={secondaryButton}>Duplicate</button>
              <button type="button" onClick={() => void perform({ action: 'export', id: project.id })} disabled={action.busy} aria-label={`Export ${project.name} folder`} className={secondaryButton}>Export folder</button>
              <button type="button" onClick={() => setDeleting({ id: project.id, name: project.name })} disabled={action.busy || !project.canDelete} aria-label={`Delete ${project.name}`} className={secondaryButton}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs leading-relaxed text-stone-500">Duplicates include settings and personas, ready for new runs. Exported folders also include run history and screenshots. Recorded logins and provider keys stay on this computer.</p>

      {editing && (
        <ProjectDialog title={editing.action === 'rename' ? 'Rename project' : 'Duplicate project'} onCancel={() => setEditing(null)}>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); const request = editing; setEditing(null); void perform(request); }}>
            <Field label="Project name"><input autoFocus value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} maxLength={120} className={inputClass} /></Field>
            {editing.action === 'duplicate' && <p className="text-sm text-stone-600">The copy starts with the same configuration and personas. Record its logins before running.</p>}
            <div className="flex flex-wrap gap-3">
              <button type="submit" disabled={!editing.name.trim()} className={primaryButton}>{editing.action === 'rename' ? 'Rename project' : 'Create duplicate'}</button>
              <button type="button" onClick={() => setEditing(null)} className={secondaryButton}>Cancel</button>
            </div>
          </form>
        </ProjectDialog>
      )}
      {deleting && (
        <ProjectDialog title="Delete project?" onCancel={() => setDeleting(null)}>
          <p className="text-sm text-stone-700">Move <strong>{deleting.name}</strong>, including its runs and recorded logins, to the Trash?</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => { const id = deleting.id; setDeleting(null); void perform({ action: 'delete', id }); }} className={primaryButton}>Move to Trash</button>
            <button type="button" autoFocus onClick={() => setDeleting(null)} className={secondaryButton}>Cancel</button>
          </div>
        </ProjectDialog>
      )}
    </div>
  );
}
