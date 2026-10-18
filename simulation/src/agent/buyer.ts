// The buying survey (tech.md §7): segments of kind buyer only perceive, so instead of "would you keep using it" they are asked
// whether they would buy, how the price looks, what would stop them and what was unclear. The answer is recorded as the shared
// persona.survey, so sentiment by segment and the report themes see buyers too, with the buying answers alongside.
import { z } from 'zod';
import { english, ENGLISH } from '../llm/english.ts';
import { opinionSchema } from '../opinion/index.ts';
import type { LlmGateway, UserPart } from '../seams.ts';
import type { EventPayloads, GnomiEvent, Persona, Poi, ProjectConfig, RunConfig, Segment } from '../types.ts';
import { profileBlock, wordsFor, type SurveyedEnd } from './prompt.ts';

/** The request purpose, for logs and scripted responders (llm/scripted.ts). */
export const BUYER_SURVEY = 'buyer_survey';

/** What would stop the purchase comes before what speaks for it, as in the usage survey (§6.8). */
export const buyerSurveySchema = z.object({
  objections: opinionSchema.shape.frictions,
  unclear: opinionSchema.shape.frictions,
  likes: opinionSchema.shape.likes,
  price: z.enum(['low', 'fair', 'high', 'unclear']),
  sentiment: opinionSchema.shape.sentiment,
  confidence: opinionSchema.shape.confidence,
  would_buy: z.boolean(),
  reason: english(z.string().trim().min(1).max(500)),
}).strict();

export function buyerSystemPrompt(persona: Persona, project: ProjectConfig, segment: Segment | null): string {
  const { p, obj, poss } = wordsFor(persona, project);
  return `This is ${persona.name}. ${p} is weighing whether to buy ${project.name}, or to recommend it to whoever decides, and has just looked at what ${project.name} shows people like ${obj}. Now ${p} answers a few questions about it. ${p} is not a tester, nobody is watching, and nothing depends on ${p} liking the product.

<persona>
${profileBlock(persona, project, segment, obj)}
</persona>

${p}'s task: "${segment?.goal_override ?? project.goal}"
How ${p} reads it: ${persona.goal_interpretation}
The product: ${project.name}${project.description ? `. ${project.description}` : ''}

Answer with one JSON object, every text in ${poss} own voice and in ${ENGLISH}:
- objections: what would stop ${p} buying ${project.name} or recommending it, most important first, up to 5 short statements (at most 500 characters each); empty when nothing would.
- unclear: what ${p} could not work out from what ${p} saw, such as a price, a limit or what a plan includes, up to 5 short statements; empty when everything was clear.
- likes: what speaks for buying, up to 5 short statements; empty when nothing stood out.
- price: how the price looks to ${p} for what it offers: "low", "fair" or "high", or "unclear" when ${p} could not tell what it would cost.
- sentiment: ${poss} overall view of ${project.name}, an integer from -2 (very negative) to 2 (very positive); 0 is neutral.
- confidence: how sure ${p} is of that view, from 0 to 1.
- would_buy: whether ${p} would buy ${project.name}, or recommend that whoever decides buys it.
- reason: why, as ${p} would say it, in at most 40 words.
Answer from what ${p} saw in this session only. Do not invent praise, objections or certainty: when ${p} stopped early or found it confusing, the true answer says so.`;
}

const ENDING: Record<SurveyedEnd, (p: string) => string> = {
  done: (p) => `${p} got through it`,
  abandoned: (p) => `${p} stopped partway`,
  budget_exceeded: (p) => `${p} ran out of patience before the end`,
  repeated_failure: (p) => `${p} could not go on`,
};

export function buyerParts(opts: { persona: Persona; poi: Poi; end: SurveyedEnd; detail: string | null; steps: number; frictions: string[] }): UserPart[] {
  const p = opts.persona.name.split(' ')[0];
  const text = [
    `${p} is done with ${opts.poi.name} after ${opts.steps} step${opts.steps === 1 ? '' : 's'}: ${ENDING[opts.end](p)}${opts.detail ? ` ("${opts.detail}")` : ''}.`,
    ...(opts.frictions.length ? [`What confused or put ${p} off along the way:`, ...opts.frictions.map((f) => `- "${f}"`)] : [`${p} reported nothing confusing along the way.`]),
    '',
    `Would ${p} buy it, what would stop ${p}, and what was unclear?`,
  ].join('\n');
  return [{ type: 'text', text }];
}

/** Asks a buyer the buying survey about one POI; `own` is the persona's events on it. Returns the answer as a persona.survey payload. */
export async function askBuyer(opts: { llm: LlmGateway; config: RunConfig; persona: Persona; segment: Segment | null; poi: Poi; end: SurveyedEnd; own: GnomiEvent[]; round: number; signal: AbortSignal }): Promise<EventPayloads['persona.survey']> {
  const { config, persona, poi, own } = opts;
  const ending = own.find((e) => e.type === 'persona.goal_done' || e.type === 'persona.abandoned');
  const { object } = await opts.llm.call({
    role: 'navigator',
    model: config.project.settings.routing.navigator,
    run_id: config.run_id,
    persona_id: persona.id,
    round: opts.round,
    purpose: BUYER_SURVEY,
    system: buyerSystemPrompt(persona, config.project, opts.segment),
    user: buyerParts({
      persona,
      poi,
      end: opts.end,
      detail: ending?.type === 'persona.goal_done' ? ending.payload.summary : ending?.type === 'persona.abandoned' ? ending.payload.reason : null,
      steps: own.filter((e) => e.type === 'persona.step' && e.payload.result.error !== 'invalid_output').length,
      frictions: own.flatMap((e) => (e.type === 'persona.friction_reported' ? [e.payload.what] : [])),
    }),
    schema: buyerSurveySchema,
    signal: opts.signal,
    timeout_ms: 30_000,
  });
  const { objections, unclear, likes, price, sentiment, confidence, would_buy, reason } = object;
  return { poi_id: poi.id, sentiment, confidence, likes, frictions: objections, would_continue: would_buy, reason, buyer: { would_buy, price, objections, unclear } };
}
