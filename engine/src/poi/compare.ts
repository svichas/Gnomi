import { z } from 'zod';
import type { LlmRequest } from '../seams.ts';
import type { EventPayloads, GnomiEvent, Persona, Poi, ProjectConfig } from '../types.ts';
import { loginPoi } from './pois.ts';

// A competitor's site in the end-of-episode survey (tech.md §7 "Competitor site"): run.ts's survey passes its request through here.

export const comparisonSchema = z.object({
  prefers: z.enum(['product', 'competitor', 'no_preference']),
  reason: z.string().trim().min(1).max(500),
}).strict();

type Answer = { comparison?: z.infer<typeof comparisonSchema> | null };

export interface Comparison {
  /** The survey request, with the comparison question and its answer field added when it applies. */
  ask<T extends object>(req: LlmRequest<T>): LlmRequest<T & Answer>;
  /** What the survey event records of the answer: the comparison, or nothing. */
  answer(object: Answer): Pick<EventPayloads['persona.survey'], 'comparison'>;
}

const NONE: Comparison = { ask: (req) => req, answer: () => ({}) };

const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;

/**
 * An observe-only POI's survey also asks how it compares with the team's product, the first web POI in full mode (the one logins are
 * recorded on), when the persona surveyed that product earlier in the run; its answers then stand for that experience. Otherwise the
 * survey passes through unchanged.
 */
export function comparisonFor(project: ProjectConfig, persona: Persona, poi: Poi, surveys: GnomiEvent[]): Comparison {
  const team = loginPoi(project.pois);
  const earlier = team && poi.type === 'web' && poi.mode === 'observe_only' ? surveys.findLast((e) => e.type === 'persona.survey' && e.payload.poi_id === team.id) : undefined;
  if (!team || earlier?.type !== 'persona.survey') return NONE;
  const p = persona.name.split(' ')[0];
  const { sentiment, likes, frictions, reason } = earlier.payload;
  const text = [
    `This session was on ${poi.name}, a competitor's site ${p} looked at beside ${team.name}. Every answer above is about ${poi.name}.`,
    `Earlier ${p} used ${team.name} for the same task and said afterwards: "${reason}" (overall view ${signed(sentiment)} from -2 to +2).`,
    ...(likes.length ? [`What ${p} liked there: ${likes.map((l) => `"${l}"`).join('; ')}.`] : []),
    ...(frictions.length ? [`What would make ${p} stop using it: ${frictions.map((f) => `"${f}"`).join('; ')}.`] : []),
    `Also answer comparison, as {prefers, reason}: prefers is "product" when ${p} would rather use ${team.name} for tasks like this, "competitor" when ${p} would rather use ${poi.name}, and "no_preference" when neither is better; reason says why, as ${p} would say it, in at most 40 words.`,
  ].join('\n');
  return {
    ask(req) {
      if (!(req.schema instanceof z.ZodObject)) return req;
      // Required for providers, like the step's opinion (agent/prompt.ts); a scripted survey without it still parses.
      const schema = req.schema.extend({ comparison: comparisonSchema.nullable().optional() }).meta({ required: [...Object.keys(req.schema.shape), 'comparison'] });
      return { ...req, user: [...req.user, { type: 'text', text }], schema: schema as unknown as LlmRequest<never>['schema'] };
    },
    answer: ({ comparison }) => (comparison ? { comparison: { with_poi_id: team.id, ...comparison } } : {}),
  };
}
