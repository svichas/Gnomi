import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { mean, sampleVariance } from 'simple-statistics';
import { isPriced } from '../llm/prices.ts';
import { escapeRegExp } from '../poi/text.ts';
import { matchThemes } from '../report/match.ts';
import type { LlmAttempt } from '../seams.ts';
import type { ReportTheme, RunSettings } from '../types.ts';

export type Mode = 'scripted' | 'live';
export type Status = 'PASS' | 'FAIL' | 'REVIEW_NEEDED' | 'NOT_RUN';
export type Provider = 'anthropic' | 'deepseek';
export const KEY_ENV: Record<Provider, string> = { anthropic: 'ANTHROPIC_API_KEY', deepseek: 'DEEPSEEK_API_KEY' };
export const FULL_POPULATION = 50;
export interface Mapper { provider: Provider; model: string }
// personas and seeds shrink a live run to save spend; criteria set at full scale then stay NOT_RUN
export interface Options { mode: Mode; out: string; allowance_usd?: number; m5?: true; m4?: true; m3?: true; evaluate?: true; rescore?: true; repeats?: number; arms?: Arm[]; mapper?: Mapper; provider: Provider; personas: number; seeds?: number }
export interface Criterion { id: string; status: Status; live_required: boolean; detail: string }
export const BILLING_CAVEAT = 'The allowance stops new work at recorded spend. Already-dispatched calls may still be billed; missing provider usage makes the final bill uncertain. This is not a provider billing cap.';

/** Evaluation arms (new_simulation.md §9): run-settings overrides of the baseline, and the generic-persona control. */
export const ARMS = {
  baseline: {},
  social_off: { settings: { social: false } },
  chronological_feed: { settings: { feed_policy: 'chronological' } },
  rewired_network: { settings: { network_policy: 'rewired' } },
  random_network: { settings: { network_policy: 'random' } },
  clustered_network: { settings: { network_policy: 'clustered' } },
  generic_persona: { generic: true },
  // Cost arms: what each saving does to the outcomes. A DeepSeek navigator never gets screenshots, so text_only needs --provider anthropic.
  text_only: { settings: { screenshots: false } },
  fewer_rounds: { settings: { rounds: 3 } },
  // Stays off in DEFAULT_SETTINGS until this arm shows it helps.
  finding_check: { settings: { finding_check: true } },
} satisfies Record<string, { settings?: Partial<RunSettings>; generic?: true }>;
export type Arm = keyof typeof ARMS;

/** `provider:model` for the mapping judge, which docs/roadmap.md's judge calibration wants from another model family than the navigator's. */
function parseMapper(value: string, navigator: string): Mapper {
  const colon = value.indexOf(':');
  const [provider, model] = [value.slice(0, colon), value.slice(colon + 1)];
  if (colon < 1 || !model || !Object.hasOwn(KEY_ENV, provider)) throw new Error(`--mapper must be provider:model, with provider one of ${Object.keys(KEY_ENV).join(', ')}.`);
  if (provider === navigator) throw new Error(`--mapper must not be from ${navigator}, the navigator's provider: the mapping judge needs another model family.`);
  return { provider: provider as Provider, model };
}

export function parseOptions(args: string[]): Options {
  const { values } = parseArgs({ args, options: { live: { type: 'boolean' }, m5: { type: 'boolean' }, m4: { type: 'boolean' }, m3: { type: 'boolean' }, evaluate: { type: 'boolean' }, rescore: { type: 'string' }, repeats: { type: 'string' }, arms: { type: 'string' }, mapper: { type: 'string' }, out: { type: 'string' }, 'allowance-usd': { type: 'string' }, provider: { type: 'string' }, personas: { type: 'string' }, seeds: { type: 'string' } } });
  const allowance_usd = values['allowance-usd'] === undefined ? undefined : Number(values['allowance-usd']);
  if (allowance_usd !== undefined && (!Number.isFinite(allowance_usd) || allowance_usd <= 0)) throw new Error('--allowance-usd must be a finite positive recorded-spend allowance.');
  if ([values.m3, values.m4, values.m5, values.evaluate].filter(Boolean).length > 1) throw new Error('Choose one of --m3, --m4, --m5 and --evaluate.');
  if (values.rescore !== undefined && Object.keys(values).length > 1) throw new Error('--rescore takes only the evaluation folder: it runs nothing.');
  const arms = values.arms?.split(',').map((arm) => arm.trim());
  const unknown = arms?.find((arm) => !(arm in ARMS));
  if (unknown !== undefined) throw new Error(`--arms must name some of ${Object.keys(ARMS).join(', ')}; got ${unknown}.`);
  if (arms && !arms.includes('baseline')) throw new Error('--arms must include baseline, which every other arm is compared with.');
  const provider = values.provider ?? 'anthropic';
  if (!(provider in KEY_ENV)) throw new Error(`--provider must be one of ${Object.keys(KEY_ENV).join(', ')}.`);
  if (values.mapper !== undefined && !values.evaluate) throw new Error('--mapper only applies to --evaluate.');
  const whole = (name: string, value: string | undefined, max: number) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`--${name} must be a whole number from 1 to ${max}.`);
    return n;
  };
  return {
    mode: values.live ? 'live' : 'scripted', out: resolve(values.rescore ?? values.out ?? `acceptance-results/${new Date().toISOString().replaceAll(':', '-')}`), provider: provider as Provider,
    personas: values.personas === undefined ? FULL_POPULATION : whole('personas', values.personas, FULL_POPULATION),
    ...(values.seeds === undefined ? {} : { seeds: whole('seeds', values.seeds, 5) }),
    ...(values.rescore === undefined ? {} : { rescore: true as const }),
    ...(values.evaluate ? { evaluate: true as const, repeats: values.repeats === undefined ? 5 : whole('repeats', values.repeats, 50), arms: (arms ?? Object.keys(ARMS)) as Arm[] } : {}),
    ...(values.mapper === undefined ? {} : { mapper: parseMapper(values.mapper, provider) }),
    ...(allowance_usd === undefined ? {} : { allowance_usd }), ...(values.m5 ? { m5: true as const } : {}), ...(values.m4 ? { m4: true as const } : {}), ...(values.m3 ? { m3: true as const } : {}),
  };
}

export function validateOptions(options: Options, env: Record<string, string | undefined>): void {
  if (options.mode !== 'live') return;
  if (!Number.isFinite(options.allowance_usd) || !(options.allowance_usd! > 0)) throw new Error('Live acceptance requires --allowance-usd with an explicit positive recorded-spend allowance.');
  for (const provider of [options.provider, ...(options.mapper ? [options.mapper.provider] : [])]) {
    if (!env[KEY_ENV[provider]]?.trim()) throw new Error(`Live ${provider} acceptance requires ${KEY_ENV[provider]} in the local environment.`);
  }
  if (options.mapper && !isPriced(options.mapper)) throw new Error(`--mapper names ${options.mapper.model}, which has no price: the gateway would refuse it after the runs have been paid for.`);
}

/** Shared by both cases; late attempts remain counted after cancellation. */
export function createAllowance(limit: number) {
  const controller = new AbortController();
  let spent = 0;
  let unknown = 0;
  return {
    signal: controller.signal,
    spent: () => spent,
    unknown: () => unknown,
    check: () => controller.signal.throwIfAborted(),
    observe(attempt: LlmAttempt) {
      spent += attempt.payload.cost_usd;
      if (attempt.payload.usage_reported !== true) {
        unknown++;
        controller.abort(new Error('Provider usage is missing; stopped further acceptance calls because total billing is uncertain.'));
      } else if (spent >= limit) controller.abort(new Error('The acceptance recorded-spend allowance was reached.'));
    },
  };
}

/** The engine sees its attempt first so its precise budget reason wins; accounting survives an observer error. */
export function observeAttempt(attempt: LlmAttempt, onAttempt: ((attempt: LlmAttempt) => void) | undefined, allowance: ReturnType<typeof createAllowance> | null, write: (attempt: LlmAttempt) => void): void {
  try {
    onAttempt?.(attempt);
  } finally {
    try { allowance?.observe(attempt); } finally { write(attempt); }
  }
}

export interface Facts {
  population: number; terminal: number; goal_completed: number; blocked: number; run_status: string;
  duration_ms: number; cost_usd: number; unknown_usage: number; peak_contexts: number; replay_equal: boolean;
}

/** Structural failures fail even a scripted rehearsal; quality and performance remain separate live claims. */
export function executionCriterion(facts: Facts, expected: number): Criterion {
  return {
    id: 'execution', status: facts.population === expected && facts.terminal === expected && facts.blocked === 0 && facts.run_status === 'finished' ? 'PASS' : 'FAIL', live_required: false,
    detail: `Expected ${expected} personas and terminal episodes; observed ${facts.population} personas, ${facts.terminal} terminal, ${facts.blocked} blocked, run ${facts.run_status}.`,
  };
}

export function assess(mode: Mode, facts: Facts, expected = FULL_POPULATION): Criterion[] {
  const check = (id: string, condition: boolean, detail: string, live_required = true): Criterion => ({
    id, status: live_required && mode !== 'live' ? 'NOT_RUN' : condition ? 'PASS' : 'FAIL', live_required, detail,
  });
  // Time, cost and 12 browsers are targets for fifty people; a smaller run reports its figures without passing or failing them.
  const reduced = (criterion: Criterion): Criterion => expected < FULL_POPULATION && ['duration', 'recorded_cost', 'concurrency'].includes(criterion.id)
    ? { ...criterion, status: 'NOT_RUN', detail: `Reduced scale (${expected} of ${FULL_POPULATION} personas): ${criterion.detail}` } : criterion;
  return ([
    executionCriterion(facts, expected),
    check('population', facts.population === expected && facts.terminal === expected && facts.blocked === 0 && facts.run_status === 'finished', `${facts.terminal}/${facts.population} episodes ended; ${facts.goal_completed} reached their task goal; ${facts.blocked} blocked.`),
    check('duration', facts.duration_ms < 30 * 60_000, `${facts.duration_ms} ms; acceptance requires strictly under 1,800,000 ms.`),
    { ...check('recorded_cost', facts.cost_usd < 5, `$${facts.cost_usd} recorded; ${facts.unknown_usage} attempts have missing usage; acceptance requires under $5 with complete usage.`), ...(mode === 'live' && facts.cost_usd < 5 && facts.unknown_usage > 0 ? { status: 'REVIEW_NEEDED' as const } : {}) },
    check('concurrency', facts.peak_contexts === 12, `Configured for 12; observed peak ${facts.peak_contexts} browser contexts.`, false),
    check('replay', facts.replay_equal, 'The report rebuilt from the reopened SQLite event log matches the saved report.', false),
    { id: 'profile_adherence', status: mode === 'live' ? 'REVIEW_NEEDED' : 'NOT_RUN', live_required: true, detail: 'Review the frozen profiles against recorded thoughts/actions in review.md; no automatic quality judgment is made.' },
    { id: 'live_persona_writer', status: 'NOT_RUN', live_required: true, detail: 'Browsing-only evaluation uses authored fixture prose; no live persona writer was called.' },
  ] satisfies Criterion[]).map(reduced);
}

export const TOP = 20; // precision is measured over a report's top 20 themes

/** The false positives of a control build: its themes with trust confirmed or observed (docs/roadmap.md's evaluation plan). */
export const controlThemes = (themes: Pick<ReportTheme, 'trust'>[]) => themes.filter((theme) => theme.trust !== 'reported').length;

const listOf = (entry: string, field: string) => (new RegExp(`${field}: \\[(.*)\\]`).exec(entry)?.[1] ?? '').split(',').map((item) => item.trim().replaceAll('"', '')).filter(Boolean);

/** The catalogue's switched-on web defects. Its fields are read with regular expressions, so each stays on one line. */
export const webDefects = (catalogue: string, on: string[]) => catalogue.split(/^- /m).slice(1).map((entry) => ({
  id: /id: (\S+)/.exec(entry)?.[1] ?? '', title: /title: (.*)/.exec(entry)?.[1] ?? '', web: /poi: web\b/.test(entry), high: /severity: high\b/.test(entry),
  pages: listOf(entry, 'pages'), hints: listOf(entry, 'hints'),
})).filter((defect) => defect.web && on.includes(defect.id));

/**
 * A hint-based estimate of Gym defect recall and precision against the catalogue's enabled web defects, not a reviewed mapping: a
 * theme pairs with a defect only when they share a catalogue page and one of the defect's hints appears, as whole words with a regular
 * ending, in the theme's title, description, elements or evidence. Pairs are assigned one-to-one, so a theme credits at most one defect
 * and a defect at most one theme. A defect is found by a confirmed or observed theme; precision counts the top themes. shortcut: a hint
 * can appear in a theme about another problem; use mappingScores once a theme-mapping.json is recorded.
 */
export function defectScores(themes: ReportTheme[], catalogue: string, on: string[]) {
  const defects = webDefects(catalogue, on);
  const words = (theme: ReportTheme) => [theme.title, theme.description, ...theme.elements, ...theme.evidence.flatMap((e) => [e.what, e.quote])].join('\n');
  const hasHint = (text: string, hint: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(hint)}(?:s|es|d|ed|ing)?(?![\\p{L}\\p{N}])`, 'iu').test(text); // "broken link" catches "broken links", but "covered" misses "discovered"
  const pairs = (theme: ReportTheme, defect: typeof defects[number]) => theme.pages.some((page) => defect.pages.includes(page.split('/').slice(1).join('/') || 'dashboard')) // patterns lead with the host; the Gym's root is its dashboard
    && defect.hints.some((hint) => hasHint(words(theme), hint));
  // The largest one-to-one assignment by augmenting paths, so a greedy first pick cannot block a later theme.
  const assigned = (pool: ReportTheme[], among = defects) => {
    const owner = new Map<string, number>(); // defect id → index in pool of the theme it is assigned to
    const place = (t: number, seen: Set<string>): boolean => {
      for (const defect of among) {
        if (seen.has(defect.id) || !pairs(pool[t], defect)) continue;
        seen.add(defect.id);
        const held = owner.get(defect.id);
        if (held === undefined || place(held, seen)) { owner.set(defect.id, t); return true; }
      }
      return false;
    };
    return pool.filter((_, t) => place(t, new Set())).length;
  };
  const trusted = themes.filter((theme) => theme.trust !== 'reported');
  const found = assigned(trusted);
  const high = defects.filter((defect) => defect.high);
  const foundHigh = assigned(trusted, high);
  const top = themes.filter((theme) => theme.rank <= TOP);
  const matched = assigned(top);
  return { found, defects: defects.length, recall: defects.length ? found / defects.length : null, found_high: foundHigh, defects_high: high.length, recall_high: high.length ? foundHigh / high.length : null, matched, top: top.length, precision: top.length ? matched / top.length : null };
}

/**
 * One mapper answer applied to its run's items. An answer is a proposal, so a defect the catalogue does not have stays null. A theme the
 * model left out gets no `defect` at all, which JSON drops: null is an answer that no defect fits, and only that is a false positive.
 */
export function applyMapping<T extends { theme_id: string; defect?: string | null; notes: string }>(items: T[], answers: { theme_id: string; defect: string | null; reason: string }[], known: string[]): T[] {
  return items.map((item) => {
    const answer = answers.findLast((entry) => entry.theme_id === item.theme_id);
    if (!answer) return { ...item, defect: undefined, notes: 'The model left this theme out, so it counts in no score until a person gives it a defect or null.' };
    return { ...item, defect: answer.defect !== null && known.includes(answer.defect) ? answer.defect : null, notes: answer.reason };
  });
}

/**
 * Recall of high-severity defects and precision of the top themes per run, from theme-mapping.json items, so a mapping replaces the
 * defectScores estimate. By docs/roadmap.md's definitions a theme mapped to a switched-on defect is a true positive and a defect is
 * found when a confirmed or observed theme maps to it, so two themes may share a defect. A control run has no defect on: it is left out.
 * A theme with no answer counts for nothing, and a run with no answers has no scores.
 */
export function mappingScores(items: { run: string; rank: number; trust: string; defect?: string | null }[], catalogue: string, on: string[]) {
  const defects = webDefects(catalogue, on);
  const high = defects.filter((defect) => defect.high).map((defect) => defect.id);
  const answered = items.filter((item) => item.defect !== undefined);
  const score = (run: string) => {
    const mapped = answered.filter((item) => item.run === run);
    const found = high.filter((id) => mapped.some((item) => item.defect === id && item.trust !== 'reported'));
    const top = mapped.filter((item) => item.rank <= TOP);
    const matched = top.filter((item) => defects.some((defect) => defect.id === item.defect)).length;
    return { found, defects_high: high.length, recall_high: high.length ? found.length / high.length : null, matched, top: top.length, precision: top.length ? matched / top.length : null };
  };
  return Object.fromEntries([...new Set(answered.map((item) => item.run))].filter((run) => !run.endsWith('control')).map((run) => [run, score(run)]));
}

export const STABILITY_TOP = 10; // stability is measured over a report's top ten themes

/**
 * Stability from docs/roadmap.md's evaluation plan: the Jaccard overlap of two runs' top themes, averaged over every pair of runs. Themes
 * count as the same by matchThemes, not by a reviewed mapping, so it can pair themes that share one key. Null with no pair to compare.
 */
export function topOverlap(runs: ReportTheme[][]): number | null {
  const tops = runs.map((themes) => themes.filter((theme) => theme.rank <= STABILITY_TOP));
  const overlaps = tops.flatMap((a, i) => tops.slice(i + 1).flatMap((b) => {
    const shared = matchThemes(a, b).pairs.length;
    const all = a.length + b.length - shared;
    return all ? [shared / all] : []; // two runs with no themes say nothing either way
  }));
  return overlaps.length ? mean(overlaps) : null;
}

/** Two-sided 95% Student t quantiles for 1 to 30 degrees of freedom. */
export const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
// Above 30 degrees of freedom the normal 1.96 stands in for t: at most 4% narrower, and the gap shrinks as replicates grow.
export const t95 = (df: number) => T95[df - 1] ?? 1.96;

/** The paired mean difference (arm − baseline) over replicates where both measured, with a 95% t interval; whole replicates are the unit. */
export function pairedDifference(arm: (number | null)[], baseline: (number | null)[]) {
  const d = arm.flatMap((value, i) => value === null || baseline[i] === null || baseline[i] === undefined ? [] : [value - baseline[i]]);
  if (!d.length) return { n: 0, mean: null, lower: null, upper: null, note: 'no pairs' };
  const m = mean(d);
  if (d.length < 3) return { n: d.length, mean: m, lower: null, upper: null, note: 'fewer than three pairs' };
  // Identical differences are not certainty: a zero-width interval would claim it.
  if (d.every((x) => x === d[0])) return { n: d.length, mean: m, lower: null, upper: null, note: 'no variation' };
  const half = t95(d.length - 1) * Math.sqrt(sampleVariance(d) / d.length);
  return { n: d.length, mean: m, lower: m - half, upper: m + half, note: null };
}
