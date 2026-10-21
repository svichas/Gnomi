// The end-of-episode survey of tech.md §8.2: the same persona and goal as the steps (agent/prompt.ts), a survey in place of the action format.
import { z } from 'zod';
import { english, ENGLISH } from '../llm/english.ts';
import { opinionSchema, upTo5 } from '../opinion/index.ts';
import type { UserPart } from '../seams.ts';
import type { GnomiEvent, Opinion, Persona, Poi, ProjectConfig, Segment, SurveyItem } from '../types.ts';
import type { EpisodeEnd } from './loop.ts';
import { clip, firstName, personaSection, taskSection, wordsFor } from './prompt.ts';

/** The episode endings that get a survey: the persona's own and the engine's per-persona stops, never a run-wide one or the model failing to answer. */
export type SurveyedEnd = Exclude<EpisodeEnd, 'blocked' | 'stopped' | 'model_failed'>;

/** One structured survey answer: where in the product, what exactly, and for problems how bad (the step's 1–4 scale). */
const itemWhere = english(z.string().trim().min(1).max(80));
const itemWhat = english(z.string().trim().min(1).max(300));
const problemItem = z.object({ where: itemWhere, what: itemWhat, severity: z.number().int().min(1).max(4) }).strict();
const likeItem = z.object({ where: itemWhere, what: itemWhat }).strict();

/**
 * The end-of-episode survey (tech.md §8.2). Problems come before what the persona liked (§6.8), and each answer is one
 * specific item tied to a part of the product, so the report can count how many personas name the same thing.
 */
export const surveySchema = z.object({
  frictions: upTo5(problemItem),
  objections: upTo5(problemItem),
  likes: upTo5(likeItem),
  sentiment: opinionSchema.shape.sentiment,
  confidence: opinionSchema.shape.confidence,
  would_continue: z.boolean(),
  reason: english(z.string().trim().min(1).max(500)),
}).strict();

export type SurveyOutput = z.infer<typeof surveySchema>;

/** The survey's structured answers as logged items; frictions and objections first, as asked. */
export function surveyItems(o: Pick<SurveyOutput, 'frictions' | 'objections' | 'likes'>): SurveyItem[] {
  return [
    ...o.frictions.map((i) => ({ kind: 'friction' as const, where: i.where, what: i.what, severity: i.severity })),
    ...o.objections.map((i) => ({ kind: 'objection' as const, where: i.where, what: i.what, severity: i.severity })),
    ...o.likes.map((i) => ({ kind: 'like' as const, where: i.where, what: i.what, severity: null })),
  ];
}

export const ENDING: Record<SurveyedEnd, (p: string) => string> = {
  done: (p) => `${p} finished the task`,
  abandoned: (p) => `${p} gave up`,
  budget_exceeded: (p) => `${p} ran out of patience before finishing`,
  repeated_failure: (p) => `${p} stopped after the same action failed three times in a row`,
};

/** The product a survey asks about: a competitor's site by its own name, anything else as the team's product. */
export const surveyedName = (project: ProjectConfig, poi?: Poi) => (poi?.type === 'web' && poi.mode === 'observe_only' ? poi.name : project.name);

/** The survey's system prompt: the same persona and goal as the steps, a survey in place of the action format. */
export function surveySystemPrompt(persona: Persona, project: ProjectConfig, segment: Segment | null, poi?: Poi): string {
  const { p, obj, poss } = wordsFor(persona, project);
  const product = surveyedName(project, poi);
  // A text is read and a design looked through, not used: the survey says which, so the answers are about what the persona met.
  const met = poi?.type === 'text' ? `has just read "${poi.name}", a text about ${project.name}, with something to get done at work in mind,`
    : poi?.type === 'design' ? `has just looked through the screens of ${poi.name}, a design of ${project.name}, with something to get done at work in mind,`
    : product !== project.name ? `has just looked at ${product}, a competitor of ${project.name}, to see how it handles the same work, only browsing: ${p} did not sign up, log in or send anything there,`
    : `has just used ${project.name} to get something done at work`;
  return `This is ${persona.name}. ${p} ${met} and now answers a short survey about it. ${p} is not a tester, nobody is watching, and nothing depends on ${p} liking the product.

${personaSection(persona, project, segment, obj)}

${taskSection(persona, project, segment, p)}

Answer with one JSON object, every text in ${poss} own voice and in ${ENGLISH}. Each list holds up to 5 items, one specific point per item, and is empty when there is nothing to say:
- frictions: what got in ${poss} way while doing the task: something ${p} could not find, did not understand, that did not work or took too long.
- objections: what would make ${p} doubt, distrust or not adopt ${product}, even if it worked: value, price, trust, missing capability, fit with ${poss} work.
- likes: what worked well or convinced ${obj}.
Every item has:
  - where: the page, screen, section, passage or feature it is about, in a few words (for example "pricing page", "sign-up form", "section on security"). Name the same place the same way each time.
  - what: one or two concrete sentences: what ${p} tried or looked for, what happened or was missing, and, for a problem, what ${p} expected instead. Not a verdict like "confusing" or "great UX" on its own.
  - severity, for frictions and objections only: 1 (a small irritation) to 4 (it stops ${obj}: ${p} could not go on, or would not adopt ${product}).
- sentiment: ${poss} overall view of ${product}, an integer from -2 (very negative) to 2 (very positive); 0 is neutral.
- confidence: how sure ${p} is of that view, from 0 to 1.
- would_continue: whether ${p} would keep using ${product} for tasks like this one.
- reason: why, as ${p} would say it, in at most 40 words.
Answer from what ${p} saw and did in this session only. Do not invent praise, friction, objections or certainty: when ${p} gave up or got stuck, the true answer says so.`;
}

/** What the persona saw, for its survey: its latest thoughts, oldest first, and its current opinion of the product. */
export function sawLines(p: string, product: string, thoughts: string[], opinion: Opinion | null): string[] {
  return [
    ...(thoughts.length ? [`What ${p} was thinking at ${thoughts.length === 1 ? 'the last step' : `the last ${thoughts.length} steps`}:`, ...thoughts.map((t) => `- "${clip(t, 200)}"`)] : []),
    opinion ? `Current opinion of ${product} (self-reported): ${JSON.stringify(opinion)}` : `${p} has no settled opinion of ${product} yet.`,
  ];
}

/** What a survey recalls of the episode from the persona's own events on the POI: how it ended, its valid steps, its frictions and latest thoughts. */
export function surveyFacts(own: GnomiEvent[]): { detail: string | null; steps: number; frictions: string[]; thoughts: string[] } {
  const ending = own.find((e) => e.type === 'persona.goal_done' || e.type === 'persona.abandoned');
  const steps = own.flatMap((e) => (e.type === 'persona.step' && e.payload.result.error !== 'invalid_output' ? [e.payload] : []));
  return {
    detail: ending?.type === 'persona.goal_done' ? ending.payload.summary : ending?.type === 'persona.abandoned' ? ending.payload.reason : null,
    steps: steps.length,
    frictions: own.flatMap((e) => (e.type === 'persona.friction_reported' ? [e.payload.what] : [])),
    thoughts: steps.slice(-5).flatMap((s) => (s.thought ? [s.thought] : [])),
  };
}

/** The volatile part: how the episode ended, how long it took, what the persona thought and reported on the way, and its opinion. */
export function surveyParts(opts: { persona: Persona; product: string; end: SurveyedEnd; detail: string | null; steps: number; frictions: string[]; thoughts: string[]; opinion: Opinion | null }): UserPart[] {
  const p = firstName(opts.persona);
  const text = [
    `The session is over after ${opts.steps} step${opts.steps === 1 ? '' : 's'}: ${ENDING[opts.end](p)}${opts.detail ? ` ("${opts.detail}")` : ''}.`,
    ...(opts.frictions.length ? [`Frictions ${p} reported along the way:`, ...opts.frictions.map((f) => `- "${f}"`)] : [`${p} reported no frictions along the way.`]),
    ...sawLines(p, opts.product, opts.thoughts, opts.opinion),
    '',
    `What got in ${p}'s way, what would stop ${p} adopting ${opts.product}, what did ${p} like, and would ${p} keep using it?`,
  ].join('\n');
  return [{ type: 'text', text }];
}
