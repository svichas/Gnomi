import { useEffect, useRef, useState } from 'react';
import type { Persona, PersonaSchema, Report as ReportData } from '@gnomi/simulation/types.ts';
import { isAttributeEnabled } from '@gnomi/simulation/profile/schema.ts';
import { Icon, PersonaAvatar } from './Icon.tsx';
import { ProfileFields } from './ProfileFields.tsx';
import { OUTCOMES } from './reportParts.tsx';
import { Button } from './ui.tsx';

/** A persona's card from the report's chat: who they are, how their run went, and where to go from here. */
export function PersonaProfile({ persona, profile, schema, segment, onWatch, onTimeline, onAsk, onClose }: {
  persona: ReportData['personas'][number]; // how the run went
  profile?: Persona; // everything the audience holds about them, as the run froze it
  schema?: PersonaSchema;
  segment?: string;
  onWatch?(): void; // absent when no step has a screenshot
  onTimeline(): void;
  onAsk(): void;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [invoker] = useState(() => document.activeElement); // kept before the dialog takes focus, to hand it back
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus({ preventScroll: true });
    };
  }, [invoker]);
  const { text, tone } = OUTCOMES[persona.outcome];
  const role = [persona.job_title, segment].filter(Boolean).join(' · ');
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes it, as Esc and the Close button do from the keyboard
    <dialog ref={dialog} aria-label={`${persona.name}'s profile`} className="profile-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="profile-card">
        <header className="profile-hero">
          <PersonaAvatar name={persona.name} id={persona.id} pronouns={persona.pronouns} />
          <div className="min-w-0">
            <h2>{persona.name}{profile?.pronouns && isAttributeEnabled(schema, 'pronouns', 'card') && <span> ({profile.pronouns})</span>}</h2>
            {role && <p>{role}</p>}
            <span data-tone={tone} className="tone-chip">{text}</span>
          </div>
          <button type="button" className="profile-close" aria-label="Close" onClick={onClose}><Icon name="close" size={18} /></button>
        </header>
        <dl className="profile-stats">
          <div><dt>Steps</dt><dd>{persona.steps}</dd></div>
          <div><dt>Frictions</dt><dd>{persona.frictions}</dd></div>
          <div><dt>Device</dt><dd>{persona.device}</dd></div>
        </dl>
        {persona.outcome_text && <p className="profile-outcome">{persona.outcome_text}</p>}
        {profile && <div className="profile-fields"><ProfileFields persona={profile} schema={schema} purpose="all" /></div>}
        <p className="profile-note">A simulated persona: the profile is synthetic, written for this audience.</p>
        <footer className="profile-actions">
          {onWatch && <Button small onClick={onWatch}><Icon name="play" size={15} />Watch replay</Button>}
          <Button small onClick={onTimeline}><Icon name="activity" size={15} />Timeline</Button>
          <Button small variant="primary" onClick={onAsk}><Icon name="message" size={15} />Ask a question</Button>
        </footer>
      </div>
    </dialog>
  );
}
