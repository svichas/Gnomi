import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { mean, sampleVariance } from 'simple-statistics';
import type { LlmAttempt } from '../seams.ts';
import type { ReportTheme, RunSettings } from '../types.ts';

export type Mode = 'scripted' | 'live';
export type Status = 'PASS' | 'FAIL' | 'REVIEW_NEEDED' | 'NOT_RUN';
export type Provider = 'anthropic' | 'deepseek';
export const KEY_ENV: Record<Provider, string> = { anthropic: 'ANTHROPIC_API_KEY', deepseek: 'DEEPSEEK_API_KEY' };
export const FULL_POPULATION = 50;
// personas and seeds shrink a live run to save spend; criteria set at full scale then stay NOT_RUN
export interface Options { mode: Mode; out: string; allowance_usd?: number; m5?: true; m4?: true; m3?: true; evaluate?: true; repeats?: number; arms?: Arm[]; provider: Provider; personas: number; seeds?: number }
export interface Criterion { id: string; status: Status; live_required: boolean; detail: string }
export const BILLING_CAVEAT = 'The allowance stops new work at recorded spend. Already-dispatched calls may still be billed; missing provider usage makes the final bill uncertain. This is not a provider billing cap.';

/** Evaluation arms (new_simulation.md §9): run-settings overrides of the baseline, and the generic-persona control. */
export const ARMS = {
  baseline: {},
  social_off: { settings: { social: false } },
  chronological_feed: { settings: { feed_policy: 'chronological' } },
  rewired_network: { settings: { network_policy: 'rewired' } },
  generic_persona: { generic: true },
} satisfies Record<string, { settings?: Partial<RunSettings>; generic?: true }>;
export type Arm = keyof typeof ARMS;

export function parseOptions(args: string[]): Options {
  const { values } = parseArgs({ args, options: { live: { type: 'boolean' }, m5: { type: 'boolean' }, m4: { type: 'boolean' }, m3: { type: 'boolean' }, evaluate: { type: 'boolean' }, repeats: { type: 'string' }, arms: { type: 'string' }, out: { type: 'string' }, 'allowance-usd': { type: 'string' }, provider: { type: 'string' }, personas: { type: 'string' }, seeds: { type: 'string' } } });
  const allowance_usd = values['allowance-usd'] === undefined ? undefined : Number(values['allowance-usd']);
  if (allowance_usd !== undefined && (!Number.isFinite(allowance_usd) || allowance_usd <= 0)) throw new Error('--allowance-usd must be a finite positive recorded-spend allowance.');
  if ([values.m3, values.m4, values.m5, values.evaluate].filter(Boolean).length > 1) throw new Error('Choose one of --m3, --m4, --m5 and --evaluate.');
  const arms = values.arms?.split(',').map((arm) => arm.trim());
  const unknown = arms?.find((arm) => !(arm in ARMS));
  if (unknown !== undefined) throw new Error(`--arms must name some of ${Object.keys(ARMS).join(', ')}; got ${unknown}.`);
  if (arms && !arms.includes('baseline')) throw new Error('--arms must include baseline, which every other arm is compared with.');
  const provider = values.provider ?? 'anthropic';
  if (!(provider in KEY_ENV)) throw new Error(`--provider must be one of ${Object.keys(KEY_ENV).join(', ')}.`);
  const whole = (name: string, value: string | undefined, max: number) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`--${name} must be a whole number from 1 to ${max}.`);
    return n;
  };
  return {
    mode: values.live ? 'live' : 'scripted', out: resolve(values.out ?? `acceptance-results/${new Date().toISOString().replaceAll(':', '-')}`), provider: provider as Provider,
    personas: values.personas === undefined ? FULL_POPULATION : whole('personas', values.personas, FULL_POPULATION),
    ...(values.seeds === undefined ? {} : { seeds: whole('seeds', values.seeds, 5) }),
    ...(values.evaluate ? { evaluate: true as const, repeats: values.repeats === undefined ? 5 : whole('repeats', values.repeats, 50), arms: (arms ?? Object.keys(ARMS)) as Arm[] } : {}),
    ...(allowance_usd === undefined ? {} : { allowance_usd }), ...(values.m5 ? { m5: true as const } : {}), ...(values.m4 ? { m4: true as const } : {}), ...(values.m3 ? { m3: true as const } : {}),
  };
}

export function validateOptions(options: Options, env: Record<string, string | undefined>): void {
  if (options.mode !== 'live') return;
  if (!Number.isFinite(options.allowance_usd) || !(options.allowance_usd! > 0)) throw new Error('Live acceptance requires --allowance-usd with an explicit positive recorded-spend allowance.');
  if (!env[KEY_ENV[options.provider]]?.trim()) throw new Error(`Live ${options.provider} acceptance requires ${KEY_ENV[options.provider]} in the local environment.`);
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

/**
 * Gym defect recall and precision against the catalogue's enabled web defects, with the M3 rule: a defect is found by a
 * confirmed or observed theme, precision counts the top themes. shortcut: a theme maps to every defect whose catalogue pages
 * it reached, not a reviewed mapping; upgrade to theme-mapping.json verdicts once reviewers record them.
 */
export function defectScores(themes: ReportTheme[], catalogue: string, on: string[]) {
  const defects = catalogue.split(/^- /m).slice(1).map((entry) => ({
    id: /id: (\S+)/.exec(entry)?.[1] ?? '', web: /poi: web\b/.test(entry),
    pages: (/pages: \[(.*)\]/.exec(entry)?.[1] ?? '').split(',').map((page) => page.trim().replaceAll('"', '')),
  })).filter((defect) => defect.web && on.includes(defect.id));
  const hits = (theme: ReportTheme) => defects.filter((defect) => theme.pages.some((page) => defect.pages.includes(page.split('/').slice(1).join('/') || 'dashboard'))); // patterns lead with the host; the Gym's root is its dashboard
  const found = new Set(themes.filter((theme) => theme.trust !== 'reported').flatMap((theme) => hits(theme).map((defect) => defect.id)));
  const top = themes.filter((theme) => theme.rank <= TOP);
  const matched = top.filter((theme) => hits(theme).length).length;
  return { found: found.size, defects: defects.length, recall: defects.length ? found.size / defects.length : null, matched, top: top.length, precision: top.length ? matched / top.length : null };
}

/** Two-sided 95% Student t quantiles for 1 to 30 degrees of freedom. */
export const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
// Above 30 degrees of freedom the normal 1.96 stands in for t: at most 4% narrower, and the gap shrinks as replicates grow.
export const t95 = (df: number) => T95[df - 1] ?? 1.96;

/** The paired mean difference (arm − baseline) over replicates where both measured, with a 95% t interval; whole replicates are the unit. */
export function pairedDifference(arm: (number | null)[], baseline: (number | null)[]) {
  const d = arm.flatMap((value, i) => value === null || baseline[i] === null || baseline[i] === undefined ? [] : [value - baseline[i]]);
  if (!d.length) return { n: 0, mean: null, lower: null, upper: null };
  const m = mean(d);
  if (d.length < 2) return { n: 1, mean: m, lower: null, upper: null };
  const half = t95(d.length - 1) * Math.sqrt(sampleVariance(d) / d.length);
  return { n: d.length, mean: m, lower: m - half, upper: m + half };
}
