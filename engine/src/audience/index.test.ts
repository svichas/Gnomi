import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidOutputError } from '../llm/gateway.ts';
import type { LlmGateway, LlmRequest, LlmResult, Responder } from '../seams.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { Audience, Persona, ProjectConfig } from '../types.ts';
import { addPersona, DEMO_PERSONA_WRITER, defaultAudience, diversityReport, proposeAudience, regeneratePersona, syncPersonas, type AudienceDeps } from './index.ts';
import { addedSeed, GENERATION, postingPropensity, sampleTraits, TRAIT_KEYS } from './sample.ts';
import { choose, nameKey, TAKEN_LABEL, type Candidate } from './write.ts';
import { getPersonaSchema } from '../profile/schema.ts';
import { personaProfileIsCurrent } from '../profile/signature.ts';

const project: ProjectConfig = {
  name: 'Gym ATS',
  description: 'An applicant tracking system for companies with 50–2,000 employees.',
  pois: [{ id: 'poi-1', type: 'web', name: 'Gym ATS staging', start_url: 'http://gym.test/', allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null, mode: 'full', segments: null }],
  goal: 'Create your first job post',
  role: 'recruiter',
  audience: null,
  settings: DEFAULT_SETTINGS,
};
const MODEL = { provider: 'anthropic', model: 'claude-sonnet-5-5' } as const;

/** Counts gateway calls; like the real gateway, retries once on invalid output, then throws InvalidOutputError. */
function gateway(responder: Responder = DEMO_PERSONA_WRITER) {
  const calls: LlmRequest<unknown>[] = [];
  const llm: LlmGateway = {
    async call<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      calls.push(req as LlmRequest<unknown>);
      await Promise.resolve();
      req.signal?.throwIfAborted();
      for (let attempt = 1; ; attempt++) {
        const parsed = req.schema.safeParse(responder(req as LlmRequest<unknown>));
        if (parsed.success) return { object: parsed.data, cost_usd: 0.01 };
        if (attempt === 2) throw new InvalidOutputError(`Invalid output twice: ${parsed.error.message}`);
      }
    },
  };
  return { llm, calls };
}

const deps = (llm: LlmGateway, extra: Partial<AudienceDeps> = {}): AudienceDeps => ({ llm, model: MODEL, project, roles: ['recruiter', 'hiring_manager'], ...extra });
const textOf = (req: LlmRequest<unknown>) => req.user.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
const ids = (personas: Persona[]) => personas.map((p) => p.id);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// The demo proposal: 60/30/10, which 20 personas split 11/6/3.
async function proposed(persona_count = 20): Promise<Audience> {
  return { ...(await proposeAudience(deps(gateway().llm))).audience, persona_count };
}
const withShares = (audience: Audience, shares: number[]): Audience => ({ ...audience, segments: audience.segments.map((s, i) => ({ ...s, share: shares[i] })) });

test('the default audience is one segment for everyone, with distributions the user can see', () => {
  const audience = defaultAudience(project);
  assert.deepEqual(audience, defaultAudience(project));
  assert.equal(audience.persona_count, 50);
  assert.deepEqual(audience.company_size, [50, 2000]);
  assert.equal(audience.segments.length, 1);
  assert.equal(audience.segments[0].share, 100);
  assert.equal(audience.segments[0].role, 'recruiter');
  const sum = (d: Record<string, number>) => Object.values(d).reduce((s, n) => s + n, 0);
  assert.ok(near(sum(audience.languages), 1) && near(sum(audience.accessibility), 1));
  assert.ok(near(1 - audience.languages.en, 0.15), 'about 15% think in another first language');
  assert.ok(near(1 - audience.accessibility.none, 0.14), 'about 14% have an accessibility need');
  for (const need of ['low_vision', 'colour_blind', 'screen_reader', 'motor'] as const) assert.ok(audience.accessibility[need] > 0, need);
});

test('a proposal is one persona_writer setup call; what the model does not decide comes from the default', async () => {
  const { llm, calls } = gateway();
  const { audience, cost_usd } = await proposeAudience(deps(llm));
  assert.equal(calls.length, 1);
  const [req] = calls;
  assert.deepEqual([req.role, req.run_id, req.purpose, req.model, req.persona_id], ['persona_writer', null, 'propose_audience', MODEL, null]);
  assert.match(textOf(req), /Gym ATS\. An applicant tracking system/);
  assert.match(textOf(req), /Gym ATS staging/);
  assert.match(textOf(req), /"Create your first job post"/);
  assert.match(textOf(req), /Recorded logins: \["recruiter","hiring_manager"\]/);
  assert.match(req.system, /not only power users/);
  assert.match(req.system, /never by demographics/);
  assert.deepEqual(audience.segments.map((s) => [s.id, s.share, s.role]), [['seg-1', 60, 'recruiter'], ['seg-2', 30, 'hiring_manager'], ['seg-3', 10, null]]);
  assert.deepEqual({ ...audience, segments: [] }, { ...defaultAudience(project), segments: [] });
  assert.equal(cost_usd, 0.01);
});

test('proposed shares are renormalised to whole percents summing to exactly 100', async () => {
  const demo = (req: LlmRequest<unknown>) => DEMO_PERSONA_WRITER(req) as { segments: Record<string, unknown>[] };
  const reshare = (shares: number[]): Responder => (req) => ({ segments: demo(req).segments.map((s, i) => ({ ...s, share: shares[i], patience_min: 4, patience_max: 2 })) });
  const a = await proposeAudience(deps(gateway(reshare([50, 30, 30])).llm));
  assert.deepEqual(a.audience.segments.map((s) => s.share), [46, 27, 27]);
  assert.deepEqual(a.audience.segments[0].patience, [2, 4], 'a reversed range is put in order');
  const b = await proposeAudience(deps(gateway(reshare([0.6, 0.3, 0.1])).llm));
  assert.deepEqual(b.audience.segments.map((s) => s.share), [60, 30, 10]);
  const c = await proposeAudience(deps(gateway(reshare([99.5, 0.3, 0.2])).llm));
  assert.deepEqual(c.audience.segments.map((s) => s.share), [98, 1, 1], 'every proposed segment keeps a share');
});

test('an invalid proposal is rejected after the gateway retry, including a role that is not a recorded login', async () => {
  const demo = (req: LlmRequest<unknown>) => DEMO_PERSONA_WRITER(req) as { segments: Record<string, unknown>[] };
  const cases: Responder[] = [
    (req) => ({ segments: demo(req).segments.slice(0, 2) }),
    (req) => ({ segments: demo(req).segments.map((s) => ({ ...s, role: 'admin' })) }),
    (req) => ({ segments: demo(req).segments.map((s) => ({ ...s, patience_max: 7 })) }),
  ];
  for (const responder of cases) {
    const { llm, calls } = gateway(responder);
    await assert.rejects(proposeAudience(deps(llm)), (err: Error) => {
      assert.match(err.message, /^The persona writer could not propose an audience: Invalid output twice/);
      assert.ok(err.cause instanceof InvalidOutputError);
      return true;
    });
    assert.equal(calls.length, 1);
  }
  // With no recorded login at all, every segment browses logged out.
  const none = await proposeAudience(deps(gateway().llm, { roles: [], project: { ...project, role: null } }));
  assert.ok(none.audience.segments.every((s) => s.role === null));
  await assert.rejects(proposeAudience(deps(gateway((req) => ({ segments: demo(req).segments.map((s) => ({ ...s, role: 'recruiter' })) })).llm, { roles: [] })));
});

test('the first sync sketches and expands each persona; an unchanged second sync makes no call; the same seed gives the same personas', async () => {
  const audience = await proposed();
  const { llm, calls } = gateway();
  const progress: [number, number][] = [];
  const first = await syncPersonas(audience, [], deps(llm, { onProgress: (done, total) => progress.push([done, total]) }));
  assert.equal(first.personas.length, 20);
  assert.equal(calls.length, 40);
  assert.ok(near(first.cost_usd, 0.4));
  assert.deepEqual(progress[0], [0, 20]);
  assert.deepEqual(progress.at(-1), [20, 20]);
  assert.deepEqual(
    ['seg-1', 'seg-2', 'seg-3'].map((id) => first.personas.filter((p) => p.segment_id === id).length),
    [11, 6, 3],
  );
  assert.deepEqual(ids(first.personas).slice(9, 13), ['p-seg1-10', 'p-seg1-11', 'p-seg2-01', 'p-seg2-02']);
  for (const req of calls) assert.deepEqual([req.role, req.run_id, req.model], ['persona_writer', null, MODEL]);
  for (const purpose of ['write_persona', 'expand_persona']) assert.deepEqual(calls.filter((req) => req.purpose === purpose).map((req) => req.persona_id).sort(), ids(first.personas).sort());
  for (const p of first.personas) {
    const segment = audience.segments.find((s) => s.id === p.segment_id)!;
    const traits = sampleTraits(segment, audience, p.seed);
    for (const k of TRAIT_KEYS) assert.deepEqual(p[k], traits[k], `${p.id} ${k} is sampled, not written`);
  }

  const again = gateway();
  const second = await syncPersonas(audience, first.personas, deps(again.llm));
  assert.equal(again.calls.length, 0);
  assert.deepEqual(second, { personas: first.personas, cost_usd: 0 });

  const fresh = await syncPersonas(structuredClone(audience), [], deps(gateway().llm));
  assert.deepEqual(fresh.personas, first.personas);

  const reseeded = gateway();
  const other = await syncPersonas({ ...audience, seed: 2 }, first.personas, deps(reseeded.llm));
  assert.equal(reseeded.calls.length, 40, 'a new audience seed re-samples everyone');
  assert.deepEqual(ids(other.personas), ids(first.personas));
  assert.ok(other.personas.every((p, i) => p.seed !== first.personas[i].seed));
});

test('small audiences generate the requested count even with five active segments', async () => {
  const base = defaultAudience(project);
  const segments = [10, 50, 20, 15, 5].map((share, i) => ({ ...base.segments[0], id: `seg-${i + 1}`, share }));
  for (const persona_count of [1, 2, 4, 5, 6, 9, 10, 14, 15]) {
    const { llm, calls } = gateway();
    const progress: [number, number][] = [];
    const result = await syncPersonas({ ...base, segments, persona_count }, [], deps(llm, { onProgress: (done, total) => progress.push([done, total]) }));
    assert.equal(result.personas.length, persona_count);
    assert.deepEqual(progress.at(-1), [persona_count, persona_count]);
    if (persona_count === 1) {
      assert.equal(result.personas[0].segment_id, 'seg-2', 'the largest share gets the single slot');
      assert.deepEqual(calls.map((call) => call.purpose), ['write_persona', 'expand_persona']);
    }
    if (persona_count >= segments.length) assert.ok(segments.every((s) => result.personas.some((p) => p.segment_id === s.id)));
  }
});

test('reducing fifteen personas to one reuses the retained profile without another model call', async () => {
  const base = defaultAudience(project);
  const audience = { ...base, persona_count: 15, segments: Array.from({ length: 5 }, (_, i) => ({ ...base.segments[0], id: `seg-${i + 1}`, share: 20 })) };
  const first = await syncPersonas(audience, [], deps(gateway().llm));
  assert.equal(first.personas.length, 15);
  const { llm, calls } = gateway();
  const single = await syncPersonas({ ...audience, persona_count: 1 }, first.personas, deps(llm));
  assert.deepEqual(single.personas, [first.personas[0]], 'ties go to the first segment deterministically');
  assert.equal(calls.length, 0);
  assert.equal(single.cost_usd, 0);
});

test('written personas carry a posting propensity sampled from their seed, mostly low, that moves no other trait', async () => {
  const audience = await proposed();
  const { personas } = await syncPersonas(audience, [], deps(gateway().llm));
  for (const p of personas) assert.equal(p.posting_propensity, postingPropensity(p.seed));
  const sample = Array.from({ length: 1_000 }, (_, i) => postingPropensity(i));
  assert.ok(sample.every((x) => x >= 0 && x <= 1 && Number(x.toFixed(2)) === x));
  assert.ok(sample.filter((x) => x < 0.5).length > 700, 'most personas rarely post');
  assert.ok(sample.some((x) => x > 0.8), 'a few post readily');
  assert.ok(personas.every((p) => personaProfileIsCurrent(p, { ...project, audience })), 'it is not a writer input, so profiles stay current');
});

test('country and employer traits reach the writer, survive persistence, and sync without another model call', async () => {
  const original = await proposed();
  const audience: Audience = { ...original, countries: { DE: 100 }, segments: original.segments.map((s) => ({ ...s, employers: ['Northwind'] })) };
  const { llm, calls } = gateway();
  const first = await syncPersonas(audience, [], deps(llm));
  assert.ok(first.personas.every((p) => p.country === 'DE' && p.city === 'Berlin' && p.timezone === 'Europe/Berlin' && p.language === 'de-DE' && p.employer === 'Northwind'));
  assert.deepEqual(first.personas[0].languages, ['de-DE', 'en']);
  assert.match(textOf(calls[0]), /"country":"DE"/);
  assert.match(textOf(calls[0]), /"employer":"Northwind"/);
  assert.match(textOf(calls[0]), /Keep the sampled location and employer/);
  assert.match(first.personas[0].background, /Northwind/);
  assert.match(first.personas[0].background, /Berlin/);

  const second = gateway();
  const synced = await syncPersonas(audience, structuredClone(first.personas), deps(second.llm));
  assert.deepEqual(synced.personas, first.personas);
  assert.equal(second.calls.length, 0, 'equal language arrays from disk do not force another write');

  const changed = gateway();
  const greek = await syncPersonas({ ...audience, countries: { GR: 100 } }, first.personas, deps(changed.llm));
  assert.equal(changed.calls.length, first.personas.length * 2);
  assert.ok(greek.personas.every((p) => p.country === 'GR' && p.language === 'el-GR' && p.employer === 'Northwind'));
});

test('an invalid country distribution is rejected before the writer can spend even with no active segment', async () => {
  const { llm, calls } = gateway();
  const audience = { ...await proposed(), countries: { DE: 0 }, segments: [] };
  await assert.rejects(syncPersonas(audience, [], deps(llm)), /country/i);
  assert.equal(calls.length, 0);
});

test('writer signatures refresh changed goals and prompt attributes but preserve metadata-only edits', async () => {
  const audience = await proposed();
  const config = { ...project, audience, persona_schema: getPersonaSchema() };
  const first = await syncPersonas(audience, [], deps(gateway().llm, { project: config }));
  assert.ok(first.personas.every((p) => personaProfileIsCurrent(p, config)));
  const reseeded = { ...config, audience: { ...audience, seed: audience.seed + 1 } };
  assert.ok(first.personas.every((p) => !personaProfileIsCurrent(p, reseeded)), 'stored persona seeds must belong to the current audience seed');
  const changed = { ...config, goal: 'Review applicants instead of creating a job' };
  assert.ok(first.personas.every((p) => !personaProfileIsCurrent(p, changed)));
  const writer = gateway();
  const refreshed = await syncPersonas(audience, first.personas, deps(writer.llm, { project: changed }));
  assert.equal(writer.calls.length, first.personas.length * 2);
  assert.ok(refreshed.personas.every((p) => personaProfileIsCurrent(p, changed)));
  const metadata = structuredClone(changed);
  metadata.persona_schema.attributes.forEach((a) => { a.show_on_card = !a.show_on_card; a.report_dimension = !a.report_dimension; });
  metadata.audience.segments[0].role = 'a_different_recorded_login';
  const quiet = gateway();
  await syncPersonas(metadata.audience, refreshed.personas, deps(quiet.llm, { project: metadata }));
  assert.equal(quiet.calls.length, 0);
  metadata.persona_schema.attributes.find((a) => a.id === 'employer')!.enabled = false;
  assert.ok(!personaProfileIsCurrent(refreshed.personas[0], metadata));
  metadata.persona_schema.attributes[0].name = '';
  assert.equal(personaProfileIsCurrent(refreshed.personas[0], metadata), false, 'temporarily invalid editor drafts hide stale prose instead of throwing');
});

test('disabled and prompt-private fields stay out of writer requests and do not leak from the demo biography', async () => {
  const audience = await proposed();
  audience.segments = audience.segments.map((s) => ({ ...s, employers: ['HIDDEN_EMPLOYER'] }));
  const schema = getPersonaSchema();
  schema.attributes.find((a) => a.id === 'employer')!.enabled = false;
  schema.attributes.find((a) => a.id === 'pronouns')!.use_in_prompt = false;
  schema.attributes.push({ id: 'private_note', name: 'Private note', group: 'work', type: 'text', description: 'Visible only on cards.', core: false, enabled: true, show_on_card: true, use_in_prompt: false, report_dimension: true, sampling: { default: { kind: 'fixed', value: 'HIDDEN_NOTE' }, by_segment: {} } });
  const { llm, calls } = gateway();
  const config = { ...project, audience, persona_schema: schema };
  const result = await syncPersonas(audience, [], deps(llm, { project: config }));
  assert.ok(result.personas.every((p) => p.attributes?.private_note === 'HIDDEN_NOTE'));
  for (const req of calls) {
    assert.doesNotMatch(JSON.stringify(req.user), /HIDDEN_EMPLOYER|HIDDEN_NOTE|"pronouns"/);
  }
  assert.ok(result.personas.every((p) => !p.background.includes('HIDDEN_EMPLOYER') && !p.background.includes('HIDDEN_NOTE')));
  const updated = structuredClone(config);
  updated.persona_schema.attributes.find((a) => a.id === 'private_note')!.sampling!.default = { kind: 'fixed', value: 'UPDATED_PRIVATE' };
  assert.ok(result.personas.every((p) => !personaProfileIsCurrent(p, updated)), 'a run must not freeze outdated private samples under the changed schema');
  const quiet = gateway();
  const second = await syncPersonas(audience, result.personas, deps(quiet.llm, { project: updated }));
  assert.equal(quiet.calls.length, 0, 'private data updates do not rewrite the biography');
  assert.ok(second.personas.every((p) => p.attributes?.private_note === 'UPDATED_PRIVATE'));
  assert.ok(second.personas.every((p, i) => p.background === result.personas[i].background && personaProfileIsCurrent(p, updated)));
});

test('50 generated personas reproduce weighted custom choices for two segment overrides within three binomial standard deviations', async () => {
  const original = await proposed(50);
  const audience = { ...original, segments: original.segments.slice(0, 2).map((segment) => ({ ...segment, share: 50 })) };
  const schema = getPersonaSchema();
  const weighted = (probability: number) => ({ kind: 'choices' as const, choices: [{ value: 'A', weight: probability }, { value: 'B', weight: 1 - probability }] });
  schema.attributes.push({
    id: 'preferred_workflow', name: 'Preferred workflow', description: 'Which workflow this person prefers.', group: 'work', type: 'choice',
    core: false, enabled: true, show_on_card: true, use_in_prompt: true, report_dimension: true, choices: ['A', 'B'],
    sampling: { default: weighted(0.5), by_segment: { [audience.segments[0].id]: weighted(0.8), [audience.segments[1].id]: weighted(0.2) } },
  });
  const config = { ...project, audience, persona_schema: schema };
  const first = (await syncPersonas(audience, [], deps(gateway().llm, { project: config }))).personas;
  assert.equal(first.length, 50);
  for (const [index, probability] of [0.8, 0.2].entries()) {
    const segment = first.filter((person) => person.segment_id === audience.segments[index].id);
    assert.equal(segment.length, 25);
    const observed = segment.filter((person) => person.attributes?.preferred_workflow === 'A').length;
    // Sampling is probabilistic: accept ±3σ of Binomial(n, p), about a 99.7% normal-reference interval.
    const tolerance = 3 * Math.sqrt(segment.length * probability * (1 - probability));
    assert.ok(Math.abs(observed - segment.length * probability) <= tolerance, `${audience.segments[index].id}: ${observed}/25 vs ${probability * 100}% ± ${(tolerance / segment.length * 100).toFixed(1)} percentage points`);
  }
  const repeated = (await syncPersonas(structuredClone(audience), [], deps(gateway().llm, { project: structuredClone(config) }))).personas;
  assert.deepEqual(repeated, first, 'same audience seed, schema, and segment rules reproduce the complete population');
});

test('changing one share rewrites only the slots it adds and drops the slots it removes', async () => {
  const audience = await proposed();
  const before = (await syncPersonas(audience, [], deps(gateway().llm))).personas;
  const { llm, calls } = gateway();
  const after = (await syncPersonas(withShares(audience, [70, 20, 10]), before, deps(llm))).personas;
  assert.deepEqual(
    ['seg-1', 'seg-2', 'seg-3'].map((id) => after.filter((p) => p.segment_id === id).length),
    [13, 4, 3],
  );
  assert.deepEqual(calls.map((req) => req.persona_id), ['p-seg1-12', 'p-seg1-13', 'p-seg1-12', 'p-seg1-13']);
  assert.ok(!after.some((p) => p.id === 'p-seg2-05' || p.id === 'p-seg2-06'));
  for (const p of after) if (before.some((b) => b.id === p.id)) assert.deepEqual(p, before.find((b) => b.id === p.id));
});

test('a removed segment drops its personas, and editing a distribution rewrites only the personas it changes', async () => {
  const audience = await proposed();
  const before = (await syncPersonas(audience, [], deps(gateway().llm))).personas;

  const removed = gateway();
  const two = (await syncPersonas({ ...audience, segments: audience.segments.slice(0, 2) }, before, deps(removed.llm))).personas;
  assert.ok(!two.some((p) => p.segment_id === 'seg-3'));
  assert.equal(two.length, 20);
  const added = two.filter((p) => !before.some((b) => b.id === p.id));
  assert.deepEqual(removed.calls.map((req) => req.persona_id), [...ids(added), ...ids(added)]);

  const edited: Audience = { ...audience, segments: audience.segments.map((s, i) => (i === 0 ? { ...s, mobile_share: 0.6 } : s)) };
  const flipped = before.filter((p) => p.device !== sampleTraits(edited.segments[0], edited, p.seed).device && p.segment_id === 'seg-1');
  assert.ok(flipped.length > 0);
  const device = gateway();
  const after = (await syncPersonas(edited, before, deps(device.llm))).personas;
  assert.deepEqual(device.calls.map((req) => req.persona_id), [...ids(flipped), ...ids(flipped)]);
  assert.ok(after.every((p, i) => p.id === before[i].id && (flipped.some((f) => f.id === p.id) ? p.device !== before[i].device : p === before[i])));
});

test('a regenerated persona keeps its id, moves its seed one generation, and survives the next sync', async () => {
  const audience = await proposed();
  const population = (await syncPersonas(audience, [], deps(gateway().llm))).personas;
  const old = population[3];
  const { llm, calls } = gateway();
  const { persona, cost_usd } = await regeneratePersona(old, audience, population, deps(llm));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].persona_id, old.id);
  assert.equal(cost_usd, 0.02);
  assert.equal(persona.id, old.id);
  assert.equal(persona.seed, old.seed + GENERATION);
  assert.equal(personaProfileIsCurrent(persona, { ...project, audience }), true, 'regenerated seeds still belong to the audience');
  assert.notDeepEqual(persona, old);
  assert.ok(!population.some((p) => p.id !== old.id && nameKey(p.name) === nameKey(persona.name)));

  const next = population.map((p) => (p.id === old.id ? persona : p));
  const sync = gateway();
  assert.deepEqual((await syncPersonas(audience, next, deps(sync.llm))).personas, next);
  assert.equal(sync.calls.length, 0);
  assert.equal((await regeneratePersona(persona, audience, next, deps(gateway().llm))).persona.seed, old.seed + 2 * GENERATION);
});

test('an added persona takes the next free slot, survives syncs and share changes, and leaves with its segment', async () => {
  const audience = await proposed();
  const population = (await syncPersonas(audience, [], deps(gateway().llm))).personas;
  const { llm, calls } = gateway();
  const { persona } = await addPersona('seg-1', audience, population, deps(llm));
  assert.equal(calls.length, 2);
  assert.equal(persona.id, 'p-seg1-12');
  assert.equal(persona.seed, addedSeed(audience.seed, 'seg-1', 11));
  assert.equal(personaProfileIsCurrent(persona, { ...project, audience }), true, 'manually added slots remain current');
  const withExtra = [...population, persona];

  const same = gateway();
  const kept = (await syncPersonas(audience, withExtra, deps(same.llm))).personas;
  assert.equal(same.calls.length, 0);
  assert.equal(kept.length, 21);
  assert.deepEqual(kept.find((p) => p.id === persona.id), persona);

  const grown = gateway();
  const after = (await syncPersonas(withShares(audience, [70, 20, 10]), kept, deps(grown.llm))).personas;
  assert.deepEqual(grown.calls.map((req) => req.persona_id), ['p-seg1-13', 'p-seg1-14', 'p-seg1-13', 'p-seg1-14'], 'the share grows around the added slot');
  assert.equal(after.filter((p) => p.segment_id === 'seg-1').length, 14);
  assert.deepEqual(after.find((p) => p.id === persona.id), persona);

  const gone = (await syncPersonas({ ...audience, segments: audience.segments.slice(1) }, after, deps(gateway().llm))).personas;
  assert.ok(!gone.some((p) => p.segment_id === 'seg-1'));
  await assert.rejects(addPersona('seg-9', audience, population, deps(gateway().llm)), /no segment "seg-9"/);
});

test('names are unique across 200 personas, and the demo population passes the diversity check', async () => {
  const big = (await syncPersonas(await proposed(200), [], deps(gateway().llm))).personas;
  assert.equal(new Set(big.map((p) => nameKey(p.name))).size, 200);
  assert.deepEqual(diversityReport(big).duplicate_names, []);
  const demo = (await syncPersonas(defaultAudience(project), [], deps(gateway().llm))).personas;
  assert.equal(diversityReport(demo).warning, null);
});

test('when every candidate name is taken the writer is asked once more, with the names to avoid', async () => {
  const audience = await proposed();
  const population = (await syncPersonas(audience, [], deps(gateway().llm))).personas;
  const taken = population[0].name;
  const variants = [taken, taken.toUpperCase(), ` ${taken} `, taken.replace(' ', '  ')];
  const clash = (always: boolean): Responder => (req) => {
    if (req.purpose === 'expand_persona') return DEMO_PERSONA_WRITER(req);
    if (req.purpose === 'rename_persona') return always ? { names: variants } : DEMO_PERSONA_WRITER(req);
    const out = DEMO_PERSONA_WRITER(req) as { candidates: Candidate[] };
    const reasked = textOf(req).includes(TAKEN_LABEL);
    return reasked && !always ? out : { candidates: out.candidates.map((c, i) => ({ ...c, name: variants[i] })) };
  };

  const once = gateway(clash(false));
  const { persona } = await addPersona('seg-2', audience, population, deps(once.llm));
  assert.equal(once.calls.length, 3);
  assert.equal(once.calls[1].purpose, 'rename_persona', 'a collision repairs only the name');
  assert.ok(!textOf(once.calls[0]).includes(TAKEN_LABEL));
  assert.ok(textOf(once.calls[1]).includes(`${TAKEN_LABEL}[`) && textOf(once.calls[1]).includes(JSON.stringify(taken)));
  assert.notEqual(nameKey(persona.name), nameKey(taken));

  // A clash that survives the re-ask stays, and the diversity check names it rather than the whole population failing.
  const twice = gateway(clash(true));
  const stuck = (await addPersona('seg-2', audience, population, deps(twice.llm))).persona;
  assert.equal(twice.calls.length, 3);
  assert.deepEqual(diversityReport([...population, stuck]).duplicate_names, [taken]);
});

test('verbalized sampling picks by probability, the same way for the same seed', () => {
  const base = { job_title: 'x', industry: 'x', background: 'x', context_of_use: 'x', goal_interpretation: 'x', voice: 'x' };
  const candidates: Candidate[] = [0.4, 0.3, 0.2, 0.1].map((probability, i) => ({ ...base, name: 'ABCD'[i], probability }));
  const none = new Set<string>();
  const counts = (cs: Candidate[], taken: Set<string> = none) => {
    const n: Record<string, number> = {};
    for (let seed = 0; seed < 4000; seed++) {
      const name = choose(cs, seed, taken)!.name;
      n[name] = (n[name] ?? 0) + 1 / 4000;
    }
    return n;
  };
  for (let seed = 0; seed < 50; seed++) assert.equal(choose(candidates, seed, none)?.name, choose(structuredClone(candidates), seed, none)?.name);
  const share = counts(candidates);
  ['A', 'B', 'C', 'D'].forEach((name, i) => assert.ok(Math.abs(share[name] - [0.4, 0.3, 0.2, 0.1][i]) < 0.03, `${name}: ${share[name]}`));

  const percent = candidates.map((c) => ({ ...c, probability: c.probability * 100 }));
  for (let seed = 0; seed < 200; seed++) assert.equal(choose(percent, seed, none)?.name, choose(candidates, seed, none)?.name);

  const skipA = counts(candidates, new Set(['a']));
  assert.equal(skipA.A, undefined);
  assert.ok(Math.abs(skipA.B - 0.5) < 0.04, 'the remaining probabilities are renormalised');
  assert.equal(choose(candidates, 1, new Set(['a', 'b', 'c', 'd'])), null);
  const flat = counts(candidates.map((c) => ({ ...c, probability: 0 })));
  for (const name of ['A', 'B', 'C', 'D']) assert.ok(Math.abs(flat[name] - 0.25) < 0.03, 'no probabilities: uniform');
});

test('a second invalid answer surfaces as a clear error, stops the other writes, and returns no population', async () => {
  const audience = await proposed();
  const { llm, calls } = gateway((req) => (req.persona_id === 'p-seg1-05' ? { candidates: [] } : DEMO_PERSONA_WRITER(req)));
  const twelve = { ...project, settings: { ...project.settings, persona_concurrency: 12 } };
  await assert.rejects(syncPersonas(audience, [], deps(llm, { project: twelve })), (err: Error) => {
    assert.match(err.message, /^The persona writer failed on p-seg1-05 \(Everyday users\): Invalid output twice/);
    assert.ok(err.cause instanceof InvalidOutputError);
    return true;
  });
  assert.ok(calls.length < 20, `stopped after ${calls.length} calls`);
});

test('an abort stops the sync with its reason, and the default pool allows thirty-two writes in flight', async () => {
  const audience = await proposed();
  const stop = new AbortController();
  stop.abort();
  const aborted = gateway();
  await assert.rejects(syncPersonas(audience, [], deps(aborted.llm, { signal: stop.signal })), { name: 'AbortError' });
  assert.equal(aborted.calls.length, 0);

  let active = 0;
  let peak = 0;
  const slow: LlmGateway = {
    async call<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return { object: req.schema.parse(DEMO_PERSONA_WRITER(req as LlmRequest<unknown>)), cost_usd: 0 };
    },
  };
  await syncPersonas({ ...audience, persona_count: 40 }, [], deps(slow));
  assert.equal(peak, 32);
  await assert.rejects(syncPersonas({ ...audience, persona_count: 201 }, [], deps(slow)), /persona_count must be a whole number from 1 to 200/);
});
