import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import type { Audience, Persona, PersonaProgress, PersonaSchema, ProjectConfig, RunEstimate, RunSettings } from '@gnomi/simulation/types.ts';
import { GenerationDetails } from './GenerationDetails.tsx';
import { getPersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import type { SavedAudience } from '@gnomi/engine/audience/file.ts';
import { addSegment, audienceProblem, blankAudience, cleanAudience, generatedCount, newSeed, PERSONA_MAXIMUM, PERSONA_MINIMUM, removeSegment, segmentCounts, segmentVar, setShare, staleProfiles } from './audience.ts';
import { estimateText } from './cost.ts';
import { call, onProgress } from './engine.ts';
import { problemFor } from './form.ts';
import { PersonaList } from './Personas.tsx';
import { profileProblem } from './profile.ts';
import { ProfileEditor } from './ProfileEditor.tsx';
import { CountryMix } from './CountryMix.tsx';
import { SavedAudienceList, SaveToLibrary } from './SavedAudiences.tsx';
import { SegmentCard } from './Segments.tsx';
import { SocialRounds } from './SocialRounds.tsx';
import { ActionBar, Button, Card, Field, Note, NumberInput, OutcomeNote, usd, useAction } from './ui.tsx';
import { Icon } from './Icon.tsx';
import { BuildProgress } from './BuildProgress.tsx';
import './audience-settings.css';

/** Where the audience stands on its way to a run; the review step shows it too, at its last stage. */
export function AudienceSteps({ stage }: { stage: 1 | 2 | 3 }) {
  return (
    <ol className="audience-steps" aria-label="Prepare your audience">
      <li data-complete={stage > 1 || undefined} aria-current={stage === 1 ? 'step' : undefined}><span>{stage > 1 ? <Icon name="check" size={16} /> : '1'}</span><div><strong>Define audience</strong><small>Choose your groups</small></div></li>
      <li data-complete={stage > 2 || undefined} aria-current={stage === 2 ? 'step' : undefined}><span>{stage > 2 ? <Icon name="check" size={16} /> : '2'}</span><div><strong>Build personas</strong><small>Create the people</small></div></li>
      <li aria-current={stage === 3 ? 'step' : undefined}><span>3</span><div><strong>Review & start</strong><small>Ready for their first run</small></div></li>
    </ol>
  );
}

/** The size of the audience, up front: it sets how many people are written and what each run costs. */
function PersonaCount({ audience, onChange, estimate, written }: { audience: Audience; onChange(count: number): void; estimate: RunEstimate | null; written: number }) {
  const id = useId();
  const count = audience.persona_count;
  const counts = Number.isInteger(count) && count >= PERSONA_MINIMUM && count <= PERSONA_MAXIMUM ? segmentCounts(audience) : null;
  return (
    <div className="persona-count">
      <div>
        <label htmlFor={id} className="persona-count-label">Number of personas</label>
        <NumberInput id={id} label="Number of personas" value={count} onChange={onChange} min={PERSONA_MINIMUM} max={PERSONA_MAXIMUM} aria-describedby={`${id}-hint`} />
        <input type="range" aria-label="Adjust the number of personas" min={PERSONA_MINIMUM} max={PERSONA_MAXIMUM} value={Math.min(PERSONA_MAXIMUM, Math.max(PERSONA_MINIMUM, count))} onChange={(event) => onChange(Number(event.target.value))} className="persona-count-range" />
        <p id={`${id}-hint`} className="persona-count-hint">{PERSONA_MINIMUM} to {PERSONA_MAXIMUM}. Use 1 for a quick check.</p>
      </div>
      <div>
        <p className="persona-allocation-label">Your audience mix</p>
        {counts && <div className="persona-allocation-bar" aria-hidden="true">{audience.segments.map((segment, index) => <span key={segment.id} style={{ flex: counts[index], background: segmentVar(index) }} />)}</div>}
        {counts && (
          <ul aria-label="Personas per segment" className="persona-count-split">
            {audience.segments.map((segment, index) => (
              <li key={segment.id} style={{ '--segment-color': segmentVar(index) } as CSSProperties}>
                <span className="segment-dot" /><span>{segment.name.trim() || 'Unnamed segment'}</span><span className="persona-allocation-share">{segment.share}%</span><strong>{counts[index]} <span className="sr-only">personas</span></strong>
              </li>
            ))}
          </ul>
        )}
        <p className="persona-count-hint">Split by share, with at least 3 per segment when there are enough to go round.</p>
        {estimate && <p className="persona-count-estimate"><span>Each run with the {written} personas written</span>{estimateText(estimate)}</p>}
      </div>
    </div>
  );
}

/** The audience tab: who the product is for, in proportions the team controls (idea.md §5.1 step 3). */
export function AudienceTab(props: {
  audience: Audience | null;
  onAudience(audience: Audience | null): void;
  schema?: PersonaSchema;
  onSchema(schema: PersonaSchema): void;
  settings: RunSettings;
  onSettings(settings: RunSettings): void;
  info: ProjectInfo | null;
  description: string; // the product sentence, the starting point of a one-segment audience
  projectName: string;
  goal: string;
  save(): Promise<ProjectConfig | string>;
  refresh(): Promise<void>;
  onBack(): void;
  onReview(): void;
}) {
  const { audience, onAudience, schema, onSchema, settings, onSettings, info, description, projectName, goal, save, refresh } = props;
  const plan = useAction();
  const people = useAction();
  const [progress, setProgress] = useState<PersonaProgress | null>(null);
  const [building, setBuilding] = useState<'audience' | 'personas' | null>(null);
  const buildPanel = useRef<HTMLDivElement>(null);
  const sessions = info?.sessions ?? [];
  const personas = info?.personas ?? [];
  const savedSettings = info?.project?.settings;
  const socialChanged = !!savedSettings && ((settings.social ?? false) !== (savedSettings.social ?? false) || (settings.rounds ?? 5) !== (savedSettings.rounds ?? 5));
  const changed = JSON.stringify(audience && cleanAudience(audience)) !== JSON.stringify(info?.project?.audience ?? null) || JSON.stringify(schema) !== JSON.stringify(info?.project?.persona_schema) || socialChanged;
  // Checking a profile samples it again, for up to 200 personas: only when an input changes, not on every render.
  const stale = useMemo(() => {
    const profileProject = info?.project ? { ...info.project, name: projectName.trim(), description: description.trim(), goal: goal.trim(), audience: audience && cleanAudience(audience), ...(schema ? { persona_schema: schema } : {}) } : null;
    return staleProfiles(personas, profileProject);
  }, [personas, info?.project, projectName, description, goal, audience, schema]);
  const countChanged = audience !== null && personas.length > 0 && audience.persona_count !== generatedCount(info);
  const needsPersonas = audience !== null && (personas.length === 0 || stale.size > 0 || countChanged);
  const busy = plan.busy || people.busy;
  const stage = building === 'audience' || audience === null ? 1 : building === 'personas' || needsPersonas ? 2 : 3;
  const [estimate, setEstimate] = useState<RunEstimate | null>(null);
  const [libraryName, setLibraryName] = useState<string | null>(null); // the saved audience this one came from or was saved as

  // A run estimate for the personas already written; none while they are missing or out of date, as it would describe other people.
  useEffect(() => {
    setEstimate(null);
    if (!audience || needsPersonas) return;
    let current = true;
    call('estimate_run', {}).then((result) => current && setEstimate(result.unpriced.length ? null : result), () => {});
    return () => { current = false; };
  }, [info, needsPersonas]);

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

  // Like a proposal, a saved audience only fills the editor; the project keeps it once it is saved.
  const startFrom = (saved: SavedAudience) =>
    plan.run(async () => {
      onAudience(saved.audience);
      onSchema(saved.schema);
      setLibraryName(saved.name);
      const missing = [...new Set(saved.audience.segments.flatMap((segment) => segment.role && !sessions.some((session) => session.role === segment.role) ? [segment.role] : []))];
      const logins = missing.length ? ` Record a login for ${missing.join(', ')} before running, or set those segments to logged out.` : '';
      return { ok: true, text: `Started from “${saved.name}”. Review the mix, then generate personas for this project.${logins}` };
    });

  const saveToLibrary = (name: string) =>
    plan.run(async () => {
      const clean = cleanAudience(audience!);
      const problem = audienceProblem(clean) ?? profileProblem(schema);
      if (problem) return { ok: false, text: problem };
      const saved = await window.gnomi.saveAudience(name, clean, getPersonaSchema(schema));
      setLibraryName(saved.name);
      return { ok: true, text: `Saved “${saved.name}” to your audience library. Any project can start from it on its Audience tab.` };
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
    <div className="audience-workspace space-y-5">
      <AudienceSteps stage={stage} />
      {building === 'personas' ? <div ref={buildPanel}><BuildProgress kind="personas" progress={progress} /></div> : !building && audience && (
        <div className="audience-next">
          <span className="audience-next-icon"><Icon name={needsPersonas ? 'people' : 'check'} size={24} /></span>
          <div><p className="eyebrow">{needsPersonas ? 'Step 2 · Required before your run' : 'Your people are ready'}</p><h2>{needsPersonas ? 'Create your simulated audience' : `${personas.length} ${personas.length === 1 ? 'persona' : 'personas'} ready to explore`}</h2><p>{needsPersonas ? `Review the mix below, then generate ${audience.persona_count} simulated ${audience.persona_count === 1 ? 'person' : 'people'} to unlock your run.` : 'Review the profiles below or continue to your run. Generate again after changing the mix.'}</p></div>
          <Button onClick={generate} disabled={busy} variant={needsPersonas ? 'primary' : 'secondary'}><Icon name="people" size={18} />Generate personas<Icon name="arrow" size={16} /></Button>
        </div>
      )}
      <OutcomeNote outcome={plan.outcome} />
      <Card title="Audience">
        {building === 'audience' && <div ref={buildPanel}><BuildProgress kind="audience" progress={progress} /></div>}
        <fieldset disabled={busy} className="audience-fields" hidden={building === 'audience' && audience === null}>
        {audience === null ? (
          <div className="audience-start">
            <AudienceIllustration />
            <h3>Who should try your product?</h3>
            <p>Start from a suggested mix of people, or describe the groups yourself. Either way, you can fine-tune every detail before creating your simulated users.</p>
            <div className="audience-choices">
              <button type="button" onClick={propose} aria-label="Suggest an audience" aria-describedby="audience-suggest-hint" className="audience-choice audience-choice-primary">
                <Icon name="spark" size={22} /><strong>Suggest an audience</strong><span id="audience-suggest-hint">Gnomi proposes groups from your product and goal.</span>
              </button>
              <button type="button" onClick={() => onAudience(blankAudience({ name: projectName.trim() || 'your product', role: info?.project?.role ?? null, goal: goal.trim() }))} aria-label="Build my own" aria-describedby="audience-build-hint" className="audience-choice">
                <Icon name="plus" size={22} /><strong>Build my own</strong><span id="audience-build-hint">Start with one group and shape it yourself.</span>
              </button>
            </div>
            <SavedAudienceList onUse={startFrom} />
            <p className="audience-start-note">{schema ? 'Your saved profile attributes will be included.' : 'Just taking a quick look? You can also run with the built-in persona.'}</p>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="audience-builder-intro"><p>Shape who takes part</p><span>{segments.length} {segments.length === 1 ? 'segment' : 'segments'}<span aria-hidden="true"> · </span>{changed ? 'Unsaved changes' : 'Saved with project'}</span></div>
            <div className="audience-toolbar">
              <div className="audience-toolbar-main">
                <PersonaCount audience={audience} onChange={(persona_count) => onAudience({ ...audience, persona_count })} estimate={estimate} written={personas.length} />
                <details className="audience-seed">
                  <summary>Reproducibility options</summary>
                  <div className="audience-seed-body">
                    <Field label="Seed">
                      <NumberInput label="Seed" value={audience.seed} onChange={(v) => onAudience({ ...audience, seed: v })} min={0} aria-describedby="audience-seed-hint" />
                    </Field>
                    <Button onClick={() => onAudience({ ...audience, seed: newSeed() })}>
                      New seed
                    </Button>
                  </div>
                  <p id="audience-seed-hint" className="audience-seed-hint">The same seed gives the same people.</p>
                </details>
              </div>
              <div className="audience-toolbar-actions">
                <SaveToLibrary defaultName={libraryName ?? `${projectName.trim() || 'Untitled'} audience`} disabled={plan.busy} onSave={saveToLibrary} />
                <Button onClick={propose} disabled={plan.busy} loading={building === 'audience'} small>
                  <Icon name="spark" size={14} />Propose segments again
                </Button>
                <Button onClick={() => onAudience(null)} disabled={plan.busy} small>
                  Start over
                </Button>
              </div>
            </div>

            <CountryMix countries={audience.countries} onChange={(countries) => onAudience({ ...audience, countries })} />

            <div className="space-y-3">
              <div className="segment-list-head"><h3>Segments</h3><p>Shares always add up to 100%.</p></div>
              <ul aria-label="Segments" className="segment-list">
              {segments.map((segment, index) => (
                <SegmentCard
                  key={segment.id}
                  segment={segment}
                  index={index}
                  sessions={sessions}
                  several={several}
                  onChange={(next) => onAudience({ ...audience, segments: segments.map((s) => (s.id === segment.id ? next : s)) })}
                  onShare={(share) => onAudience(setShare(audience, segment.id, share))}
                  onRemove={() => onAudience(removeSegment(audience, segment.id))}
                />
              ))}
              </ul>
              <button type="button" onClick={() => onAudience(addSegment(audience))} className="add-segment">
                <Icon name="plus" size={16} />Add segment
              </button>
            </div>

            <SocialRounds settings={settings} onSettings={onSettings} people={audience.persona_count} />

            <div className="space-y-3 border-t border-stone-200 pt-4">
              <p className="text-sm text-stone-600">
                Generate personas saves your audience and only rewrites profiles that changed. You can also save your draft to continue later.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={onSave} disabled={plan.busy}>
                  Save audience
                </Button>
                {changed && <span className="text-sm text-amber-800">Not saved yet.</span>}
                {plan.busy && !building && <p className="text-sm text-stone-500">Saving audience…</p>}
              </div>
            </div>
          </div>
        )}
        </fieldset>
      </Card>

      {audience && <details className="disclosure"><summary><Icon name="settings" />Customize persona attributes<span>Optional · traits, templates, and sampling</span></summary><div className="disclosure-body"><ProfileEditor schema={schema} segments={segments} onSchema={onSchema} disabled={people.busy || plan.busy} /></div></details>}

      {stale.size > 0 && <Note tone="info">{stale.size} {stale.size === 1 ? 'persona needs' : 'personas need'} regeneration after profile changes. Their old biographies and voices are hidden until you generate personas.</Note>}

      {!building && <GenerationDetails calls={info?.setup_calls ?? []} />}

      <OutcomeNote outcome={people.outcome} />
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
      <ActionBar>
        <Button className="mr-auto" onClick={props.onBack}><Icon name="back" size={16} />Back to setup</Button>
        <div className="audience-footer"><p id="audience-run-hint">{busy ? 'Wait for the current task to finish before starting a run.' : countChanged ? 'The persona count has changed. Generate personas again to continue.' : stale.size ? 'Your audience changed. Generate personas again to continue.' : needsPersonas ? 'Generate personas to unlock your run.' : audience ? 'Your personas are ready. Review your run next.' : 'Or try a quick run with the built-in persona.'}</p>
          {needsPersonas && <Button variant="primary" disabled={busy} loading={building === 'personas'} onClick={generate}><Icon name="people" size={16} />Generate personas</Button>}
          <Button variant={needsPersonas ? 'secondary' : 'primary'} disabled={busy || needsPersonas} aria-describedby="audience-run-hint" onClick={props.onReview}><Icon name="play" size={16} />Review & start</Button></div>
      </ActionBar>
    </div>
  );
}

/** A quiet picture of the choice ahead: a few different people, not yet written. */
function AudienceIllustration() {
  const people = [{ x: 36, y: 40, color: 'var(--gnomi-segment-2)' }, { x: 196, y: 40, color: 'var(--gnomi-segment-3)' }, { x: 110, y: 18, color: 'var(--gnomi-action)' }];
  return (
    <svg viewBox="0 0 300 150" fill="none" aria-hidden="true" className="audience-art">
      <ellipse cx="150" cy="80" rx="128" ry="58" className="build-orbit" />
      {people.map(({ x, y, color }, i) => (
        <g key={i} transform={`translate(${x} ${y})`}>
          <rect width="68" height="88" rx="12" className="build-card" />
          <circle cx="34" cy="30" r="20" fill={color} fillOpacity=".15" />
          <circle cx="34" cy="26" r="7" fill={color} />
          <path d="M21 43c0-13 26-13 26 0" fill={color} />
          <path d="M20 62h28M26 72h16" className="build-card-line" />
        </g>
      ))}
      <path d="M92 22v10m-5-5h10M238 122v10m-5-5h10" className="audience-art-spark" />
      <circle cx="30" cy="126" r="4" className="build-dot" />
      <circle cx="272" cy="30" r="3" className="build-dot" />
    </svg>
  );
}
