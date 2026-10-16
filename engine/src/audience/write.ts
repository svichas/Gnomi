// The persona writer: verbalized sampling (four candidates with probabilities, one picked by seed) restores diversity on API models (tech.md §2.4).
import { z } from 'zod';
import type { LlmRequest } from '../seams.ts';
import type { Persona, ProjectConfig, Segment, UsageFrequency } from '../types.ts';
import type { AudienceDeps } from './index.ts';
import { fnv1a, mulberry32, postingPropensity, type Traits } from './sample.ts';
import { getPersonaSchema, isAttributeEnabled, profileEntries } from '../profile/schema.ts';
import { profileSignature } from '../profile/signature.ts';
import { latin } from '../llm/english.ts';

const text = latin(z.string().trim().min(1));
const candidate = z.object({
  name: text,
  job_title: text,
  industry: text,
  background: text,
  context_of_use: text,
  goal_interpretation: text,
  voice: text,
  probability: z.number().min(0), // normalised when picking, so 0.4 and 40 both work
});
export const writeSchema = z.object({ candidates: z.array(candidate).length(4) });
const biographySchema = z.object({ background: text });
const namesSchema = z.object({ names: z.array(text).length(4) });
export type Candidate = z.infer<typeof candidate>;

// Lines the demo writer reads back; keep them in step with DEMO_PERSONA_WRITER.
export const TRAITS_LABEL = 'Sampled traits: ';
export const WRITTEN_LABEL = 'Written fields: ';
export const TAKEN_LABEL = 'Names already taken in this population, so choose others: ';
export const SELECTED_LABEL = 'Selected candidate: ';

export const WRITER_SYSTEM = `Gnomi simulates the people who use a product, so a product team can find usability problems before real users meet them. This step writes one person from traits that code has already sampled for them. The traits are fixed facts about the person: write someone they fit, and do not change, contradict or exaggerate them.

Write four different candidates for this person, each with a probability: how likely it is that a real person with exactly these traits, in this segment, is this candidate. The four probabilities sum to 1. Vary their active attributes, histories and ways of talking. Include realistic but less typical people, not only the most obvious one: a candidate with a low probability is welcome.

Each candidate has:
- name: a full name that fits the first language and the person's life, with the variety real names have; never a famous person or a placeholder. When a city and country are sampled, this person lives there.
- job_title: when listed in Written fields, a real title held by someone in this segment, respecting seniority only if supplied; otherwise "Not specified".
- industry: when listed in Written fields, the employer's specific industry; otherwise "Not specified".
- background: a compact sketch of 30 to 45 words in the first person: their history, a normal week and one frustration. Only the selected sketch will be expanded later. Use only the supplied prompt attributes; do not infer a value for an omitted attribute or reintroduce it through the biography, voice or context.
- context_of_use: when listed in Written fields, one sentence on when, where and on what device they meet the product this time; otherwise "Not specified".
- goal_interpretation: one or two sentences in the first person on how this person reads the task: what they think it asks, what they care about, and what done looks like to them.
- voice: one or two sentences on how they think and write: tone, length, the words they reach for, and the language they think in.

Rules:
- Only attributes in Sampled traits and Prompt attributes are available. Never infer omitted attributes in any output field. When pronouns are omitted, use neutral language. Output slots absent from Written fields remain "Not specified" and do not appear in the biography or voice.
- Each person is an individual, not a representative of a group. No stereotypes, no national, cultural, gender or disability caricature, and no demographic labels such as "as a woman" or "as a non-native speaker": the name, the situation and the voice carry who they are.
- Keep behaviour mild and grounded in the traits. Low patience means stopping sooner, not rudeness; low tech skill means working with what is on screen, not helplessness. Most people are reasonable and busy.
- A first language other than English shapes the name and the voice, not the quality of their English. Write every field in English, in Latin letters: a name from another script is romanized, as on a passport.
- They have not used this product yet: say nothing about its quality or its problems.`;

const FREQUENCY: Record<UsageFrequency, string> = {
  daily: 'every day',
  weekly: 'about once a week',
  monthly: 'about once a month',
  rarely: 'a few times a year',
  never: 'not yet: they are new to it',
};
const ENTRY: Record<Segment['entry'], string> = {
  direct: 'directly',
  email_link: 'from a link in an email',
  shared_link: 'from a link someone shared with them',
};
const ACCOUNT: Record<Segment['account_state'], string> = {
  empty: 'on a new, empty account',
  populated: 'on an account with history',
};

export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function writerUser(project: ProjectConfig, segment: Segment, traits: Traits, taken: string[] | null, seed?: number): string {
  const goals = segment.typical_goals.length ? ` People in this segment usually come to: ${segment.typical_goals.join('; ')}.` : '';
  const schema = getPersonaSchema(project.persona_schema);
  const entries = profileEntries({ ...traits, seed } as Persona, schema, 'prompt');
  const values = Object.fromEntries(entries.map(({ attribute, value }) => [attribute.id, value]));
  const descriptors = schema.attributes.filter((a) => a.enabled && a.use_in_prompt).map((a) => `${a.id} (${a.group}, ${a.type}): ${a.description}`);
  const ignored = ['job_title', 'industry', 'context_of_use'].filter((id) => !isAttributeEnabled(schema, id, 'prompt'));
  return [
    `The product: ${project.name}.${project.description ? ` ${project.description}` : ''}`,
    `Their segment: ${segment.name}. ${segment.description}`,
    `They use the product ${FREQUENCY[segment.usage_frequency]}, usually arriving ${ENTRY[segment.entry]}, ${ACCOUNT[segment.account_state]}.${goals}`,
    `The task they will attempt: "${segment.goal_override ?? project.goal}"`,
    '',
    `${TRAITS_LABEL}${JSON.stringify(values)}`,
    `${WRITTEN_LABEL}${JSON.stringify(['name', 'job_title', 'industry', 'background', 'context_of_use', 'goal_interpretation', 'voice'].filter((id) => isAttributeEnabled(schema, id, 'prompt')))}`,
    `Prompt attributes:\n${descriptors.join('\n')}`,
    ...(ignored.length ? [`These output slots are unused: ${ignored.join(', ')}. Set them to "Not specified" and do not infer or mention their values in other output fields.`] : []),
    ...(values.country || values.employer ? ['Keep the sampled location and employer fixed wherever provided; the biography, context and voice must agree with them. Languages are ordered preferences, with the first language used for thoughts.'] : []),
    ...(taken ? ['', `${TAKEN_LABEL}${JSON.stringify(taken)}`] : []),
  ].join('\n');
}

export const nameKey = (name: string) => name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/** The verbalized-sampling pick: weighted by the candidates' probabilities, drawn from the seed, skipping taken names. */
export function choose(candidates: Candidate[], seed: number, taken: { has(key: string): boolean }): Candidate | null {
  const open = candidates.filter((c) => !taken.has(nameKey(c.name)));
  const weights = open.map((c) => (c.probability > 0 ? c.probability : 0));
  const total = weights.reduce((s, w) => s + w, 0);
  let u = mulberry32(fnv1a(`pick/${seed}`))() * (total || open.length);
  for (let i = 0; i < open.length; i++) if ((u -= total ? weights[i] : 1) < 0) return open[i];
  return open.at(-1) ?? null;
}

export interface Job {
  id: string;
  segment: Segment;
  seed: number;
  traits: Traits;
}

export const BIOGRAPHY_SYSTEM = `Expand the selected person's sketch into a 150 to 200 word first-person biography. Return only background. Preserve their identity, history, job and voice; keep all sampled traits fixed. Use only supplied prompt attributes and respect omitted fields. Do not invent demographic attributes, stereotype, exaggerate behaviour or judge the product: they have not used it yet. Do not introduce a different name. Write in English, in Latin letters.`;
const NAMES_SYSTEM = `Suggest four different full names for the selected person, consistent with their supplied attributes. Avoid the taken names. Return only names, in Latin letters (romanized from another script); do not rewrite their profile or biography. No famous people, placeholders or stereotypes.`;

/**
 * Each persona is written as soon as its sketch is in and every earlier slot holds its name: names settle in job order,
 * so a deterministic writer always gives the same population. `taken` (nameKey → name) gains the new names.
 */
export async function writePersonas(jobs: Job[], taken: Map<string, string>, deps: AudienceDeps): Promise<{ personas: Persona[]; cost_usd: number }> {
  let concurrency = deps.project.settings.persona_concurrency ?? 32;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Persona concurrency must be a whole number from 1 to 32.');
  const stop = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, stop.signal]) : stop.signal;
  let cost_usd = 0;

  // One pool of model calls. A started persona's rename and biography go before the next sketch, so people finish early.
  let active = 0;
  const queues: (() => void)[][] = [[], []];
  const slot = (priority: 0 | 1) => new Promise<void>((resolve) => {
    if (active < concurrency) { active++; resolve(); } else queues[priority].push(resolve);
  });
  const release = () => {
    const next = active <= concurrency ? (queues[0].shift() ?? queues[1].shift()) : undefined; // over a lowered limit, shrink
    if (next) next(); else active--;
  };

  const ask = async <T>(job: Job, purpose: string, schema: z.ZodType<T>, system: string, extra = '', avoid: string[] | null = null, max_output_tokens = 3072): Promise<T> => {
    try {
      signal.throwIfAborted();
      const req: LlmRequest<T> = {
        role: 'persona_writer',
        model: deps.model,
        run_id: null,
        persona_id: job.id,
        round: 0,
        purpose,
        system,
        user: [{ type: 'text', text: writerUser(deps.project, job.segment, job.traits, avoid, job.seed) + extra }],
        schema,
        signal,
        max_output_tokens,
        timeout_ms: 120_000,
        onAttempt: (attempt) => {
          if (attempt.payload.http_status === 429) concurrency = Math.max(1, Math.floor(concurrency / 2));
          deps.onAttempt?.(req, attempt);
        },
      };
      // Exact model-visible inputs key every stage. Changing prompts, traits, goals or models invalidates it.
      const key = JSON.stringify([job.id, job.seed, req.model, deps.project.settings.local_base_url, purpose, system, req.user, z.toJSONSchema(schema)]);
      const cached = schema.safeParse(deps.cache?.get(key));
      if (cached.success) return cached.data;
      await slot(purpose === 'write_persona' ? 1 : 0);
      try {
        signal.throwIfAborted();
        const { object, cost_usd: cost } = await deps.llm.call(req);
        cost_usd += cost;
        deps.cache?.set(key, object);
        return object;
      } finally {
        setImmediate(release); // once this answer's next stage is queued, so it takes the slot ahead of a new sketch
      }
    } catch (err) {
      if (signal.aborted) throw signal.reason; // the user's abort, or the first failure, which stops every other write
      const reason = err instanceof Error ? err.message : String(err);
      const error = new Error(`The persona writer failed on ${job.id} (${job.segment.name}): ${reason}. ${deps.cache ? 'Completed drafts are saved; try again to resume.' : 'No population was returned.'}`, { cause: err });
      stop.abort(error);
      throw error;
    }
  };

  let done = 0, sketched = 0;
  // The furthest stage any persona has reached; they overlap now, so the label only moves forward.
  const STAGES = ['sketching', 'repairing_names', 'writing'] as const;
  let reached = -1;
  const stage = (s: (typeof STAGES)[number]) => { if (STAGES.indexOf(s) > reached) { reached = STAGES.indexOf(s); deps.onStage?.(s); } };
  if (jobs.length) { deps.onProgress?.(0, jobs.length); stage('sketching'); }

  const keep = (c: Candidate) => { taken.set(nameKey(c.name), c.name); return c; };
  const personas: Persona[] = [];
  let named: Promise<unknown> = Promise.resolve();
  const work = jobs.map((job, i) => {
    const draft = ask(job, 'write_persona', writeSchema, WRITER_SYSTEM).then(({ candidates }) => { deps.onSketched?.(++sketched); return candidates; });
    // Each slot chooses only after the slot before it, and a clash is renamed against every name settled so far.
    const selected = Promise.all([draft, named]).then(async ([drafts]) => {
      const picked = choose(drafts, job.seed, taken);
      if (picked) return keep(picked);
      stage('repairing_names');
      const c = choose(drafts, job.seed, new Set())!;
      const result = await ask(job, 'rename_persona', namesSchema, NAMES_SYSTEM, `\n${SELECTED_LABEL}${JSON.stringify(c)}`, [...taken.values()], deps.model.provider === 'deepseek' ? 256 : 1024);
      const repaired = result.names.map((name) => ({ ...c, name }));
      return keep(choose(repaired, job.seed, taken) ?? choose(repaired, job.seed, new Set())!);
    });
    named = selected;
    return selected.then(async (c) => {
      stage('writing');
      const expanded = await ask(job, 'expand_persona', biographySchema, BIOGRAPHY_SYSTEM, `\n${SELECTED_LABEL}${JSON.stringify(c)}`, null, deps.model.provider === 'deepseek' ? 1024 : 2048);
      personas[i] = {
        id: job.id,
        ...job.traits,
        name: c.name,
        job_title: c.job_title,
        industry: c.industry,
        background: expanded.background,
        context_of_use: c.context_of_use,
        goal_interpretation: c.goal_interpretation,
        voice: c.voice,
        seed: job.seed,
        posting_propensity: postingPropensity(job.seed),
        profile_signature: profileSignature(deps.project, job.segment, job.seed),
      };
      deps.onProgress?.(++done, jobs.length, personas[i]);
    });
  });
  const failed = (await Promise.allSettled(work)).find((r) => r.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return { personas, cost_usd };
}
