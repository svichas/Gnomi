import { useEffect, useRef, useState } from 'react';
import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import type { Audience, Persona, PersonaProgress, PersonaSchema, ProjectConfig } from '@gnomi/engine/types.ts';
import { GenerationDetails } from './GenerationDetails.tsx';
import { personaProfileIsCurrent } from '@gnomi/engine/profile/signature.ts';
import { addSegment, blankAudience, cleanAudience, newSeed, PERSONA_MAXIMUM, PERSONA_MINIMUM, removeSegment, setShare } from './audience.ts';
import { call, onProgress } from './engine.ts';
import { problemFor } from './form.ts';
import { PersonaList } from './Personas.tsx';
import { ProfileEditor } from './ProfileEditor.tsx';
import { CountryMix } from './CountryMix.tsx';
import { SegmentCard } from './Segments.tsx';
import { Card, Field, Note, NumberInput, primaryButton, secondaryButton, usd, useAction } from './ui.tsx';
import { Icon } from './Icon.tsx';
import { BuildProgress } from './BuildProgress.tsx';

/** The audience tab: who the product is for, in proportions the team controls (idea.md §5.1 step 3). */
export function AudienceTab(props: {
  audience: Audience | null;
  onAudience(audience: Audience | null): void;
  schema?: PersonaSchema;
  onSchema(schema: PersonaSchema): void;
  info: ProjectInfo | null;
  description: string; // the product sentence, the starting point of a one-segment audience
  projectName: string;
  goal: string;
  save(): Promise<ProjectConfig | string>;
  refresh(): Promise<void>;
  onBack(): void;
  onReview(): void;
}) {
  const { audience, onAudience, schema, onSchema, info, description, projectName, goal, save, refresh } = props;
  const plan = useAction();
  const people = useAction();
  const [progress, setProgress] = useState<PersonaProgress | null>(null);
  const [building, setBuilding] = useState<'audience' | 'personas' | null>(null);
  const buildPanel = useRef<HTMLDivElement>(null);
  const sessions = info?.sessions ?? [];
  const personas = info?.personas ?? [];
  const changed = JSON.stringify(audience && cleanAudience(audience)) !== JSON.stringify(info?.project?.audience ?? null) || JSON.stringify(schema) !== JSON.stringify(info?.project?.persona_schema);
  const profileProject = info?.project ? { ...info.project, name: projectName.trim(), description: description.trim(), goal: goal.trim(), audience: audience && cleanAudience(audience), ...(schema ? { persona_schema: schema } : {}) } : null;
  const stale = new Set(personas.filter((persona) => {
    try { return !!profileProject && !personaProfileIsCurrent(persona, profileProject); } catch { return true; }
  }).map((persona) => persona.id));
  const needsPersonas = audience !== null && (personas.length === 0 || stale.size > 0);
  const busy = plan.busy || people.busy;
  const stage = building === 'audience' || audience === null ? 1 : building === 'personas' || needsPersonas ? 2 : 3;

  // Only while this tab is generating: a late message must not bring the bar back.
  useEffect(() => onProgress((progress) => setProgress((was) => was && progress)), []);
  useEffect(() => { if (building) buildPanel.current?.scrollIntoView({ block: 'nearest' }); }, [building]);

  // Saves first: the engine proposes from, and writes personas for, the saved project and audience.
  const saved = async (): Promise<string | null> => {
    const result = await save();
    return typeof result === 'string' ? problemFor(result, 'audience') : null;
  };

  const propose = () =>
    plan.run(async () => {
      setBuilding('audience');
      try {
        const problem = await saved();
        if (problem) return { ok: false, text: problem };
        const proposal = await call('propose_audience', {});
        onAudience(proposal.audience);
        return { ok: true, text: `Proposed ${proposal.audience.segments.length} segments (${usd(proposal.cost_usd)}). Next, click Generate personas to create the people for your run.` };
      } finally {
        setBuilding(null);
      }
    });

  const onSave = () =>
    plan.run(async () => {
      const problem = await saved();
      return problem ? { ok: false, text: problem } : { ok: true, text: 'Audience saved.' };
    });

  const generate = () =>
    plan.run(async () => {
      setBuilding('personas');
      setProgress({ done: 0, total: 0 });
      try {
        const problem = await saved();
        if (problem) return { ok: false, text: problem };
        const result = await call('generate_personas', {});
        await refresh();
        return { ok: true, text: `${result.personas.length} ${result.personas.length === 1 ? 'persona is' : 'personas are'} ready (${usd(result.cost_usd)}).` };
      } catch (error) {
        await refresh().catch(() => {}); // retain the original generation error even if the engine disconnected
        throw error;
      } finally {
        setProgress(null);
        setBuilding(null);
      }
    });

  // One persona at a time through the engine, then the population is read again.
  const change = (text: (cost: number) => string, request: () => Promise<{ cost_usd: number } | null>) =>
    people.run(async () => {
      const problem = await saved();
      if (problem) return { ok: false, text: problem };
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
      <ol className="audience-steps" aria-label="Prepare your audience">
        <li data-complete={stage > 1 || undefined} aria-current={stage === 1 ? 'step' : undefined}><span>{stage > 1 ? <Icon name="check" size={16} /> : '1'}</span><div><strong>Define audience</strong><small>Choose your groups</small></div></li>
        <li data-complete={stage > 2 || undefined} aria-current={stage === 2 ? 'step' : undefined}><span>{stage > 2 ? <Icon name="check" size={16} /> : '2'}</span><div><strong>Build personas</strong><small>Create the people</small></div></li>
        <li aria-current={stage === 3 ? 'step' : undefined}><span>3</span><div><strong>Review & start</strong><small>Ready for their first run</small></div></li>
      </ol>
      <Card title="Audience">
        <div ref={buildPanel}>{building && <BuildProgress kind={building} progress={progress} />}</div>
        {!building && <GenerationDetails calls={info?.setup_calls ?? []} />}
        <fieldset disabled={busy} className="audience-fields" hidden={building === 'audience' && audience === null}>
        {audience === null ? (
          <div className="space-y-4">
            <p className="text-sm text-stone-600">
              Who is your product for? Start with a suggested audience, or describe a group yourself. You can adjust the details before creating your simulated users.
              {schema ? ' Your saved profile attributes will be included.' : ' For a quick first look, you can also continue with the built-in persona.'}
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={propose} disabled={plan.busy} className={primaryButton}>
                <Icon name="people" size={18} />Suggest an audience
              </button>
              <button type="button" onClick={() => onAudience(blankAudience(description))} disabled={plan.busy} className={secondaryButton}>
                Build my own
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {!building && <div className="audience-next">
              <span className="audience-next-icon"><Icon name={needsPersonas ? 'people' : 'check'} size={24} /></span>
              <div><p className="eyebrow">{needsPersonas ? 'Next step · Required before your run' : 'Your people are ready'}</p><h3>{needsPersonas ? 'Bring your audience to life.' : `${personas.length} ${personas.length === 1 ? 'perspective' : 'perspectives'}, ready to explore.`}</h3><p>{needsPersonas ? `Your audience defines who to include. Click Generate personas to build ${audience.persona_count} simulated ${audience.persona_count === 1 ? 'person' : 'people'} before starting a run.` : 'Review your people below, or adjust your audience and generate again to apply changes.'}</p></div>
              <button type="button" onClick={generate} className={needsPersonas ? primaryButton : secondaryButton}><Icon name="people" size={18} />Generate personas<Icon name="arrow" size={16} /></button>
            </div>}
            <div className="flex flex-wrap items-end gap-4">
              <Field label="Number of personas" hint={`${PERSONA_MINIMUM} to ${PERSONA_MAXIMUM}. Use 1 for a quick check.`}>
                <NumberInput label="Number of personas" value={audience.persona_count} onChange={(v) => onAudience({ ...audience, persona_count: v })} min={PERSONA_MINIMUM} max={PERSONA_MAXIMUM} />
              </Field>
              <details className="audience-seed"><summary>Reproducibility options</summary><div className="flex items-end gap-3 mt-3"><Field label="Seed" hint="The same seed gives the same people.">
                <NumberInput label="Seed" value={audience.seed} onChange={(v) => onAudience({ ...audience, seed: v })} min={0} />
              </Field>
              <button type="button" onClick={() => onAudience({ ...audience, seed: newSeed() })} className={`${secondaryButton} mb-5`}>
                New seed
              </button>
              </div></details>
              <div className="flex flex-wrap gap-3">
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
                {changed && <span className="text-sm text-amber-800">Not saved yet.</span>}
                {plan.busy && !building && <p className="text-sm text-stone-500">Saving audience…</p>}
              </div>
            </div>
          </div>
        )}
        </fieldset>
        {plan.outcome && (
          <div className="mt-4">
            <Note tone={plan.outcome.ok ? 'ok' : 'error'}>{plan.outcome.text}</Note>
          </div>
        )}
      </Card>

      {audience && <details className="disclosure"><summary><Icon name="settings" />Customize persona attributes<span>Optional · traits, templates, and sampling</span></summary><div className="disclosure-body"><ProfileEditor schema={schema} segments={segments} onSchema={onSchema} disabled={people.busy || plan.busy} /></div></details>}

      {stale.size > 0 && <Note tone="info">{stale.size} {stale.size === 1 ? 'persona needs' : 'personas need'} regeneration after profile changes. Their old biographies and voices are hidden until you generate personas.</Note>}

      {people.outcome && <Note tone={people.outcome.ok ? 'ok' : 'error'}>{people.outcome.text}</Note>}
      {audience !== null && personas.length > 0 && (
        <PersonaList
          personas={personas}
          schema={schema}
          stale={stale}
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
      <div className="flow-footer audience-footer">
        <button type="button" className={secondaryButton} onClick={props.onBack}><Icon name="back" size={16} />Back to setup</button>
        <div><p id="audience-run-hint">{busy ? 'Wait for the current task to finish before starting a run.' : needsPersonas ? 'Generate personas above to unlock your run.' : audience ? 'Your personas are ready. Review your run next.' : 'Or try a quick run with the built-in persona.'}</p><button type="button" className={primaryButton} disabled={busy || needsPersonas} aria-describedby="audience-run-hint" onClick={props.onReview}><Icon name="play" size={16} />Review & start</button></div>
      </div>
    </div>
  );
}
