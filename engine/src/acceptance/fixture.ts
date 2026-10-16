import { apportion, personaId, sampleTraits, slotSeed } from '../audience/sample.ts';
import { sampleProfile } from '../profile/sample.ts';
import { getPersonaSchema } from '../profile/schema.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { Audience, InjectedPost, Persona, ProjectConfig, Segment, WebPoi } from '../types.ts';

export const FIXTURE_VERSION = 1;
export const SEED = 20261015;
export const M4_SEEDS = [SEED, SEED + 1, SEED + 2, SEED + 3, SEED + 4]; // run seeds: the population stays frozen, the follow graph varies
export const M3_SEEDS = [SEED, SEED + 1, SEED + 2]; // the roadmap's three seeds for theme stability
export interface Fixture { project: ProjectConfig; personas: Persona[] }
/** The fixture's one POI, the Gym as a web app. */
export const gym = (base: Fixture) => base.project.pois[0] as WebPoi;
const FIRST = ['Alex', 'Robin', 'Sam', 'Jordan', 'Kai', 'Noor', 'Rowan', 'Ari', 'Quinn', 'Sasha'];
const LAST = ['Meyer', 'Wilson', 'Fischer', 'Reed', 'Schneider'];

/** Seeded traits with authored prose templates. This fixture makes no claim about live writer quality or population diversity. */
export function fixture(url: string): Fixture {
  const segment = (id: string, name: string, share: number, goal: string): Segment => ({
    id, name, share, description: `People responsible for ${name.toLowerCase()} at their employer.`, role: null,
    usage_frequency: 'weekly', typical_goals: [goal], mobile_share: 0.25, patience: [1, 5], tech_skill: [1, 5],
    account_state: 'populated', entry: 'direct', goal_override: goal, employers: ['Example Works', 'Northstar Services'],
  });
  const audience: Audience = {
    seed: SEED, persona_count: 50, company_size: [50, 2000], countries: { US: 0.8, DE: 0.2 }, languages: { en: 0.8, de: 0.2 },
    accessibility: { none: 0.85, low_vision: 0.05, colour_blind: 0.05, screen_reader: 0.03, motor: 0.02 },
    segments: [
      segment('seg-1', 'Recruiting', 40, 'Post a job for a backend engineer in Engineering, with a detailed description and a hiring manager.'),
      segment('seg-2', 'Hiring management', 30, 'Review a candidate and leave a hiring decision and feedback.'),
      segment('seg-3', 'Workspace administration', 20, 'Invite a hiring manager and check how job approvals are configured.'),
      segment('seg-4', 'Department coordination', 10, 'Find the open jobs and review the candidate list.'),
    ],
  };
  const schema = getPersonaSchema();
  const project: ProjectConfig = {
    name: 'Gym ATS', description: 'An applicant tracking system for companies with 50 to 2,000 employees.',
    pois: [{ id: 'poi-gym', type: 'web', mode: 'full', segments: null, name: 'Gym v1', start_url: `${url}/`, allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null }],
    goal: 'Use the applicant tracking system for the task assigned to your role.', role: null, audience, persona_schema: schema,
    settings: { ...structuredClone(DEFAULT_SETTINGS), wall_clock_budget_min: 30 },
  };
  const counts = apportion(audience.segments.map((s) => s.share), 50, 3);
  let index = 0;
  const personas = audience.segments.flatMap((segment, s) => Array.from({ length: counts[s] }, (_, slot): Persona => {
    const seed = slotSeed(SEED, segment.id, slot);
    const traits = sampleTraits(segment, audience, seed);
    const i = index++;
    return {
      ...traits, id: personaId(segment.id, slot), seed, attributes: sampleProfile(schema, segment.id, seed),
      name: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length)]}`, job_title: `${segment.name} team member`, industry: 'Business services',
      background: `I work in ${segment.name.toLowerCase()} at ${traits.employer}, based in ${traits.city}. My employer has about ${traits.company_size} people. I use hiring tools to keep work moving between colleagues. I need enough information to make the next decision and want to know whether my changes have been saved. I have other work to do after this task.`,
      context_of_use: traits.device === 'mobile' ? 'Using my phone between meetings.' : 'At my desk with a computer during the working day.',
      goal_interpretation: segment.goal_override!,
      voice: `Plain, practical and brief. Thinks in ${traits.languages?.[0] ?? traits.language}; expresses uncertainty when the screen is unclear.`,
    };
  }));
  return { project, personas };
}

/** The first personas of each segment, apportioned by share with one at least, so a cheaper run keeps every segment and the same people. */
export function subset(base: Fixture, total: number): Fixture {
  if (total >= base.personas.length) return base;
  const segments = base.project.audience!.segments;
  if (total < segments.length) throw new Error(`--personas must be at least ${segments.length}, one per segment.`);
  const counts = apportion(segments.map((segment) => segment.share), total, 1);
  const personas = segments.flatMap((segment, i) => base.personas.filter((persona) => persona.segment_id === segment.id).slice(0, counts[i]));
  return { project: { ...base.project, audience: { ...base.project.audience!, persona_count: total } }, personas };
}

export function germanProbe(base: Fixture): Fixture {
  const persona: Persona = {
    ...structuredClone(base.personas[0]), id: 'p-german-probe', segment_id: null, name: 'Lea Schneider',
    country: 'DE', city: 'Berlin', timezone: 'Europe/Berlin', languages: ['de-DE', 'en'], language: 'de',
    background: 'I work in recruiting in Berlin. I use German at work and read English product interfaces when needed.',
    goal_interpretation: 'Read the language and timezone shown on this page, then finish.', voice: 'Plain, practical German, with brief thoughts.',
  };
  return { personas: [persona], project: {
    ...structuredClone(base.project), audience: null, goal: 'Read the language and timezone shown on this page, then finish.',
    pois: [{ ...gym(base), id: 'poi-locale', name: 'Gym locale echo', start_url: new URL('/locale', gym(base).start_url).href }],
    settings: { ...structuredClone(base.project.settings), concurrency: 1, wall_clock_budget_min: 5 },
  } };
}

/** The M4 harness's seeded complaint (Gym D04), posted for the fixture's first recruiter before round 1's social phase. */
export function complaint(base: Fixture): InjectedPost {
  return {
    round: 1, persona_id: base.personas[0].id, poi_id: gym(base).id,
    text: 'Assigning a hiring manager who has no account yet threw away my whole job draft. Has anyone else lost a job post this way?',
  };
}
