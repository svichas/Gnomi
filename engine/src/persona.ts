import type { Persona } from './types.ts';

// The single built-in persona of M0. Segments and sampled populations arrive in M2.
export const BUILTIN_PERSONA: Persona = {
  id: 'p-001',
  name: 'Priya Natarajan',
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
  goal_interpretation: 'Do what was asked the way she would at work: quickly, skimming rather than reading every word.',
  motivation: 4,
  voice: 'Practical and brisk. Says plainly when something is confusing. Dry humour when a tool wastes her time.',
  seed: 1001,
};
