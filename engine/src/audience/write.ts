// The persona writer: verbalized sampling (four candidates with probabilities, one picked by seed) restores diversity on API models (tech.md §2.4).
import { z } from 'zod';
import type { LlmRequest } from '../seams.ts';
import type { Persona, ProjectConfig, Segment, UsageFrequency } from '../types.ts';
import type { AudienceDeps } from './index.ts';
import { fnv1a, mulberry32, type Traits } from './sample.ts';

const text = z.string().trim().min(1);
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
export type Candidate = z.infer<typeof candidate>;

// Lines the demo writer reads back; keep them in step with DEMO_PERSONA_WRITER.
export const TRAITS_LABEL = 'Sampled traits: ';
export const TAKEN_LABEL = 'Names already taken in this population, so choose others: ';

export const WRITER_SYSTEM = `Gnomi simulates the people who use a product, so a product team can find usability problems before real users meet them. This step writes one person from traits that code has already sampled for them. The traits are fixed facts about the person: write someone they fit, and do not change, contradict or exaggerate them.

Write four different candidates for this person, each with a probability: how likely it is that a real person with exactly these traits, in this segment, is this candidate. The four probabilities sum to 1. Make the candidates genuinely different from each other (name, job, the employer's industry, history, situation, way of talking), and include realistic but less typical people, not only the most obvious one: a candidate with a low probability is welcome.

Each candidate has:
- name: a full name that fits the first language, the pronouns and where such a person plausibly lives, with the variety real names have; never a famous person or a placeholder.
- job_title: a real title held by someone in this segment at this seniority.
- industry: the employer's industry, specific ("regional freight forwarding", not "business").
- background: 80 to 150 words in the first person, as the person would tell it to an interviewer: how they came to this job, what a normal week looks like, the tools they use today and what bothers them about them, and what they would not put up with. It follows from every trait: seniority, company size, tech skill, familiarity with this kind of product, device, motivation, and any accessibility need, described by how they work (zoom, a screen reader, the keyboard) rather than as a label.
- context_of_use: one sentence on when, where and on what device they meet the product this time.
- goal_interpretation: one or two sentences in the first person on how this person reads the task: what they think it asks, what they care about, and what done looks like to them.
- voice: one or two sentences on how they think and write: tone, length, the words they reach for, and the language they think in.

Rules:
- Each person is an individual, not a representative of a group. No stereotypes, no national, cultural, gender or disability caricature, and no demographic labels such as "as a woman" or "as a non-native speaker": the name, the situation and the voice carry who they are.
- Keep behaviour mild and grounded in the traits. Low patience means stopping sooner, not rudeness; low tech skill means working with what is on screen, not helplessness. Most people are reasonable and busy.
- A first language other than English shapes the name and the voice, not the quality of their English. Write every field in English.
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

export function writerUser(project: ProjectConfig, segment: Segment, traits: Traits, taken: string[] | null): string {
  const goals = segment.typical_goals.length ? ` People in this segment usually come to: ${segment.typical_goals.join('; ')}.` : '';
  return [
    `The product: ${project.name}.${project.description ? ` ${project.description}` : ''}`,
    `Their segment: ${segment.name}. ${segment.description}`,
    `They use the product ${FREQUENCY[segment.usage_frequency]}, usually arriving ${ENTRY[segment.entry]}, ${ACCOUNT[segment.account_state]}.${goals}`,
    `The task they will attempt: "${segment.goal_override ?? project.goal}"`,
    '',
    `${TRAITS_LABEL}${JSON.stringify({ ...traits, segment_id: undefined })}`,
    `tech_skill, patience and motivation run from 1 (low) to 5 (high); language is their first language (${languageName(traits.language)}); company_size counts employees.`,
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

const CONCURRENCY = 6;

/** Names settle in job order after all answers are in, so a deterministic writer always gives the same population. `taken` (nameKey → name) gains the new names. */
export async function writePersonas(jobs: Job[], taken: Map<string, string>, deps: AudienceDeps): Promise<{ personas: Persona[]; cost_usd: number }> {
  const stop = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, stop.signal]) : stop.signal;
  let cost_usd = 0;

  const ask = async (job: Job, avoid: string[] | null): Promise<Candidate[]> => {
    try {
      signal.throwIfAborted();
      const req: LlmRequest<z.infer<typeof writeSchema>> = {
        role: 'persona_writer',
        model: deps.model,
        run_id: null,
        persona_id: job.id,
        round: 0,
        purpose: 'write_persona',
        system: WRITER_SYSTEM,
        user: [{ type: 'text', text: writerUser(deps.project, job.segment, job.traits, avoid) }],
        schema: writeSchema,
        signal,
      };
      const { object, cost_usd: cost } = await deps.llm.call(req);
      cost_usd += cost;
      return object.candidates;
    } catch (err) {
      if (signal.aborted) throw signal.reason; // the user's abort, or the first failure, which stops every other write
      const reason = err instanceof Error ? err.message : String(err);
      const error = new Error(`The persona writer failed on ${job.id} (${job.segment.name}), so no personas were saved: ${reason}`, { cause: err });
      stop.abort(error);
      throw error;
    }
  };

  let done = 0;
  if (jobs.length) deps.onProgress?.(0, jobs.length);
  const drafts: Candidate[][] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      drafts[i] = await ask(jobs[i], null);
      deps.onProgress?.(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

  const personas: Persona[] = [];
  const settle = (i: number, c: Candidate) => {
    const job = jobs[i];
    taken.set(nameKey(c.name), c.name);
    personas[i] = {
      id: job.id,
      ...job.traits,
      name: c.name,
      job_title: c.job_title,
      industry: c.industry,
      background: c.background,
      context_of_use: c.context_of_use,
      goal_interpretation: c.goal_interpretation,
      voice: c.voice,
      seed: job.seed,
    };
  };
  const clashed: number[] = [];
  jobs.forEach((job, i) => {
    const c = choose(drafts[i], job.seed, taken);
    if (c) settle(i, c);
    else clashed.push(i);
  });
  // A clash that survives one re-ask stays for the diversity report to name, rather than failing the whole population.
  for (const i of clashed) {
    const again = await ask(jobs[i], [...taken.values()]);
    settle(i, choose(again, jobs[i].seed, taken) ?? choose(again, jobs[i].seed, new Set())!);
  }
  return { personas, cost_usd };
}
