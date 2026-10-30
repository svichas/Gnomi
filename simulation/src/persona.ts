import type { Persona, ProjectConfig } from './types.ts';

// The built-in persona: the whole population when a project has no audience (M0, M1, and any M2 project before
// its audience is set up). Sampled populations come from engine/src/audience.
export const BUILTIN_PERSONA: Persona = {
  id: 'p-001',
  segment_id: null,
  name: 'Priya Natarajan',
  pronouns: 'she',
  job_title: 'Recruiter',
  seniority: 'mid',
  company_size: 240,
  industry: 'logistics software',
  tech_skill: 3,
  patience: 3,
  familiarity_with_category: 'medium',
  device: 'desktop',
  language: 'en',
  accessibility_needs: 'none',
  context_of_use: 'At her desk mid-morning, between two phone screens, with a hiring manager waiting on her',
  background:
    'Six years recruiting for logistics software companies, the last two as the only recruiter at a 240-person firm. Fills twenty roles a quarter, mostly engineers and account managers, and judges tools by how few clicks a job post takes.',
  goal_interpretation: 'Do what was asked the way she would at work: quickly, skimming rather than reading every word.',
  motivation: 4,
  voice: 'Practical and brisk. Says plainly when something is confusing. Dry humour when a tool wastes her time.',
  seed: 1001,
};

/**
 * The generic-persona control (new_simulation.md §9): the same people and seeds, with every prompt-visible trait set to one
 * constant and the biography stripped to the segment, so prompts differ by segment alone. Names stay distinct because the
 * social feed attributes posts by name; they are assigned by index, not sampled from traits. Needs an audience.
 */
export function traitFree(personas: Persona[], { audience, goal }: Pick<ProjectConfig, 'audience' | 'goal'>): Persona[] {
  const segments = new Map(audience!.segments.map((s) => [s.id, s]));
  const middle = ([lo, hi]: [number, number]) => Math.round((lo + hi) / 2);
  return personas.map((persona) => {
    const segment = segments.get(persona.segment_id!)!;
    return {
      ...persona, attributes: {}, job_title: `${segment.name} team member`, industry: 'Business services', background: segment.description,
      context_of_use: 'At work.', voice: 'Plain and brief.', tech_skill: middle(segment.tech_skill), patience: middle(segment.patience),
      device: 'desktop', accessibility_needs: 'none', pronouns: 'they', seniority: 'mid', motivation: 3, familiarity_with_category: 'medium', company_size: 500,
      country: 'US', city: 'New York', timezone: 'America/New_York', languages: ['en-US'], language: 'en-US', employer: 'Example Works',
      goal_interpretation: segment.goal_override ?? goal,
    };
  });
}
