import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PERSONA } from '../persona.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { ProjectConfig } from '../types.ts';
import { draftComparison } from './config.ts';
import { comparisonPlan, researchCollector } from './planning.ts';

function fixture() {
  const project: ProjectConfig = { name: 'Tools', description: '', goal: 'Choose', role: null, audience: null, settings: DEFAULT_SETTINGS,
    pois: ['a', 'b'].map((id) => ({ id, name: id, type: 'web', start_url: `https://${id}.example`, mode: 'observe_only', segments: null, allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null })) };
  project.comparison = draftComparison(project);
  const personas = Array.from({ length: 20 }, (_, i) => ({ ...BUILTIN_PERSONA, id: `p-${String(i).padStart(2, '0')}`, segment_id: i < 10 ? 'small' : 'large' }));
  return { project, personas, seed: 7 };
}

test('shared research schedules each target once without counting unselected personas as missing observations', () => {
  const input = fixture();
  input.project.comparison!.execution.collection = 'shared_research';
  const plan = comparisonPlan(input);
  assert.equal(plan.blocks.length, 1);
  assert.equal(plan.episodes.length, 2);
  assert.ok(plan.episodes.every((job) => job.eligible && job.segment_id === null));
  assert.deepEqual(plan, comparisonPlan({ ...input, personas: [...input.personas].reverse() }));
  input.project.comparison!.execution.collection = 'persona_tasks';
  assert.equal(comparisonPlan(input).episodes.length, 40);
});

test('research representatives and source lists respect scenario and individual source eligibility', () => {
  const input = fixture();
  input.project.comparison!.execution.collection = 'shared_research';
  input.project.pois[0].segments = ['small'];
  input.project.pois[1].segments = ['large'];
  const plan = comparisonPlan(input);
  assert.equal(plan.episodes.find((job) => job.target_id === 'target-a')!.persona_id, 'p-00');
  assert.equal(plan.episodes.find((job) => job.target_id === 'target-b')!.persona_id, 'p-10');
  input.project.comparison!.scenarios[0].segment_ids = ['small'];
  assert.equal(comparisonPlan(input).episodes.find((job) => job.target_id === 'target-b')!.eligible, false);
});

test('persona blocks cover each task and segment before admitting a second representative', () => {
  const input = fixture();
  const study = input.project.comparison!;
  study.tasks.push({ ...study.tasks[0], id: 'second-task' });
  const plan = comparisonPlan(input);
  const first = plan.blocks.slice(0, 4);
  assert.deepEqual(new Set(first.map((block) => `${block.task_id}/${input.personas.find((p) => p.id === block.persona_id)!.segment_id}`)), new Set(['task-research/small', 'task-research/large', 'second-task/small', 'second-task/large']));
});

test('shared collectors retain identity only and use the frozen environment rather than sampled biographies', () => {
  const input = fixture();
  const collector = researchCollector(input.personas[0], { locale: 'el-GR', timezone: 'Europe/Athens' });
  assert.equal(collector.id, input.personas[0].id);
  assert.equal(collector.segment_id, input.personas[0].segment_id);
  assert.equal(collector.device, 'desktop');
  assert.deepEqual(collector.languages, ['el-GR']);
  assert.equal(collector.timezone, 'Europe/Athens');
  assert.equal(collector.background, '');
  assert.equal(collector.company_size, 0, 'the company scenario supplies requirements, not the collector');
});
