import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { ProjectConfig } from '../types.ts';
import { applyDecisionBrief, decisionContextText, draftComparison, effectiveComparisonPois, validateComparison } from './config.ts';

export const comparisonProject = (): ProjectConfig => ({
  name: 'ATS comparison', description: 'Compare hiring tools', goal: 'Choose an ATS for a hiring team',
  role: null, audience: null, settings: DEFAULT_SETTINGS,
  pois: ['Workable', 'Lever', 'Ashby', 'Teamtailor'].map((name, i) => ({
    id: `poi-${i}`, name, type: 'web', start_url: `https://vendor${i}.example/`, mode: 'observe_only',
    segments: null, allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null,
  })),
});

test('all observe-only tools draft a neutral peer comparison without inferring ownership', () => {
  const project = comparisonProject();
  project.comparison = draftComparison(project);
  assert.equal(project.comparison.purpose, 'choose_tool');
  assert.equal(project.comparison.focal_target_id, null);
  assert.equal(project.comparison.targets.length, 4);
  assert.deepEqual(validateComparison(project), []);
  assert.ok(project.comparison.assumptions.length > 0);
  assert.match(project.comparison.tasks[0].instruction, /evidence/i);
});

test('public comparison scopes strip write/reset permissions and exclude unassigned sources without mutating setup', () => {
  const project = comparisonProject();
  project.comparison = draftComparison(project);
  const source = project.pois[0];
  if (source.type !== 'web') throw new Error('Web fixture required');
  source.mode = 'full';
  source.reset_hook_url = 'https://vendor0.example/reset';
  project.pois.push({ ...source, id: 'unused' });
  const effective = effectiveComparisonPois(project);
  assert.equal(effective.length, 4);
  assert.ok(effective[0].type === 'web');
  assert.equal(effective[0].mode, 'observe_only');
  assert.equal(effective[0].reset_hook_url, null);
  assert.equal(source.mode, 'full');
  assert.equal(source.reset_hook_url, 'https://vendor0.example/reset');
  project.comparison.targets[0].access_scope = 'authenticated_workflow';
  project.comparison.targets[0].session_role = 'tool-zero';
  assert.equal(effectiveComparisonPois(project)[0], source);
});

test('explicit focal role is independent of access, while references and sessions are validated', () => {
  const project = comparisonProject();
  const study = draftComparison(project);
  project.comparison = study;
  study.purpose = 'improve_own_product';
  assert.ok(validateComparison(project).some((issue) => /focal/i.test(issue)));
  study.focal_target_id = study.targets[0].id;
  assert.deepEqual(validateComparison(project), []);
  study.tasks[0].entries[0].poi_id = 'missing';
  study.tasks[0].criterion_ids.push('missing');
  assert.ok(validateComparison(project).some((issue) => /entry/i.test(issue)));
  assert.ok(validateComparison(project).some((issue) => /criterion/i.test(issue)));
});

test('legacy absence and null remain legacy; malformed version and duplicate identities fail', () => {
  const project = comparisonProject();
  assert.deepEqual(validateComparison(project), []);
  project.comparison = null;
  assert.deepEqual(validateComparison(project), []);
  project.comparison = draftComparison(project);
  project.comparison.targets[1].id = project.comparison.targets[0].id;
  assert.ok(validateComparison(project).some((issue) => /unique/i.test(issue)));
  assert.ok(validateComparison({ ...project, comparison: { version: 99 } } as unknown as ProjectConfig).length > 0);
});

test('task entries cannot silently authorize new hosts or reuse one login across vendors', () => {
  const project = comparisonProject();
  project.comparison = draftComparison(project);
  project.comparison.tasks[0].entries[0].start_url = 'https://unapproved.example/';
  assert.ok(validateComparison(project).some((issue) => /host/i.test(issue)));
  project.comparison.targets[0].session_role = 'admin';
  project.comparison.targets[1].session_role = 'admin';
  assert.ok(validateComparison(project).some((issue) => /session/i.test(issue)));
});

test('malformed URLs return issues and session roles respect the shared storage key bounds', () => {
  const project = comparisonProject();
  project.comparison = draftComparison(project);
  const poi = project.pois[0];
  if (poi.type !== 'web') throw new Error('Web fixture required');
  poi.start_url = 'not a URL';
  project.comparison.tasks[0].entries[0].start_url = 'https://v0.example/';
  assert.ok(validateComparison(project).some((issue) => /URL/.test(issue)));
  project.comparison.targets[0].session_role = `a${'b'.repeat(40)}`;
  assert.ok(validateComparison(project).some((issue) => /session_role/.test(issue)));
});

test('a buyer brief creates atomic requirements for one company and public research without invented work', () => {
  const project = { ...comparisonProject(), study_intent: 'choose_tool' as const };
  const context = { company_size: '120 employees, 4 recruiter seats', hiring_volume: '30 hires per year', budget: 'EUR 500/month, annual billing allowed', required_integrations: ['Slack', 'Google Workspace'], requirements: ['Structured interview scorecards', 'Candidate data export'], switching_constraints: 'Import 2,000 records from CSV' };
  const study = draftComparison(project, context);
  assert.equal(study.execution.collection, 'shared_research');
  assert.deepEqual(study.execution.research_environment, { locale: 'en-US', timezone: 'UTC' });
  assert.deepEqual(study.decision_context, context);
  assert.ok(study.criteria.some((item) => item.name === 'Slack integration'));
  assert.ok(study.criteria.some((item) => item.name === 'Candidate data export'));
  assert.ok(!study.criteria.some((item) => item.name === 'Capabilities and integrations'));
  assert.match(study.scenarios[0].context, /120 employees/);
  assert.match(study.tasks[0].instruction, /Do not create accounts/);
  assert.equal(study.tasks[0].requires_fixture, false);
  assert.deepEqual(validateComparison({ ...project, comparison: study }), []);
  assert.deepEqual(JSON.parse(JSON.stringify(study)), study);
  assert.match(decisionContextText(context), /30 hires per year/);
});

test('unknown company inputs stay assumptions and do not create invented must-have requirements', () => {
  const project = { ...comparisonProject(), study_intent: 'choose_tool' as const };
  const study = draftComparison(project);
  assert.ok(study.assumptions.some((item) => /Budget.*unspecified/.test(item)));
  assert.equal(study.criteria.find((item) => item.id === 'cost')?.importance, 'preference');
  assert.ok(study.criteria.every((item) => item.importance === 'preference'));
  const changed = applyDecisionBrief(study, 'Choose a tool for a remote team', { ...study.decision_context!, requirements: ['Interview scorecards'] });
  assert.match(changed.tasks[0].instruction, /remote team/);
  assert.match(changed.scenarios[0].context, /remote team/);
  assert.equal(study.question, project.goal);
});

test('shared research rejects authenticated targets, buyer carryover and workflow prerequisites', () => {
  const project = { ...comparisonProject(), study_intent: 'choose_tool' as const };
  project.comparison = draftComparison(project);
  project.comparison.tasks[0].requires_fixture = true;
  assert.ok(validateComparison(project).some((issue) => /prepared test data/.test(issue)));
  project.comparison.tasks[0].requires_fixture = false;
  project.comparison.execution.mode = 'buyer_journey';
  project.comparison.execution.carryover = 'prior_observations';
  assert.ok(validateComparison(project).some((issue) => /independent/.test(issue)));
  project.comparison.targets[0].access_scope = 'prototype';
  assert.ok(validateComparison(project).some((issue) => /public websites or documentation/.test(issue)));
});

test('choose-tool intent cannot silently run a legacy simulation', () => {
  assert.ok(validateComparison({ ...comparisonProject(), study_intent: 'choose_tool' }).some((issue) => /comparison/.test(issue)));
  assert.equal(draftComparison(comparisonProject()).execution.collection, undefined);
});

test('explicit intent cannot disagree with saved comparison purpose or workflow collection', () => {
  const project = { ...comparisonProject(), study_intent: 'choose_tool' as const };
  project.comparison = draftComparison(project);
  assert.ok(validateComparison({ ...project, study_intent: 'improve_product' }).some((issue) => /intent/.test(issue)));
  assert.ok(validateComparison({ ...project, study_intent: 'test_workflow' }).some((issue) => /persona tasks/.test(issue)));
  assert.deepEqual(validateComparison({ ...project, study_intent: undefined }), [], 'absent intent preserves a saved shared study');
  project.comparison.purpose = 'improve_own_product';
  project.comparison.focal_target_id = project.comparison.targets[0].id;
  assert.ok(validateComparison(project).some((issue) => /intent/.test(issue)));
});

test('enabling comparison for improve-product intent asks for ownership without guessing a focal tool', () => {
  const project = { ...comparisonProject(), study_intent: 'improve_product' as const };
  project.comparison = draftComparison(project);
  assert.equal(project.comparison.purpose, 'improve_own_product');
  assert.equal(project.comparison.focal_target_id, null);
  assert.ok(validateComparison(project).some((issue) => /focal target/.test(issue)));
});
