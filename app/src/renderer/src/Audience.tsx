import { useEffect, useState } from 'react';
import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import type { Audience, Persona, ProjectConfig } from '@gnomi/engine/types.ts';
import { addSegment, blankAudience, cleanAudience, newSeed, PERSONA_MAXIMUM, personaMinimum, removeSegment, setShare } from './audience.ts';
import { call, onProgress } from './engine.ts';
import { problemFor } from './form.ts';
import { PersonaList } from './Personas.tsx';
import { CountryMix } from './CountryMix.tsx';
import { SegmentCard } from './Segments.tsx';
import { Card, Field, Note, NumberInput, primaryButton, ProgressBar, secondaryButton, usd, useAction } from './ui.tsx';

/** The audience tab: who the product is for, in proportions the team controls (idea.md §5.1 step 3). */
export function AudienceTab(props: {
  audience: Audience | null;
  onAudience(audience: Audience | null): void;
  info: ProjectInfo | null;
  description: string; // the product sentence, the starting point of a one-segment audience
  save(): Promise<ProjectConfig | string>;
  refresh(): Promise<void>;
}) {
  const { audience, onAudience, info, description, save, refresh } = props;
  const plan = useAction();
  const people = useAction();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const sessions = info?.sessions ?? [];
  const personas = info?.personas ?? [];
  const changed = JSON.stringify(audience && cleanAudience(audience)) !== JSON.stringify(info?.project?.audience ?? null);

  // Only while this tab is generating: a late message must not bring the bar back.
  useEffect(() => onProgress(({ done, total }) => setProgress((was) => was && { done, total })), []);

  // Saves first: the engine proposes from, and writes personas for, the saved project and audience.
  const saved = async (): Promise<string | null> => {
    const result = await save();
    return typeof result === 'string' ? problemFor(result, 'audience') : null;
  };

  const propose = () =>
    plan.run(async () => {
      const problem = await saved();
      if (problem) return { ok: false, text: problem };
      const proposal = await call('propose_audience', {});
      onAudience(proposal.audience);
      return { ok: true, text: `Proposed ${proposal.audience.segments.length} segments (${usd(proposal.cost_usd)}). Adjust them, then save and generate the personas.` };
    });

  const onSave = () =>
    plan.run(async () => {
      const problem = await saved();
      return problem ? { ok: false, text: problem } : { ok: true, text: 'Audience saved.' };
    });

  const generate = () =>
    plan.run(async () => {
      const problem = await saved();
      if (problem) return { ok: false, text: problem };
      setProgress({ done: 0, total: 0 });
      try {
        const result = await call('generate_personas', {});
        await refresh();
        return { ok: true, text: `${result.personas.length} personas are ready (${usd(result.cost_usd)}).` };
      } finally {
        setProgress(null);
      }
    });

  // One persona at a time through the engine, then the population is read again.
  const change = (text: (cost: number) => string, request: () => Promise<{ cost_usd: number } | null>) =>
    people.run(async () => {
      const result = await request();
      await refresh();
      return { ok: true, text: text(result?.cost_usd ?? 0) };
    });

  async function edit(persona: Persona): Promise<boolean> {
    let ok = false;
    await change(() => `Saved ${persona.name}.`, async () => {
      await call('edit_persona', { persona });
      ok = true;
      return null;
    });
    return ok;
  }

  const segments = audience?.segments ?? [];
  const several = segments.length > 1;
  return (
    <div className="space-y-5">
      <Card title="Audience">
        {audience === null ? (
          <div className="space-y-4">
            <p className="text-sm text-stone-600">
              Say who the product is for. Gnomi can propose segments from your product description and goal, or you can start from one segment and build from there. Without an
              audience, every run uses one built-in persona.
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={propose} disabled={plan.busy} className={primaryButton}>
                Propose segments
              </button>
              <button type="button" onClick={() => onAudience(blankAudience(description))} disabled={plan.busy} className={secondaryButton}>
                Start from one segment
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-[10rem_12rem_auto_1fr] sm:items-end">
              <Field label="Number of personas" hint={`${personaMinimum(audience)} to ${PERSONA_MAXIMUM}; 20 or more is better.`}>
                <NumberInput label="Number of personas" value={audience.persona_count} onChange={(v) => onAudience({ ...audience, persona_count: v })} min={personaMinimum(audience)} max={PERSONA_MAXIMUM} />
              </Field>
              <Field label="Seed" hint="The same seed gives the same people.">
                <NumberInput label="Seed" value={audience.seed} onChange={(v) => onAudience({ ...audience, seed: v })} min={0} />
              </Field>
              <button type="button" onClick={() => onAudience({ ...audience, seed: newSeed() })} className={`${secondaryButton} mb-5`}>
                New seed
              </button>
              <div className="flex flex-wrap justify-end gap-3 sm:mb-5">
                <button type="button" onClick={propose} disabled={plan.busy} className={secondaryButton}>
                  Propose segments again
                </button>
                <button type="button" onClick={() => onAudience(null)} disabled={plan.busy} className={secondaryButton}>
                  Start over
                </button>
              </div>
            </div>

            <CountryMix countries={audience.countries} onChange={(countries) => onAudience({ ...audience, countries })} />

            <ul aria-label="Segments" className="space-y-4">
              {segments.map((segment) => (
                <SegmentCard
                  key={segment.id}
                  segment={segment}
                  sessions={sessions}
                  several={several}
                  onChange={(next) => onAudience({ ...audience, segments: segments.map((s) => (s.id === segment.id ? next : s)) })}
                  onShare={(share) => onAudience(setShare(audience, segment.id, share))}
                  onRemove={() => onAudience(removeSegment(audience, segment.id))}
                />
              ))}
            </ul>
            <button type="button" onClick={() => onAudience(addSegment(audience))} className={secondaryButton}>
              Add segment
            </button>

            <div className="space-y-3 border-t border-stone-200 pt-4">
              <p className="text-sm text-stone-600">
                Shares always add up to 100%. Generating keeps every persona whose segment, seed and traits are unchanged, and only writes the new or changed ones.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={onSave} disabled={plan.busy} className={secondaryButton}>
                  Save audience
                </button>
                <button type="button" onClick={generate} disabled={plan.busy} className={primaryButton}>
                  Generate personas
                </button>
                {changed && <span className="text-sm text-amber-800">Not saved yet.</span>}
                {plan.busy && !progress && <p className="text-sm text-stone-500">Working...</p>}
              </div>
              {progress && (
                <div className="space-y-1">
                  <ProgressBar value={progress.done} max={progress.total} label="Writing personas" />
                  <p className="text-xs text-stone-500">{progress.total > 0 ? `Writing personas: ${progress.done} of ${progress.total}` : 'Starting...'}</p>
                </div>
              )}
            </div>
          </div>
        )}
        {plan.outcome && (
          <div className="mt-4">
            <Note tone={plan.outcome.ok ? 'ok' : 'error'}>{plan.outcome.text}</Note>
          </div>
        )}
      </Card>

      {people.outcome && <Note tone={people.outcome.ok ? 'ok' : 'error'}>{people.outcome.text}</Note>}
      {audience !== null && personas.length > 0 && (
        <PersonaList
          personas={personas}
          segments={segments}
          diversity={info?.diversity ?? null}
          audienceSeed={info?.project?.audience?.seed ?? null}
          busy={people.busy || plan.busy}
          onEdit={edit}
          onRegenerate={(id) => void change((cost) => `Wrote a new persona (${usd(cost)}).`, () => call('regenerate_persona', { id }))}
          onRemove={(id) => void change(() => 'Persona removed.', async () => (await call('remove_persona', { id }), null))}
          onAdd={(segmentId) => void change((cost) => `Added a persona (${usd(cost)}).`, () => call('add_persona', { segment_id: segmentId }))}
        />
      )}
    </div>
  );
}
