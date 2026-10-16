import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProjectAction, ProjectCatalog } from '../../projects.ts';
import { Button, Field, inputClass, Note, useAction, when } from './ui.tsx';
import { Icon } from './Icon.tsx';

/** Keep the invoking control before React autofocus moves focus into the dialog. */
export function ProjectDialog({ title, onCancel, children }: { title: string; onCancel(): void; children: ReactNode }) {
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
  return (
    <dialog ref={element} aria-label={title} onCancel={(event) => { event.preventDefault(); onCancel(); }} className="m-auto w-full max-w-md space-y-4 rounded-xl border border-stone-200 bg-white p-6 shadow-xl backdrop:bg-stone-900/30">
      <h2 className="text-base font-semibold text-stone-900">{title}</h2>
      {children}
    </dialog>
  );
}

function ProjectMenu({ name, disabled, children }: { name: string; disabled: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', dismiss);
    };
  }, [open]);

  const closeAndFocus = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div ref={container} className="project-menu"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.stopPropagation();
          closeAndFocus();
        }
      }}>
      <button ref={trigger} type="button" className="project-menu-trigger" aria-label={`Manage ${name}`} aria-expanded={open} aria-controls={panelId} disabled={disabled} onClick={() => setOpen(!open)}><Icon name="more" /></button>
      <div id={panelId} role="group" aria-label={`Actions for ${name}`} hidden={!open} className="project-menu-items" onClick={(event) => {
        const button = event.target instanceof Element ? event.target.closest('button') : null;
        if (button && !button.disabled) closeAndFocus();
      }}>{children}</div>
    </div>
  );
}

export function Projects({ catalog, onAction, onReturn }: { catalog: ProjectCatalog; onAction(action: ProjectAction): Promise<string | null>; onReturn(): void }) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ action: 'rename' | 'duplicate'; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const action = useAction();
  const perform = (request: ProjectAction) => action.run(async () => {
    const text = await onAction(request);
    if (text === null) return null;
    setName('');
    setCreating(false);
    return { ok: true, text };
  });

  return (
    <div className="projects-page">
      <div className="page-heading projects-heading"><p className="eyebrow">Perspective before you ship</p><h1 tabIndex={-1}>Your projects.</h1><p>A place for each product, its people, and what you learn.</p></div>
      <div className="section-toolbar"><h2>Projects <span aria-hidden="true" className="count-label">{catalog.projects.length}</span></h2><Button onClick={() => setCreating(true)} variant="primary"><Icon name="plus" size={18} />New project</Button></div>
      {creating && <ProjectDialog title="Create a project" onCancel={() => { if (!action.busy) setCreating(false); }}>
        <p className="text-sm text-stone-600">Give your product a name. You can add the details next.</p>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void perform({ action: 'create', name }); }}>
          <div className="min-w-56 flex-1">
            <Field label="New project name"><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="For example, Hiring app" className={inputClass} /></Field>
          </div>
          <div className="flex gap-3"><Button type="submit" disabled={action.busy || !name.trim()} variant="primary">{action.busy ? 'Creating…' : 'Create project'}</Button><Button onClick={() => setCreating(false)} disabled={action.busy}>Cancel</Button></div>
        </form>
        {action.outcome && !action.outcome.ok && <Note tone="error">{action.outcome.text}</Note>}
      </ProjectDialog>}
      {action.outcome && !creating && <Note tone={action.outcome.ok ? 'ok' : 'error'}>{action.outcome.text}</Note>}
      {action.busy && <p role="status" className="text-sm text-stone-500">Working on the project…</p>}
      <ul aria-label="Projects" className="project-list">
        {catalog.projects.map((project) => (
          <li key={project.id} className="project-list-row">
            <button type="button" onClick={() => void perform({ action: 'open', id: project.id })} disabled={action.busy} aria-label={`Open ${project.name}`} className="project-open">
              <span className="project-folder"><Icon name="folder" size={24} /></span><span className="project-row-copy"><span className="project-row-title"><span role="heading" aria-level={3}>{project.name}</span>{project.id === catalog.currentId && <span className="current-label">Last opened</span>}</span><span className="project-meta">{project.configured ? `Updated ${when(project.updatedAt)}` : 'Ready for your first test'}</span></span><Icon name="arrow" size={20} />
            </button>
            <ProjectMenu name={project.name} disabled={action.busy}>
              <button type="button" onClick={() => setEditing({ action: 'rename', id: project.id, name: project.name })} disabled={action.busy} aria-label={`Rename ${project.name}`}>Rename</button>
              <button type="button" onClick={() => setEditing({ action: 'duplicate', id: project.id, name: `${project.name} copy` })} disabled={action.busy} aria-label={`Duplicate ${project.name}`}>Duplicate</button>
              <button type="button" onClick={() => void perform({ action: 'export', id: project.id })} disabled={action.busy} aria-label={`Export ${project.name} folder`}>Export folder</button>
              <button type="button" onClick={() => setDeleting({ id: project.id, name: project.name })} disabled={action.busy || !project.canDelete} aria-label={`Delete ${project.name}`} className="project-menu-delete">Delete</button>
            </ProjectMenu>
          </li>
        ))}
      </ul>
      {catalog.projects.length === 0 && <div className="empty-state"><Icon name="folder" size={32} /><h2>Your next perspective starts here.</h2><p>Create a project for the product you want to explore.</p></div>}
      <div className="projects-footnote"><p><Icon name="folder" size={16} />Projects are saved on this computer.</p>{catalog.currentId && <Button onClick={onReturn} variant="link">Return to open project<Icon name="arrow" size={16} /></Button>}</div>

      {editing && (
        <ProjectDialog title={editing.action === 'rename' ? 'Rename project' : 'Duplicate project'} onCancel={() => setEditing(null)}>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); const request = editing; setEditing(null); void perform(request); }}>
            <Field label="Project name"><input autoFocus value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} maxLength={120} className={inputClass} /></Field>
            {editing.action === 'duplicate' && <p className="text-sm text-stone-600">The copy starts with the same configuration and personas. Record its logins before running.</p>}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={!editing.name.trim()} variant="primary">{editing.action === 'rename' ? 'Rename project' : 'Create duplicate'}</Button>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </form>
        </ProjectDialog>
      )}
      {deleting && (
        <ProjectDialog title="Delete project?" onCancel={() => setDeleting(null)}>
          <p className="text-sm text-stone-700">Move <strong>{deleting.name}</strong>, including its runs and recorded logins, to the Trash?</p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => { const id = deleting.id; setDeleting(null); void perform({ action: 'delete', id }); }} variant="primary">Move to Trash</Button>
            <Button autoFocus onClick={() => setDeleting(null)}>Cancel</Button>
          </div>
        </ProjectDialog>
      )}
    </div>
  );
}
