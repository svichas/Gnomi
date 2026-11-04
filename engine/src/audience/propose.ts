// The audience proposal: the model drafts behaviour-defined segments; code fixes the shares.
import { z } from 'zod';
import type { ProjectConfig, Segment } from '@gnomi/simulation/types.ts';
import { apportion } from '@gnomi/simulation/audience/sample.ts';
import { groundingLines } from './ground.ts';

// The line the demo writer reads the logins back from; keep it in step with DEMO_PERSONA_WRITER.
export const LOGINS_LABEL = 'Recorded logins: ';

const level = z.number().int().min(1).max(5);
const text = z.string().trim().min(1);

/** Flat (tech.md §10.6). A role can only be a recorded login, or null. */
export function proposalSchema(roles: string[]) {
  return z.object({
    segments: z
      .array(
        z.object({
          name: text,
          description: text,
          share: z.number().positive(),
          role: roles.length ? z.enum(roles).nullable() : z.null(),
          usage_frequency: z.enum(['daily', 'weekly', 'monthly', 'rarely', 'never']),
          mobile_share: z.number().min(0).max(1),
          patience_min: level,
          patience_max: level,
          tech_skill_min: level,
          tech_skill_max: level,
          account_state: z.enum(['empty', 'populated']),
          entry: z.enum(['direct', 'email_link', 'shared_link']),
          typical_goals: z.array(text).min(1).max(6),
          goal_override: z.string().trim().nullable(), // an empty string reads as none
        }),
      )
      .min(3)
      .max(6),
  });
}

export type Proposal = z.infer<ReturnType<typeof proposalSchema>>;

export const PROPOSE_SYSTEM = `Gnomi simulates the people who use a product, so a product team can find usability problems before real users meet them. This step proposes the audience: the segments of people who use the product and each segment's share of them. The team reviews every number.

A segment is a type of user defined by what they do with the product: their role and permissions, how often they use it, what they come to do, how they arrive and on which device. Job titles are flavour; behaviour defines a segment.

Propose 3 to 6 segments that together cover everyone who really uses this product, in proportion:
- Cover the real breadth, not only power users: occasional and reluctant users, people who arrive from an email or a shared link, people on phones, newcomers on an empty account, and people for whom this product is a small part of their job, wherever such people exist for this product.
- Segment by role and behaviour, never by demographics: no segments by age, gender, nationality, ethnicity, language or disability. Language and accessibility needs are sampled across the whole population separately.
- Shares are rough percentages of the people who use the product. Do not invent statistics to justify them.

The fields of each segment:
- name: a short plural noun phrase, such as "Hiring managers".
- description: who these people are and what the product is to them, in one or two sentences.
- share: the percent of the people who use the product.
- role: the recorded login this segment uses, chosen only from the logins listed; null when none fits, or when the segment uses the product logged out.
- usage_frequency: daily, weekly, monthly, rarely, or never (people who do not use it yet).
- mobile_share: the share of this segment's sessions on a phone, from 0 to 1.
- patience_min, patience_max: the segment's spread of patience, from 1 (gives up after a dead end or two) to 5 (methodical and persistent).
- tech_skill_min, tech_skill_max: the segment's spread of tech skill, from 1 (works only with what is on screen) to 5 (technically confident). Make both ranges as wide as the segment really is.
- account_state: empty (first use, nothing set up yet) or populated (an account with history).
- entry: how they usually arrive: direct, email_link or shared_link.
- typical_goals: two to five things people in this segment usually come to do.
- goal_override: the task as this segment would really meet it, only when they would come to it differently from the team's goal (for example, a manager who gets an email asking them to review two candidates, when the team's goal is creating a job post); otherwise null.`;

export function proposeUser(project: ProjectConfig, roles: string[]): string {
  return [
    `The product: ${project.name}.${project.description ? ` ${project.description}` : ''}`,
    `What will be tested: ${project.pois.map((poi) => poi.name).join(', ')}`,
    `The team's goal for the test: "${project.goal}"`,
    `${LOGINS_LABEL}${JSON.stringify(roles)}`,
    ...(project.audience?.segments.flatMap(groundingLines) ?? []),
  ].join('\n');
}

const range = (a: number, b: number): [number, number] => [Math.min(a, b), Math.max(a, b)];

/** Segments with ids 'seg-1'…, shares renormalised to whole percents summing to exactly 100, each at least 1. */
export function toSegments(proposal: Proposal): Segment[] {
  const shares = apportion(proposal.segments.map((s) => s.share), 100, 1);
  return proposal.segments.map((s, i) => ({
    id: `seg-${i + 1}`,
    name: s.name,
    description: s.description,
    share: shares[i],
    role: s.role,
    usage_frequency: s.usage_frequency,
    typical_goals: s.typical_goals,
    mobile_share: s.mobile_share,
    patience: range(s.patience_min, s.patience_max),
    tech_skill: range(s.tech_skill_min, s.tech_skill_max),
    account_state: s.account_state,
    entry: s.entry,
    goal_override: s.goal_override || null,
  }));
}
