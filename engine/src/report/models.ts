import { z } from 'zod';
import type { LlmGateway, Recorder } from '../seams.ts';
import type { GnomiEvent, JudgePostTag, JudgeTheme, RunConfig } from '../types.ts';
import { buildReport } from './build.ts';
import { authorThemes, frictionGroups, judgeInput, postsAbout } from './themes.ts';

// Steps 4 and 7 of the report pipeline (tech.md §8.2): the judge merges and names friction groups, the author suggests
// changes. Each answer is recorded as an event, so the report rebuilds from the log alone; a failed or missing answer
// records nothing and the report falls back to the deterministic themes.

const text = (max: number) => z.string().trim().min(1).max(max);
export const judgeSchema = z.object({
  themes: z.array(z.object({ title: text(120), description: text(400), group_ids: z.array(z.string()).min(1) })),
});
/** In social runs the same call tags posts with groups (step 7), so the report can follow a problem through the feed. */
export const judgePostsSchema = judgeSchema.extend({
  posts: z.array(z.object({ post_id: z.string(), group_ids: z.array(z.string()) })),
});
export const authorSchema = z.object({
  suggestions: z.array(z.object({ theme_id: z.string(), change: text(300), solution: text(800) })),
});

export const JUDGE_SYSTEM = `You review potential usability frictions that simulated users (personas) ran into while trying a product.
A deterministic pass has already grouped the frictions by page and element. Each group has an id, its page, its element or kind, how many personas and frictions it has, their trust (confirmed: self-report backed by an objective signal; observed: signal only; reported: self-report only) and up to three example texts.

Merge groups that describe the same underlying problem into one theme, and name every theme:
- title: a short, specific name for the problem, in sentence case, at most 12 words. Name the problem, not a fix.
- description: one sentence on what went wrong for the personas.
- group_ids: the ids of the groups in this theme.

Use only the group ids you were given, and put each group in at most one theme. Do not invent frictions. These are simulated users: never claim that real users had the problem.`;

export const JUDGE_POSTS = `

The personas also posted on a shared feed. Each post has an id, the round it was written in and its text (posts may be a sample).
Tag the posts that talk about a group's problem:
- posts: one entry per such post, with its post_id and the group_ids of the problems it talks about. Leave out posts about none.
A post that repeats a complaint its author never ran into still counts. Use only the post and group ids you were given.`;

export const AUTHOR_SYSTEM = `You suggest design changes for potential usability frictions that simulated users (personas) ran into while trying a product.
For each theme you get its title, description, trust, the pages and elements involved and up to three pieces of evidence.

For every theme, write:
- change: one sentence that starts with a verb, the change you suggest. Be specific about the page and element.
- solution: two or three sentences on one way to make that change.

Use only the theme ids you were given. These are suggestions for the team to consider and validate with real people, not verdicts: do not overstate certainty.`;

export interface ReportModelDeps {
  config: RunConfig;
  llm: LlmGateway; // the run's budgeted gateway: the recorded-cost cap and stop() apply
  record: Recorder;
  events: () => GnomiEvent[]; // the run's log as it is now
}

// One call each per POI, so a slow reasoning model is worth waiting for: DeepSeek's judge needed over 60 s for 48 groups.
const REPORT_TIMEOUT_MS = 180_000;

/** After the episodes end and before the run's end event: one judge call, then one author call, per POI with frictions. */
export async function runReportModels({ config, llm, record, events }: ReportModelDeps): Promise<void> {
  const { run_id, project } = config;
  const { routing } = project.settings;
  const base = { run_id, round: 1, persona_id: null } as const;
  const product = { name: project.name, description: project.description, goal: project.goal };

  const all = frictionGroups(events(), project.poi.id);
  for (const poi_id of new Set(all.map((g) => g.poi_id))) {
    const { groups, posts } = judgeInput(all.filter((g) => g.poi_id === poi_id), postsAbout(events(), poi_id));
    const social = posts.length > 0; // without posts the call is the M3 one
    try {
      const { object } = await llm.call<{ themes: JudgeTheme[]; posts?: JudgePostTag[] }>({
        role: 'judge',
        model: routing.judge,
        run_id,
        persona_id: null,
        round: 1,
        purpose: 'report_themes',
        timeout_ms: REPORT_TIMEOUT_MS,
        system: social ? JUDGE_SYSTEM + JUDGE_POSTS : JUDGE_SYSTEM,
        user: [{ type: 'text', text: JSON.stringify(social ? { product, groups, posts } : { product, groups }) }],
        schema: social ? judgePostsSchema : judgeSchema,
      });
      record({ ...base, poi_id, type: 'report.themes', payload: { poi_id, themes: object.themes, ...(social ? { posts: object.posts } : {}) } });
    } catch {
      // No key, a provider error, two invalid answers or a stop: llm.call recorded any attempt, and the themes stay deterministic.
    }

    // shortcut: the author sees the theme's evidence but not the page snapshot at the evidence step (tech.md §8.2 step 6);
    // the snapshot text is only in the navigator's transcript. Add it when suggestions prove too generic.
    const themes = authorThemes((buildReport(events()).themes ?? []).filter((t) => t.poi_id === poi_id));
    if (themes.length === 0) continue;
    try {
      const { object } = await llm.call({
        role: 'author',
        model: routing.author,
        run_id,
        persona_id: null,
        round: 1,
        purpose: 'report_suggestions',
        timeout_ms: REPORT_TIMEOUT_MS,
        system: AUTHOR_SYSTEM,
        user: [{ type: 'text', text: JSON.stringify({ product, themes }) }],
        schema: authorSchema,
      });
      record({ ...base, poi_id, type: 'report.suggestions', payload: { poi_id, suggestions: object.suggestions } });
    } catch {
      // As above: the report shows the themes without suggestions and says so in its methods appendix.
    }
  }
}
