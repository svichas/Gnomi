import type { AccessibilityNeed, Audience, Grounding, GroundingSource, ProjectConfig } from '@gnomi/simulation/types.ts';

// The audience a project starts from, shared by the engine (CLI, proposals) and the app's "Build my own". Pure, so the page can import it.

// Starting points the user sees and edits (idea.md §11), not measurements: about 15% think in a first language other than English.
const LANGUAGES: Record<string, number> = { en: 0.85, es: 0.04, de: 0.02, fr: 0.02, pt: 0.02, hi: 0.02, zh: 0.02, ar: 0.01 };
// About 14%: colour-vision deficiency alone affects ~8% of men and ~0.5% of women; the rest are rough, so every run meets these users.
const ACCESSIBILITY: Record<AccessibilityNeed, number> = { none: 0.86, low_vision: 0.05, colour_blind: 0.04, motor: 0.03, screen_reader: 0.02 };

/** Whether a segment's source is research notes, which a digest is made from, and not another kind such as an analytics export. */
export const isNotesFile = ({ name }: Pick<GroundingSource, 'name'>) => /\.(?:md|txt)$/i.test(name);

/** What is left when a digest goes: an analytics export stays named, because the numbers it set stay. */
export function withoutDigest({ sources }: Grounding): Grounding | undefined {
  const others = sources.filter((source) => !isNotesFile(source));
  return others.length ? { facts: [], remarks: [], sources: others } : undefined;
}

/** A deterministic starting point with no model call: one segment holding the whole population. */
export function defaultAudience(project: Pick<ProjectConfig, 'name' | 'role' | 'goal'>): Audience {
  return {
    seed: 1,
    persona_count: 50,
    segments: [
      {
        id: 'seg-1',
        name: 'Everyone',
        description: `All the people who use ${project.name}, in one group: every role, level of experience and device.`,
        share: 100,
        role: project.role,
        usage_frequency: 'weekly',
        typical_goals: project.goal ? [project.goal] : [],
        mobile_share: 0.25,
        patience: [1, 5], // one segment for everyone spans the full ranges until segments narrow them
        tech_skill: [1, 5],
        account_state: 'populated',
        entry: 'direct',
        goal_override: null,
      },
    ],
    company_size: [50, 2000],
    languages: { ...LANGUAGES },
    accessibility: { ...ACCESSIBILITY },
  };
}
