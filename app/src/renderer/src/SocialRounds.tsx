import { useId } from 'react';
import { MAX_ROUNDS } from '@gnomi/simulation/settings.ts';
import type { RunSettings } from '@gnomi/simulation/types.ts';
import { Icon } from './Icon.tsx';

const ROUND_CHOICES = Array.from({ length: MAX_ROUNDS }, (_, index) => index + 1);

/** Whether, and how often, the audience meets in a shared feed (tech.md §6.4): set beside the people it applies to. */
export function SocialRounds({ settings, onSettings, people }: { settings: RunSettings; onSettings(settings: RunSettings): void; people: number }) {
  const id = useId();
  const on = settings.social ?? false;
  const rounds = Math.min(MAX_ROUNDS, Math.max(1, Math.floor(settings.rounds ?? 5)));
  return (
    <section className="social-rounds" data-on={on || undefined} aria-labelledby={`${id}-title`}>
      <div className="social-rounds-head">
        <span className="social-rounds-icon"><Icon name="message" size={22} /></span>
        <div>
          <h3 id={`${id}-title`}>Social rounds</h3>
          <p id={`${id}-hint`}>Between stretches of use, personas read a shared feed and may post, reply or react, so opinions can spread the way they do in a real community.</p>
        </div>
        <button type="button" role="switch" aria-checked={on} aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} className="switch" onClick={() => onSettings({ ...settings, social: !on })}>
          <span className="switch-label">{on ? 'On' : 'Off'}</span>
          <span className="switch-track"><span className="switch-thumb" /></span>
        </button>
      </div>
      {on ? (
        <div className="social-rounds-body">
          <div className="social-rounds-picker-row">
            <span id={`${id}-rounds`} className="social-rounds-label">Rounds</span>
            <div role="group" aria-labelledby={`${id}-rounds`} className="social-rounds-picker">
              {ROUND_CHOICES.map((n) => (
                <button key={n} type="button" aria-pressed={n === rounds} aria-label={`${n} ${n === 1 ? 'round' : 'rounds'}`} onClick={() => onSettings({ ...settings, rounds: n })}>{n}</button>
              ))}
            </div>
          </div>
          <ol className="social-rounds-flow" aria-hidden="true">
            {ROUND_CHOICES.slice(0, rounds).map((n) => (
              <li key={n}><span className="social-rounds-use" title="Use the product" /><span className="social-rounds-feed" title="Read and post in the feed" /></li>
            ))}
          </ol>
          <p className="social-rounds-note">
            {people > 1
              ? `Each persona uses the product, then visits the feed, ${rounds} ${rounds === 1 ? 'time' : 'times'}. Most stay silent, and a persona with nothing new to read or tell skips its visit. That is at most ${(rounds * people).toLocaleString()} short extra model calls for ${people} personas.`
              : 'With one persona there is nobody to talk to. Add more people for the feed to matter.'}
          </p>
        </div>
      ) : (
        <p className="social-rounds-off">Off: each persona tries the product on its own.</p>
      )}
    </section>
  );
}
