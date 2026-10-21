import { z } from 'zod';
import type { Poi, ProjectConfig } from '../types.ts';
import type { ComparisonStudy, ComparisonTarget } from './types.ts';

/** A declared public/documentation scope can only narrow the source's existing permissions. */
export function effectiveComparisonPoi(poi: Poi, target: ComparisonTarget): Poi {
  return poi.type === 'web' && target.access_scope !== 'authenticated_workflow'
    ? { ...poi, mode: 'observe_only', reset_hook_url: null }
    : poi;
}

/** Whether a study scenario covers a persona's segment (null for the built-in persona); false for a scenario the study lacks. */
export function inScenario(study: ComparisonStudy, scenarioId: string, segmentId: string | null): boolean {
  const scenario = study.scenarios.find((s) => s.id === scenarioId);
  return !!scenario && (scenario.segment_ids === null || scenario.segment_ids.includes(segmentId ?? ''));
}

/** Whether a study source takes a persona's segment: every one when it lists none, never the built-in persona when it does. */
export const admits = (poi: Pick<Poi, 'segments'>, segmentId: string | null): boolean => poi.segments === null || poi.segments.includes(segmentId ?? '');

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
const studySchema = z.object({
  version: z.literal(1), purpose: z.enum(['improve_own_product', 'choose_tool']), focal_target_id: id.nullable(),
  question: text, assumptions: z.array(text).max(32),
  targets: z.array(z.object({ id, name: text, poi_ids: ids, access_scope: z.enum(['public_site', 'documentation', 'prototype', 'authenticated_workflow']), session_role: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).nullable() }).strict()).min(2).max(12),
  scenarios: z.array(z.object({ id, name: text, context: text, segment_ids: ids.nullable() }).strict()).min(1).max(16),
  tasks: z.array(z.object({ id, scenario_id: id, instruction: text, success_rule: text, prerequisites: z.array(text).max(32), requires_fixture: z.boolean().optional(), criterion_ids: ids, max_steps: z.number().int().min(1).max(100), entries: z.array(z.object({ target_id: id, poi_id: id, start_url: z.url().optional(), fixture: text.optional() }).strict()).min(1).max(12) }).strict()).min(1).max(32),
  criteria: z.array(z.object({ id, name: text, question: text, importance: z.enum(['must_have', 'preference']), evidence_required: text, decision_rule: text }).strict()).min(1).max(16),
  execution: z.object({ mode: z.enum(['independent', 'buyer_journey']), carryover: z.enum(['none', 'prior_observations']), social: z.literal('off'), order: z.literal('balanced'), replicate_id: id, analysis_reserve_fraction: z.number().min(0.05).max(0.5), verifier: z.enum(['judge', 'navigator']).optional() }).strict(),
}).strict();

/** Empty means valid, including a legacy project with no comparison. Pure and safe for setup UI. */
export function validateComparison(project: ProjectConfig): string[] {
  if (project.comparison == null) return [];
  const parsed = studySchema.safeParse(project.comparison);
  if (!parsed.success) return parsed.error.issues.map((issue) => `Comparison ${issue.path.join('.')}: ${issue.message}`);
  const study = parsed.data;
  const errors: string[] = [];
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
export function draftComparison(project: ProjectConfig): ComparisonStudy {
  const targets = project.pois.map((poi) => ({ id: `target-${poi.id}`, name: poi.name, poi_ids: [poi.id], access_scope: poi.type === 'web' ? 'public_site' as const : 'prototype' as const, session_role: null }));
  const criteria: ComparisonStudy['criteria'] = [
    { id: 'fit', name: 'Fit for the stated needs', question: 'What supports or contradicts suitability for the stated use case?', importance: 'must_have', evidence_required: 'A relevant captured claim or demonstrated behavior tied to the stated use case.', decision_rule: 'Meets only when the stated requirements have positive support; an explicit mismatch does not meet; undisclosed requirements remain unknown.' },
    { id: 'cost', name: 'Applicable plan and cost', question: 'What plan and pricing terms apply to the same stated team and use case?', importance: 'must_have', evidence_required: 'Captured tier, eligibility, currency, billing period, size or seat band, date, and add-ons when visible.', decision_rule: 'Missing price, a quote requirement, an unknown company size or incompatible tiers means unknown cost; never substitute starting prices or model memory.' },
    { id: 'requirements', name: 'Capabilities and integrations', question: 'Which requirements and integrations are evidenced for this use case?', importance: 'preference', evidence_required: 'Relevant source excerpts or observed actions; label vendor claims separately from observed workflow behavior.', decision_rule: 'Only explicit supported requirements can meet; failure to find a capability is unknown, never evidence of absence.' },
    { id: 'evaluation', name: 'Next evaluation step', question: 'What is the next feasible step to evaluate this tool and what setup does it require?', importance: 'preference', evidence_required: 'A captured trial, demo, documentation or setup path and its prerequisites.', decision_rule: 'A concrete permitted next step meets; unavailable prerequisites remain a coverage limitation, not a product defect.' },
  ];
  return {
    version: 1, purpose: 'choose_tool', focal_target_id: null, question: project.goal,
    assumptions: ['Exploratory comparison using only the selected sources and existing permissions.', 'Unspecified budget, company size, integrations and switching constraints remain unknown; recommendations are conditional.', 'Public pages and supplied artifacts establish claims, not authenticated workflow performance.'],
    targets,
    scenarios: [{ id: 'scenario-shared', name: 'Shared evaluation needs', context: project.goal, segment_ids: null }],
    tasks: [{ id: 'task-research', scenario_id: 'scenario-shared', instruction: `Gather source evidence about this tool for the shared goal: ${project.goal}. Identify supported capabilities, applicable plan and cost, stated requirements and the next evaluation step. Gnomi will compare tools after collection; do not expect this tool to provide an independent comparison directory or invent an account, incoming link or task.`, success_rule: 'Record relevant evidence and explicitly identify unresolved requirements. A documented mismatch or quote requirement can complete research without demonstrating purchase fit or live workflow success.', prerequisites: ['Use only the configured source; no account, fixture or incoming link is assumed.'], criterion_ids: criteria.map((criterion) => criterion.id), max_steps: 12, entries: targets.map((target, i) => ({ target_id: target.id, poi_id: project.pois[i].id })) }],
    criteria, execution: { mode: 'independent', carryover: 'none', social: 'off', order: 'balanced', replicate_id: 'replicate-1', analysis_reserve_fraction: 0.2 },
  };
}
