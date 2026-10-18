import { logsIn, withPois } from '@gnomi/simulation/poi/pois.ts';
import { applyDecisionBrief, cleanDecisionContext, draftComparison, emptyDecisionContext, validateComparison } from '@gnomi/simulation/comparison/config.ts';
import type { ComparisonDecisionContext, ComparisonStudy } from '@gnomi/simulation/comparison/types.ts';
import { DEFAULT_SETTINGS, MAX_ROUNDS } from '@gnomi/simulation/settings.ts';
import type { Audience, LlmRole, PersonaSchema, Poi, ProjectConfig, RunSettings } from '@gnomi/simulation/types.ts';
import { audienceProblem, cleanAudience } from './audience.ts';
import { draftOf, poiOf, poiTitle, POI_KINDS, type PoiDraft } from './poi/index.ts';
import { profileProblem } from './profile.ts';

import { startHost } from './poi/web.ts';

export { hostOf, hostToConfirm, offeredHosts, startHost } from './poi/web.ts';

// The Project screen's form and its rules, kept free of React so they can be tested on their own.

export interface Form {
  study_intent?: ProjectConfig['study_intent'];
  /** Edited brief; applied explicitly before replacing a customized frozen rubric. */
  decision_context?: ComparisonDecisionContext;
  name: string;
  description: string;
  goal: string;
  role: string | null; // null browses logged out
  pois: PoiDraft[]; // in the order personas use them
  comparison?: ComparisonStudy | null;
}

export function initialForm(project: ProjectConfig | null | undefined): Form {
  const pois = project ? withPois(project).pois : [];
  return {
    name: project?.name ?? '',
    description: project?.description ?? '',
    goal: project?.goal ?? '',
    role: project?.role ?? null,
    // A new project starts with one web app to fill in.
    pois: pois.length ? pois.map(draftOf) : [POI_KINDS.web.blank('poi-1')],
    ...(project?.comparison !== undefined ? { comparison: structuredClone(project.comparison) } : {}),
    ...(project?.study_intent ? { study_intent: project.study_intent } : {}),
    ...(project?.comparison?.decision_context ? { decision_context: structuredClone(project.comparison.decision_context) } : {}),
  };
}

/** What the Project, Settings and Audience tabs edit together: one project, saved as a whole. */
export interface Draft {
  form: Form;
  settings: RunSettings;
  audience: Audience | null; // null runs the single built-in persona
  persona_schema?: PersonaSchema;
}

export function initialDraft(project: ProjectConfig | null | undefined): Draft {
  // Projects saved before M2 have no settings or audience.
  return { form: initialForm(project), settings: project?.settings ?? DEFAULT_SETTINGS, audience: project?.audience ?? null, ...(project?.persona_schema ? { persona_schema: project.persona_schema } : {}) };
}

function comparisonForIntent(study: ComparisonStudy, intent: Form['study_intent']): ComparisonStudy {
  if (intent === 'choose_tool') return { ...study, purpose: 'choose_tool', focal_target_id: null };
  if (intent === 'improve_product') return { ...study, purpose: 'improve_own_product', focal_target_id: study.focal_target_id ?? null };
  if (intent === 'test_workflow') return { ...study, execution: { ...study.execution, collection: 'persona_tasks' } };
  return study;
}

/** An explicit intent change adjusts study mode, preserving authored tasks and existing access. */
export function withStudyIntent(form: Form, intent: Form['study_intent']): Form {
  return { ...form, study_intent: intent,
    ...(form.comparison ? { comparison: comparisonForIntent(form.comparison, intent) } : {}),
    ...(intent === 'choose_tool' ? { pois: form.pois.map((poi) => poi.type === 'web' && !form.comparison?.targets.some((target) => target.poi_ids.includes(poi.id) && target.access_scope === 'authenticated_workflow') ? { ...poi, mode: 'observe_only' as const } : poi) } : {}),
  };
}

export function decisionBriefChanged(form: Form): boolean {
  const study = form.comparison;
  return !!study && form.study_intent === 'choose_tool' && (form.goal.trim() !== study.question.trim() || JSON.stringify(cleanDecisionContext(form.decision_context ?? emptyDecisionContext())) !== JSON.stringify(cleanDecisionContext(study.decision_context ?? emptyDecisionContext())));
}

export function applyFormDecisionBrief(form: Form): Form {
  if (!form.comparison) return form;
  const comparison = applyDecisionBrief(form.comparison, form.goal.trim(), form.decision_context ?? emptyDecisionContext());
  return { ...form, goal: comparison.question, decision_context: comparison.decision_context, comparison };
}

export const ROLES: LlmRole[] = ['navigator', 'socialiser', 'persona_writer', 'judge', 'author'];

/** What is wrong with the run settings, as a sentence, or null. */
export function settingsProblem(settings: RunSettings): string | null {
  const { routing, local_base_url, concurrency, cost_budget_usd, wall_clock_budget_min } = settings;
  const endpoint = local_base_url?.trim() ?? '';
  for (const role of ROLES) {
    if (!routing[role].model.trim()) return `Settings: name a model for the ${role.replace('_', ' ')}.`;
    if (routing[role].provider === 'openai_compatible' && !endpoint) return `Settings: the ${role.replace('_', ' ')} uses the local endpoint, so give its address.`;
  }
  if (endpoint && startHost(endpoint) === null) return 'Settings: the local endpoint needs a full web address, such as http://localhost:11434/v1.';
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) return 'Settings: concurrency must be a whole number from 1 to 32.';
  const writerConcurrency = settings.persona_concurrency ?? 32;
  if (!Number.isInteger(writerConcurrency) || writerConcurrency < 1 || writerConcurrency > 32) return 'Settings: writer concurrency must be a whole number from 1 to 32.';
  if (!(cost_budget_usd > 0)) return 'Settings: the cost budget must be more than zero.';
  if (!(wall_clock_budget_min > 0)) return 'Settings: the time budget must be more than zero minutes.';
  const rounds = settings.rounds ?? 5;
  if (settings.social && !(Number.isInteger(rounds) && rounds >= 1 && rounds <= MAX_ROUNDS)) return `Settings: social rounds must be a whole number from 1 to ${MAX_ROUNDS}.`;
  return null;
}

/** The project as the tabs describe it, or the sentence telling what is missing. */
export function toConfig({ form, settings, audience, persona_schema }: Draft): ProjectConfig | string {
  const name = form.name.trim();
  const goal = form.goal.trim();
  if (!name) return 'Give the project a name.';
  if (form.pois.length === 0) return 'Add a point of interest for the personas to try.';
  const pois: Poi[] = [];
  for (const [i, draft] of form.pois.entries()) {
    const target = form.comparison?.targets.find((item) => item.poi_ids.includes(draft.id));
    const publicBuyer = form.study_intent === 'choose_tool' && (!target || target.access_scope !== 'authenticated_workflow');
    const poi = poiOf(publicBuyer && draft.type === 'web' ? { ...draft, mode: 'observe_only' } : draft);
    // With one POI the sentence stands alone; with several it says which one.
    if (typeof poi === 'string') return form.pois.length > 1 ? `${poiTitle(draft, i)}: ${poi}` : poi;
    pois.push(poi);
  }
  if (!goal) return 'Say what the persona should try to do.';
  if (form.study_intent === 'choose_tool' && pois.length < 2) return 'Add at least two tools to choose between.';
  if (decisionBriefChanged(form)) return 'Apply the decision brief to update its criteria and tasks before saving. Your custom tasks remain unchanged until you apply it.';
  const problem = settingsProblem(settings) ?? (audience && audienceProblem(audience));
  if (problem) return problem;
  const invalidProfile = profileProblem(persona_schema);
  if (invalidProfile) return `Audience: ${invalidProfile}`;
  const config: ProjectConfig = {
    name,
    description: form.description.trim(),
    goal,
    role: form.role,
    pois,
    audience: audience && cleanAudience(audience),
    ...(form.comparison !== undefined ? { comparison: structuredClone(form.comparison) } : {}),
    ...(persona_schema ? { persona_schema } : {}),
    settings: {
      ...settings,
      local_base_url: settings.local_base_url?.trim() || null,
      routing: Object.fromEntries(ROLES.map((role) => [role, { ...settings.routing[role], model: settings.routing[role].model.trim() }])) as RunSettings['routing'],
    },
    ...(form.study_intent ? { study_intent: form.study_intent } : {}),
  };
  if (form.study_intent === 'choose_tool' && !config.comparison) config.comparison = draftComparison(config, form.decision_context ?? emptyDecisionContext());
  if (config.comparison) config.comparison = comparisonForIntent(config.comparison, form.study_intent);
  if (config.comparison) {
    config.comparison.assumptions = config.comparison.assumptions.map((s) => s.trim()).filter(Boolean);
    config.comparison.tasks = config.comparison.tasks.map((task) => ({ ...task, prerequisites: task.prerequisites.map((s) => s.trim()).filter(Boolean) }));
  }
  const comparisonProblems = validateComparison(config);
  return comparisonProblems.length ? `Comparison: ${comparisonProblems[0]}` : config;
}

/** The logins a run needs: each segment's role, or the built-in persona's role when there is no audience. */
export function rolesInUse(config: ProjectConfig): string[] {
  if (config.comparison) return [...new Set(config.comparison.targets.flatMap((target) => target.session_role ? [target.session_role] : []))];
  // Only personas that open a web app in full mode load a login; texts and designs are read without one.
  const roles = config.audience
    ? config.audience.segments.filter((segment) => segment.share > 0 && logsIn(config.pois, segment)).map((segment) => segment.role)
    : [logsIn(config.pois, null) ? config.role : null];
  return [...new Set(roles.filter((role): role is string => role !== null))];
}

/** A problem from `toConfig`, worded for the tab it is shown on: problems from another tab say where to fix them. */
export function problemFor(problem: string, tab: 'project' | 'settings' | 'audience'): string {
  const own = problem.startsWith('Settings: ') ? 'settings' : problem.startsWith('Audience: ') ? 'audience' : 'project';
  if (own === tab) return problem.replace(/^(Settings|Audience): /, '');
  return own === 'project' ? `On the Project tab: ${problem}` : problem;
}
