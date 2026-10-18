import { fnv1a, mulberry32 } from '../audience/sample.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import type { Persona, ProjectConfig } from '../types.ts';

export interface ComparisonPlannedEpisode {
  episode_id: string;
  block_id: string;
  persona_id: string;
  target_id: string;
  scenario_id: string;
  task_id: string;
  segment_id: string | null;
  eligible: boolean;
  /** Only sources the selected representative is eligible to access. */
  poi_ids: string[];
}
export interface ComparisonBlock {
  id: string;
  task_id: string;
  persona_id: string;
  target_order: string[];
  episodes: ComparisonPlannedEpisode[];
}
export interface ComparisonPlan {
  collection: 'shared_research' | 'persona_tasks';
  blocks: ComparisonBlock[];
  episodes: ComparisonPlannedEpisode[];
}

/** Every complete segment block puts each target in each position once. */
export function balancedTargetOrder(personas: { id: string; segment_id: string | null }[], targetIds: string[], seed: number): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const p of personas) {
    const segment = p.segment_id ?? '';
    const group = groups.get(segment) ?? [];
    group.push(p.id);
    groups.set(segment, group);
  }
  const orders = new Map<string, string[]>();
  for (const segment of [...groups.keys()].sort()) {
    const random = mulberry32(fnv1a(`comparison-order/${seed}/${segment}`));
    const targets = [...targetIds].sort();
    for (let i = targets.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [targets[i], targets[j]] = [targets[j], targets[i]];
    }
    groups.get(segment)!.sort().forEach((personaId, index) => {
      orders.set(personaId, targets.map((_, offset) => targets[(index + offset) % targets.length]));
    });
  }
  return orders;
}

/** The same pure schedule drives execution, estimates and replay denominators. */
export function comparisonPlan(config: { personas: Persona[]; project: Pick<ProjectConfig, 'comparison' | 'pois'>; seed?: number }): ComparisonPlan {
  const study = config.project.comparison;
  const collection = study?.execution.collection ?? 'persona_tasks';
  if (!study || !config.personas.length) return { collection, blocks: [], episodes: [] };
  const people = [...config.personas].sort((a, b) => a.id.localeCompare(b.id));
  const pois = new Map(config.project.pois.map((poi) => [poi.id, poi]));
  const orders = balancedTargetOrder(people, study.targets.map((target) => target.id), config.seed ?? 0);
  const candidate = (persona: Persona, taskId: string, targetId: string) => {
    const task = study.tasks.find((item) => item.id === taskId)!;
    const scenario = study.scenarios.find((item) => item.id === task.scenario_id)!;
    const target = study.targets.find((item) => item.id === targetId)!;
    const entry = task.entries.find((item) => item.target_id === targetId);
    const sourceIds = target.poi_ids.filter((id) => { const poi = pois.get(id); return !!poi && (poi.segments === null || poi.segments.includes(persona.segment_id ?? '')); });
    const eligible = (scenario.segment_ids === null || scenario.segment_ids.includes(persona.segment_id ?? '')) && !!entry && sourceIds.includes(entry.poi_id);
    return { eligible, poi_ids: sourceIds };
  };
  const block = (taskId: string, representative: Persona, shared: boolean): ComparisonBlock => {
    const task = study.tasks.find((item) => item.id === taskId)!;
    const id = JSON.stringify([study.execution.replicate_id, shared ? 'shared-research' : representative.id, task.scenario_id, task.id]);
    const target_order = orders.get(representative.id)!;
    return { id, task_id: taskId, persona_id: representative.id, target_order,
      episodes: target_order.map((target_id) => {
        const person = shared ? people.find((p) => candidate(p, taskId, target_id).eligible) ?? representative : representative;
        return { episode_id: JSON.stringify([study.execution.replicate_id, shared ? 'shared-research' : person.id, task.scenario_id, task.id, target_id]), block_id: id,
          persona_id: person.id, target_id, scenario_id: task.scenario_id, task_id: task.id, segment_id: shared ? null : person.segment_id,
          ...candidate(person, taskId, target_id) };
      }),
    };
  };
  let blocks: ComparisonBlock[];
  if (collection === 'shared_research') blocks = study.tasks.map((task) => block(task.id, people[0], true));
  else {
    // One block in every task/segment stratum before its second representative.
    const segments = [...new Set(people.map((p) => p.segment_id))].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
    const strata = study.tasks.flatMap((task) => segments.map((segment) => people.filter((p) => p.segment_id === segment).map((p) => block(task.id, p, false))));
    blocks = [];
    for (let index = 0; strata.some((group) => group[index]); index++) for (const group of strata) if (group[index]) blocks.push(group[index]);
  }
  return { collection, blocks, episodes: blocks.flatMap((item) => item.episodes) };
}

/** Identity and source eligibility are retained; personal biography never supplies research requirements. */
export function researchCollector(identity: Persona, environment = { locale: 'en-US', timezone: 'UTC' }): Persona {
  return { ...BUILTIN_PERSONA, id: identity.id, segment_id: identity.segment_id, seed: identity.seed, name: 'Research collector', pronouns: 'they',
    job_title: 'Research collector', seniority: 'mid', company_size: 0, industry: '', tech_skill: 5, patience: 5, familiarity_with_category: 'medium',
    device: 'desktop', language: environment.locale, languages: [environment.locale], timezone: environment.timezone,
    accessibility_needs: 'none', background: '', context_of_use: '', goal_interpretation: '', voice: '', attributes: {}, motivation: 3 };
}
