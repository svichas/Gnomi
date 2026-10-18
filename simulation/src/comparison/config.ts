import { z } from 'zod';
import type { Poi, ProjectConfig } from '../types.ts';
import type { ComparisonDecisionContext, ComparisonStudy, ComparisonTarget } from './types.ts';

/** A declared public/documentation scope can only narrow the source's existing permissions. */
export function effectiveComparisonPoi(poi: Poi, target: ComparisonTarget): Poi {
  return poi.type === 'web' && target.access_scope !== 'authenticated_workflow'
    ? { ...poi, mode: 'observe_only', reset_hook_url: null }
    : poi;
}

/** Sources actually used by this study, with their narrowed permissions; legacy projects keep their sources. */
export function effectiveComparisonPois(project: ProjectConfig): Poi[] {
  if (!project.comparison) return project.pois;
  return project.pois.flatMap((poi) => {
    const target = project.comparison!.targets.find((target) => target.poi_ids.includes(poi.id));
    return target ? [effectiveComparisonPoi(poi, target)] : [];
  });
}

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const text = z.string().trim().min(1).max(4000);
const ids = z.array(id).min(1).max(32);
const briefText = z.string().trim().max(400);
const decisionContextSchema = z.object({ company_size: briefText, hiring_volume: briefText, budget: briefText, required_integrations: z.array(briefText.min(1)).max(10), requirements: z.array(briefText.min(1)).max(10), switching_constraints: briefText }).strict();
const studySchema = z.object({
  version: z.literal(1), purpose: z.enum(['improve_own_product', 'choose_tool']), focal_target_id: id.nullable(),
  question: text, decision_context: decisionContextSchema.optional(), assumptions: z.array(text).max(32),
  targets: z.array(z.object({ id, name: text, poi_ids: ids, access_scope: z.enum(['public_site', 'documentation', 'prototype', 'authenticated_workflow']), session_role: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).nullable() }).strict()).min(2).max(12),
  scenarios: z.array(z.object({ id, name: text, context: text, segment_ids: ids.nullable() }).strict()).min(1).max(16),
  tasks: z.array(z.object({ id, scenario_id: id, instruction: text, success_rule: text, prerequisites: z.array(text).max(32), requires_fixture: z.boolean().optional(), criterion_ids: ids, max_steps: z.number().int().min(1).max(100), entries: z.array(z.object({ target_id: id, poi_id: id, start_url: z.url().optional(), fixture: text.optional() }).strict()).min(1).max(12) }).strict()).min(1).max(32),
  criteria: z.array(z.object({ id, name: text, question: text, importance: z.enum(['must_have', 'preference']), evidence_required: text, decision_rule: text }).strict()).min(1).max(16),
  execution: z.object({ collection: z.enum(['shared_research', 'persona_tasks']).optional(), research_environment: z.object({ locale: text, timezone: text }).strict().optional(), mode: z.enum(['independent', 'buyer_journey']), carryover: z.enum(['none', 'prior_observations']), social: z.literal('off'), order: z.literal('balanced'), replicate_id: id, analysis_reserve_fraction: z.number().min(0.05).max(0.5) }).strict(),
}).strict();

/** Empty means valid, including a legacy project with no comparison. Pure and safe for setup UI. */
export function validateComparison(project: ProjectConfig): string[] {
  if (project.comparison == null) return project.study_intent === 'choose_tool' ? ['Choose-tool studies require an explicit comparison with at least two tools.'] : [];
  const parsed = studySchema.safeParse(project.comparison);
  if (!parsed.success) return parsed.error.issues.map((issue) => `Comparison ${issue.path.join('.')}: ${issue.message}`);
  const study = parsed.data;
  const errors: string[] = [];
  if (project.study_intent === 'choose_tool' && (study.purpose !== 'choose_tool' || study.focal_target_id !== null)) errors.push('Choose-tool intent requires a neutral buyer comparison without a focal product.');
  if (project.study_intent === 'improve_product' && study.purpose !== 'improve_own_product') errors.push('Improve-product intent requires an owner comparison with an explicitly selected focal target.');
  if (project.study_intent === 'test_workflow' && study.execution.collection === 'shared_research') errors.push('Workflow intent requires persona tasks; review the task prerequisites and access before running.');
  if (study.decision_context && study.decision_context.requirements.length + study.decision_context.required_integrations.length > 10) errors.push('Use at most 10 requirements and integrations in the decision brief.');
  if (study.execution.collection === 'shared_research') {
    if (study.targets.some((target) => !['public_site', 'documentation'].includes(target.access_scope))) errors.push('Shared research supports only public websites or documentation. Choose persona tasks for other access scopes.');
    if (study.execution.mode !== 'independent' || study.execution.carryover !== 'none') errors.push('Shared research must use independent collection without buyer-journey carryover.');
    if (study.tasks.some((task) => task.requires_fixture || task.entries.some((entry) => entry.fixture))) errors.push('Public shared research cannot require prepared test data or account fixtures. Use an authenticated workflow to test them.');
    const environment = study.execution.research_environment;
    if (!environment) errors.push('Shared research needs one fixed locale and timezone.');
    else {
      try { new Intl.Locale(environment.locale); } catch { errors.push('Research locale must be a valid language tag, such as en-US.'); }
      try { new Intl.DateTimeFormat('en', { timeZone: environment.timezone }); } catch { errors.push('Research timezone must be a valid timezone, such as Europe/Athens.'); }
    }
  }
  const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) errors.push(`${label} must be unique.`); };
  for (const key of ['targets', 'scenarios', 'tasks', 'criteria'] as const) unique(study[key].map((item) => item.id), `Comparison ${key} IDs`);
  const targetIds = new Set(study.targets.map((target) => target.id));
  if (study.purpose === 'improve_own_product' && !study.focal_target_id) errors.push('Choose an explicit focal target for improving your own product.');
  if (study.focal_target_id !== null && !targetIds.has(study.focal_target_id)) errors.push('The focal target must be a comparison target.');
  if (study.execution.mode === 'independent' && study.execution.carryover !== 'none') errors.push('Independent comparisons cannot carry prior observations between targets.');
  if (study.execution.mode === 'buyer_journey' && study.execution.carryover !== 'prior_observations') errors.push('Buyer journeys must declare prior-observation carryover.');
  unique(study.targets.flatMap((target) => target.session_role === null ? [] : [target.session_role]), 'Target session roles');
  unique(study.targets.flatMap((target) => target.poi_ids), 'Target POI assignments');
  const pois = new Map(project.pois.map((poi) => [poi.id, poi]));
  const segments = new Set(project.audience?.segments.map((segment) => segment.id) ?? []);
  for (const target of study.targets) {
    for (const poiId of target.poi_ids) if (!pois.has(poiId)) errors.push(`Target ${target.name} references unknown POI ${poiId}.`);
    for (const poiId of target.poi_ids) {
      const poi = pois.get(poiId);
      if (poi?.type === 'web') {
        try {
          const url = new URL(poi.start_url);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) errors.push(`Target ${target.name} requires a valid HTTP(S) source URL without embedded credentials.`);
        } catch { errors.push(`Target ${target.name} has an invalid source URL.`); }
      }
    }
    if (target.access_scope === 'authenticated_workflow') {
      if (!target.session_role) errors.push(`Authenticated target ${target.name} requires a target-specific session role.`);
      if (target.poi_ids.some((poiId) => { const poi = pois.get(poiId); return poi?.type !== 'web' || poi.mode !== 'full'; })) errors.push(`Authenticated target ${target.name} requires full-access web sources.`);
    } else if (target.session_role !== null) errors.push(`Only an authenticated workflow may use a saved session (${target.name}).`);
  }
  for (const scenario of study.scenarios) for (const segment of scenario.segment_ids ?? []) if (!segments.has(segment)) errors.push(`Scenario ${scenario.name} references unknown segment ${segment}.`);
  for (const task of study.tasks) {
    if (!study.scenarios.some((scenario) => scenario.id === task.scenario_id)) errors.push(`Task ${task.id} references an unknown scenario.`);
    unique(task.criterion_ids, `Task ${task.id} criterion IDs`);
    for (const criterion of task.criterion_ids) if (!study.criteria.some((item) => item.id === criterion)) errors.push(`Task ${task.id} references unknown criterion ${criterion}.`);
    unique(task.entries.map((entry) => entry.target_id), `Task ${task.id} target entries`);
    for (const target of study.targets) if (!task.entries.some((entry) => entry.target_id === target.id)) errors.push(`Task ${task.id} needs an entry for ${target.name}.`);
    for (const entry of task.entries) {
      const target = study.targets.find((candidate) => candidate.id === entry.target_id);
      const poi = pois.get(entry.poi_id);
      if (!target?.poi_ids.includes(entry.poi_id) || !poi) errors.push(`Task ${task.id} entry must use one of that target's POIs.`);
      if (entry.start_url) {
        if (poi?.type !== 'web') errors.push(`Task ${task.id} has a URL entry for a non-web source.`);
        else {
          try {
            const url = new URL(entry.start_url);
            const allowed = [new URL(poi.start_url).hostname, ...poi.allowed_hosts];
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !allowed.includes(url.hostname)) errors.push(`Task ${task.id} entry host must already be permitted by its POI.`);
          } catch { errors.push(`Task ${task.id} has an invalid source or entry URL.`); }
        }
      }
    }
  }
  return errors;
}

/** Exploratory draft, shown for review before execution; never infers ownership or widens permissions. */
export function draftComparison(project: ProjectConfig, context?: ComparisonDecisionContext): ComparisonStudy {
  const targets = project.pois.map((poi) => ({ id: `target-${poi.id}`, name: poi.name, poi_ids: [poi.id], access_scope: poi.type === 'web' ? 'public_site' as const : 'prototype' as const, session_role: null }));
  const criteria: ComparisonStudy['criteria'] = [
    { id: 'fit', name: 'Fit for the stated needs', question: 'What supports or contradicts suitability for the stated use case?', importance: 'must_have', evidence_required: 'A relevant captured claim or demonstrated behavior tied to the stated use case.', decision_rule: 'Meets only when the stated requirements have positive support; an explicit mismatch does not meet; undisclosed requirements remain unknown.' },
    { id: 'cost', name: 'Applicable plan and cost', question: 'What plan and pricing terms apply to the same stated team and use case?', importance: 'must_have', evidence_required: 'Captured tier, eligibility, currency, billing period, size or seat band, date, and add-ons when visible.', decision_rule: 'Missing price, a quote requirement, an unknown company size or incompatible tiers means unknown cost; never substitute starting prices or model memory.' },
    { id: 'requirements', name: 'Capabilities and integrations', question: 'Which requirements and integrations are evidenced for this use case?', importance: 'preference', evidence_required: 'Relevant source excerpts or observed actions; label vendor claims separately from observed workflow behavior.', decision_rule: 'Only explicit supported requirements can meet; failure to find a capability is unknown, never evidence of absence.' },
    { id: 'evaluation', name: 'Next evaluation step', question: 'What is the next feasible step to evaluate this tool and what setup does it require?', importance: 'preference', evidence_required: 'A captured trial, demo, documentation or setup path and its prerequisites.', decision_rule: 'A concrete permitted next step meets; unavailable prerequisites remain a coverage limitation, not a product defect.' },
  ];
  const study: ComparisonStudy = {
    version: 1, purpose: project.study_intent === 'improve_product' ? 'improve_own_product' : 'choose_tool', focal_target_id: null, question: project.goal,
    assumptions: ['Exploratory comparison using only the selected sources and existing permissions.', 'Unspecified budget, company size, integrations and switching constraints remain unknown; recommendations are conditional.', 'Public pages and supplied artifacts establish claims, not authenticated workflow performance.'],
    targets,
    scenarios: [{ id: 'scenario-shared', name: 'Shared evaluation needs', context: project.goal, segment_ids: null }],
    tasks: [{ id: 'task-research', scenario_id: 'scenario-shared', instruction: `Gather source evidence about this tool for the shared goal: ${project.goal}. Identify supported capabilities, applicable plan and cost, stated requirements and the next evaluation step. Gnomi will compare tools after collection; do not expect this tool to provide an independent comparison directory or invent an account, incoming link or task.`, success_rule: 'Record relevant evidence and explicitly identify unresolved requirements. A documented mismatch or quote requirement can complete research without demonstrating purchase fit or live workflow success.', prerequisites: ['Use only the configured source; no account, fixture or incoming link is assumed.'], criterion_ids: criteria.map((criterion) => criterion.id), max_steps: 12, entries: targets.map((target, i) => ({ target_id: target.id, poi_id: project.pois[i].id })) }],
    criteria, execution: { mode: 'independent', carryover: 'none', social: 'off', order: 'balanced', replicate_id: 'replicate-1', analysis_reserve_fraction: 0.2 },
  };
  if (project.study_intent !== 'choose_tool' && context === undefined) return study;
  return applyDecisionBrief(study, project.goal, context ?? emptyDecisionContext());
}

export const emptyDecisionContext = (): ComparisonDecisionContext => ({ company_size: '', hiring_volume: '', budget: '', required_integrations: [], requirements: [], switching_constraints: '' });

export function cleanDecisionContext(input: ComparisonDecisionContext): ComparisonDecisionContext {
  return { company_size: input.company_size.trim(), hiring_volume: input.hiring_volume.trim(), budget: input.budget.trim(), switching_constraints: input.switching_constraints.trim(), requirements: input.requirements.map((value) => value.trim()).filter(Boolean), required_integrations: input.required_integrations.map((value) => value.trim()).filter(Boolean) };
}

/** The same fixed company brief is shown to research, audience writing and reviewers. */
export function decisionContextText(context: ComparisonDecisionContext): string {
  return [
    `Company size and seats: ${context.company_size || 'unspecified'}`,
    `Hiring volume: ${context.hiring_volume || 'unspecified'}`,
    `Budget: ${context.budget || 'unspecified'}`,
    `Required integrations: ${context.required_integrations.join('; ') || 'unspecified'}`,
    `Requirements: ${context.requirements.join('; ') || 'unspecified'}`,
    `Switching constraints: ${context.switching_constraints || 'unspecified'}`,
  ].join('\n');
}

/** Explicitly replaces the generated rubric; callers must not silently erase customized tasks. */
export function applyDecisionBrief(study: ComparisonStudy, question: string, input: ComparisonDecisionContext): ComparisonStudy {
  const context = cleanDecisionContext(input);
  const criterion = (id: string, name: string, requirement: string, importance: 'must_have' | 'preference' = 'must_have'): ComparisonStudy['criteria'][number] => ({ id, name, importance, question: `Does this tool support ${requirement} for the stated company?`, evidence_required: 'An exact source excerpt naming the capability, plan or restriction; public vendor statements remain vendor claims.', decision_rule: `Meets requires explicit support for: ${requirement}. An explicit incompatible restriction does not meet. Missing, ambiguous or inaccessible evidence is unknown; do not invent functionality or perform the workflow.` });
  const criteria = [
    ...context.requirements.map((value, i) => criterion(`requirement-${i + 1}`, value, value)),
    ...context.required_integrations.map((value, i) => criterion(`integration-${i + 1}`, `${value} integration`, `integration with ${value}`)),
    ...(context.company_size ? [criterion('company-size', 'Company size and seats', context.company_size)] : []),
    ...(context.hiring_volume ? [criterion('hiring-volume', 'Hiring volume', context.hiring_volume)] : []),
    criterion('cost', 'Applicable plan and cost', context.budget ? `cost within ${context.budget}` : 'a disclosed applicable plan and pricing terms', context.budget ? 'must_have' : 'preference'),
    ...(context.switching_constraints ? [criterion('switching', 'Switching requirements', context.switching_constraints)] : []),
    criterion('evaluation', 'Next evaluation step', 'a documented demo, trial or documentation path without submitting forms', 'preference'),
  ];
  const cost = criteria.find((item) => item.id === 'cost')!;
  cost.evidence_required = 'Exact pricing terms including applicable plan, seat or company eligibility, currency, billing period, add-ons, exclusions and quote requirement. Never compare incompatible plans or treat starting prices as the company cost.';
  cost.decision_rule += ' An undisclosed price or quote requirement leaves cost unknown; retain the stated quote requirement as useful evidence.';
  const publicResearch = study.targets.every((target) => ['public_site', 'documentation'].includes(target.access_scope));
  const assumptions = ['One company brief applies to every tool. Stakeholders may differ in priorities, not company facts.', 'Public sources establish vendor claims, not verified workflow performance.', ...decisionContextText(context).split('\n').filter((line) => line.endsWith('unspecified')).map((line) => `${line}. No requirement or disqualification is inferred from this missing input.`)];
  const scenario = { id: 'scenario-shared', name: 'Company decision', context: `Decision: ${question}\n${decisionContextText(context)}`, segment_ids: null };
  return { ...study, question, decision_context: context, assumptions, scenarios: [scenario], criteria,
    tasks: [{ id: 'task-research', scenario_id: scenario.id, instruction: `Research this tool for the decision: ${question}. Gather the source evidence required by each criterion for the fixed company brief. Do not create accounts, candidate records, jobs, inbox tasks or invitations. Do not submit forms or ask the vendor to compare competitors. Gnomi compares the captured evidence after collection.`, success_rule: 'Capture relevant evidence for the assigned criteria and state unresolved questions. A quote requirement or documented mismatch can complete research; missing information does not prove missing capability.', prerequisites: ['Only the configured public pages or supplied materials; no account, invitation, candidate or test data is assumed.'], requires_fixture: false, criterion_ids: criteria.map((item) => item.id), max_steps: 12, entries: study.targets.map((target) => ({ target_id: target.id, poi_id: target.poi_ids[0] ?? '' })) }],
    execution: { ...study.execution, collection: publicResearch ? study.execution.collection ?? 'shared_research' : 'persona_tasks', mode: 'independent', carryover: 'none', ...(publicResearch ? { research_environment: study.execution.research_environment ?? { locale: 'en-US', timezone: 'UTC' } } : {}) },
  };
}
