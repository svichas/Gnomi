import { z } from 'zod';
import type { LlmGateway, Recorder } from '../seams.ts';
import type { AuthorSuggestion, GnomiEvent, JudgeLike, JudgePostTag, JudgeTheme, RunConfig } from '../types.ts';
import { english } from '../llm/english.ts';
import { buildReport } from './build.ts';
import { groupKey, likeGroups } from './friction.ts';
import { authorThemes, frictionGroups, judgeInput, postsAbout } from './themes.ts';

// Steps 4 and 7 of the report pipeline (tech.md §8.2): the judge merges and names friction groups, the author suggests
// changes. Each answer is recorded as an event, so the report rebuilds from the log alone; a failed or missing answer
// records nothing and the report falls back to the deterministic themes.

const text = (max: number) => english(z.string().trim().min(1).max(max));
const theme = z.object({ title: text(120), description: text(400), group_ids: z.array(z.string()).min(1) });
export const judgeSchema = z.object({
  themes: z.array(theme),
});
/** In social runs the same call tags posts with groups (step 7), so the report can follow a problem through the feed. */
export const judgePostsSchema = judgeSchema.extend({
  posts: z.array(z.object({ post_id: z.string(), group_ids: z.array(z.string()) })),
});
/** When the POI's surveys named likes, the same call merges and names them too (step 9). */
// Required for providers, as the comparison is (poi/compare.ts); an answer without it still keeps its themes.
const likes = { likes: z.array(theme).optional() };
export const judgeLikesSchema = judgeSchema.extend(likes).meta({ required: ['themes', 'likes'] });
const judgePostsLikesSchema = judgePostsSchema.extend(likes).meta({ required: ['themes', 'posts', 'likes'] });
/** The judge's schema for what it is shown: posts and likes each add their own answer. */
export function judgeSchemaFor(posts: boolean, liked: boolean) {
  if (liked) return posts ? judgePostsLikesSchema : judgeLikesSchema;
  return posts ? judgePostsSchema : judgeSchema;
}
export const authorSchema = z.object({
  suggestions: z.array(z.object({ theme_id: z.string(), change: text(300), solution: text(800) })),
});

export const JUDGE_SYSTEM = `You review what simulated users (personas) ran into while trying a product, so the team gets findings that are accurate and easy to act on.
A deterministic pass has already grouped the findings. Each group has an id, a category, its page, its element or the part of the product it names, its kind, how many personas and findings it has, their trust (confirmed: self-report backed by an objective signal; observed: signal only; reported: self-report only), a median severity from 1 (a small irritation) to 4 (stops them) and up to three example texts.
Categories: a friction got in the way of doing the task (could not find, understand or complete something); an objection is a reason to doubt or not adopt the product even when it works (value, price, trust, a missing capability, fit).

Merge groups that describe the same underlying problem into one theme, and name every theme:
- title: a short, specific name for the problem, in sentence case, at most 12 words, naming where it happens. Name the problem, not a fix. Not "Confusing interface" but "Plan limits are not shown before checkout".
- description: one or two plain sentences: what the personas were trying to do, what got in the way or put them off, and where. Use only what the example texts say; no generalities.
- group_ids: the ids of the groups in this theme.

Merge only groups that are clearly the same problem; when unsure, keep them apart. Never merge a friction group with an objection group. Use only the group ids you were given, and put each group in at most one theme. Do not invent findings. These are simulated users: never claim that real users had the problem.`;

export const JUDGE_LIKES = `

The personas also said what worked for them. Each like group has an id, the part of the product it names, how many personas named it and up to three example texts.
Merge like groups that praise the same thing, and name each:
- likes: one entry per merged like, with a title (what worked, specific and in sentence case, at most 12 words), a description (one plain sentence on what the personas valued and where) and the group_ids of the like groups it merges.
Use only the like group ids you were given, and put each in at most one entry.`;

export const JUDGE_POSTS = `

The personas also posted on a shared feed. Each post has an id, the round it was written in and its text (posts may be a sample).
Tag the posts that talk about a group's problem:
- posts: one entry per such post, with its post_id and the group_ids of the problems it talks about. Leave out posts about none.
A post that repeats a complaint its author never ran into still counts. Use only the post and group ids you were given.`;

export const AUTHOR_SYSTEM = `You suggest design changes for potential usability frictions that simulated users (personas) ran into while trying a product.
For each theme you get its title, description, trust, the pages and elements involved and up to three pieces of evidence.

For every theme, write:
- change: one short sentence that starts with a verb, the change you suggest. Be specific about the page and element.
- solution: one or two short sentences on one way to make that change.

Write in plain, everyday words that anyone on the team understands at a glance: no design or research jargon.
Use only the theme ids you were given. These are suggestions for the team to consider and validate with real people, not verdicts: do not overstate certainty.`;

export interface ReportModelDeps {
  config: RunConfig;
  round: number; // the round the run reached, so judge and author calls are not logged as round 1
  llm: LlmGateway; // the run's budgeted gateway: the recorded-cost cap and stop() apply
  record: Recorder;
  events: () => GnomiEvent[]; // the run's log as it is now
}

// One judge call per POI and an author call per batch, so a slow reasoning model is worth waiting for: DeepSeek's judge needed over 60 s for 48 groups.
const REPORT_TIMEOUT_MS = 180_000;
const AUTHOR_BATCH = 3; // themes per author call; the calls run together, so the wait is one short answer, not one long one

/** After the episodes end and before the run's end event: per POI with frictions, in parallel, a judge call, then the author calls. */
export async function runReportModels({ config, round, llm, record, events }: ReportModelDeps): Promise<void> {
  const { run_id, project } = config;
  const { routing } = project.settings;
  const base = { run_id, round, persona_id: null } as const;
  const product = { name: project.name, description: project.description, goal: project.goal };

  const log = events(); // the judge's input only; each POI's author call reads the log again, with that POI's themes
  const all = frictionGroups(log, project.pois[0]?.id ?? '');
  const allLikes = likeGroups(log);
  const pois = [...new Set([...all.map((g) => g.poi_id), ...allLikes.map((g) => g.poi_id)])];
  record({ ...base, poi_id: null, type: 'report.started', payload: { pois } });
  await Promise.all(pois.map(async (poi_id) => {
    const { groups, posts, likes } = judgeInput(all.filter((g) => g.poi_id === poi_id), postsAbout(log, poi_id), undefined, undefined, allLikes.filter((g) => g.poi_id === poi_id));
    const social = posts.length > 0; // without posts or likes the call is the M3 one
    const liked = !!likes?.length;
    try {
      const { object } = await llm.call<{ themes: JudgeTheme[]; posts?: JudgePostTag[]; likes?: JudgeLike[] }>({
        role: 'judge',
        model: routing.judge,
        run_id,
        persona_id: null,
        round,
        poi_id,
        purpose: 'report_themes',
        timeout_ms: REPORT_TIMEOUT_MS,
        system: JUDGE_SYSTEM + (social ? JUDGE_POSTS : '') + (liked ? JUDGE_LIKES : ''),
        user: [{ type: 'text', text: JSON.stringify({ product, groups, ...(social ? { posts } : {}), ...(liked ? { likes } : {}) }) }],
        schema: judgeSchemaFor(social, liked),
      });
      const keys = Object.fromEntries(all.filter((g) => g.poi_id === poi_id).map((g) => [g.id, groupKey(g.members[0])]));
      record({ ...base, poi_id, type: 'report.themes', payload: { poi_id, themes: object.themes, ...(social ? { posts: object.posts } : {}), ...(liked ? { likes: object.likes } : {}), keys } });
    } catch {
      // No key, a provider error, two invalid answers or a stop: llm.call recorded any attempt, and the themes stay deterministic.
    }

    // shortcut: the author sees the theme's evidence but not the page snapshot at the evidence step (tech.md §8.2 step 6);
    // the snapshot text is only in the navigator's transcript. Add it when suggestions prove too generic.
    const themes = authorThemes((buildReport(events()).themes ?? []).filter((t) => t.poi_id === poi_id));
    const batches = Array.from({ length: Math.ceil(themes.length / AUTHOR_BATCH) }, (_, i) => themes.slice(i * AUTHOR_BATCH, (i + 1) * AUTHOR_BATCH));
    // A failed batch only leaves its own themes without suggestions, as a failed single call left them all.
    const answers = await Promise.allSettled(batches.map((batch) => llm.call<{ suggestions: AuthorSuggestion[] }>({
      role: 'author',
      model: routing.author,
      run_id,
      persona_id: null,
      round,
      poi_id,
      purpose: 'report_suggestions',
      timeout_ms: REPORT_TIMEOUT_MS,
      system: AUTHOR_SYSTEM,
      user: [{ type: 'text', text: JSON.stringify({ product, themes: batch }) }],
      schema: authorSchema,
    })));
    const suggestions = answers.flatMap((answer) => answer.status === 'fulfilled' ? answer.value.object.suggestions : []);
    if (suggestions.length) record({ ...base, poi_id, type: 'report.suggestions', payload: { poi_id, suggestions } });
  }));
}
