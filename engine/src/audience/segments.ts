// Segments given in a file (audience create --segments), for a team or an agent that already knows who uses the product:
// no proposal call, and nothing to edit and write again afterwards. Each segment needs a name, a description and a share;
// what it leaves out starts from the one-segment default, as a segment added in the app does.
import { z } from 'zod';
import { apportion } from '@gnomi/simulation/audience/sample.ts';
import type { Segment } from '@gnomi/simulation/types.ts';

const level = z.number().int().min(1).max(5);
const range = z.tuple([level, level]);
const text = z.string().trim().min(1);

// Strict, so a misspelt field is an error and not a silent default. No role: logins cannot be recorded from the CLI.
const segmentsSchema = z
  .array(
    z.strictObject({
      name: text,
      description: text,
      share: z.number().positive(),
      usage_frequency: z.enum(['daily', 'weekly', 'monthly', 'rarely', 'never']).optional(),
      typical_goals: z.array(text).min(1).max(6).optional(),
      mobile_share: z.number().min(0).max(1).optional(),
      patience: range.optional(),
      tech_skill: range.optional(),
      account_state: z.enum(['empty', 'populated']).optional(),
      entry: z.enum(['direct', 'email_link', 'shared_link']).optional(),
      goal_override: z.string().trim().nullable().optional(), // an empty string reads as none
      kind: z.enum(['user', 'buyer']).optional(),
    }),
  )
  .min(1);

const ordered = ([a, b]: [number, number]): [number, number] => [Math.min(a, b), Math.max(a, b)];

/** Segments with ids 'seg-1'…, shares renormalised to whole percents summing to exactly 100, each at least 1, as a proposal's are. */
export function segmentsFrom(raw: unknown, base: Segment): Segment[] {
  const parsed = segmentsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`The segments must be a JSON array of { "name", "description", "share" } objects:\n${z.prettifyError(parsed.error)}`);
  const shares = apportion(parsed.data.map((s) => s.share), 100, 1);
  return parsed.data.map((s, i) => ({
    ...base,
    ...s,
    id: `seg-${i + 1}`,
    share: shares[i],
    patience: ordered(s.patience ?? base.patience),
    tech_skill: ordered(s.tech_skill ?? base.tech_skill),
    goal_override: s.goal_override || null,
  }));
}
