import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { ProjectConfig } from '../types.ts';
import { draftComparison, effectiveComparisonPois, validateComparison } from './config.ts';

export const comparisonProject = (): ProjectConfig => ({
  name: 'ATS comparison', description: 'Compare hiring tools', goal: 'Choose an ATS for a hiring team',
  role: null, audience: null, settings: DEFAULT_SETTINGS,
  pois: ['Workable', 'Lever', 'Ashby', 'Teamtailor'].map((name, i) => ({
    id: `poi-${i}`, name, type: 'web', start_url: `https://vendor${i}.example/`, mode: 'observe_only',
    segments: null, allowed_hosts: [], production_domains: [], reset_hook_url: null,
  })),
});

test('comparison verifier routing is optional and limited to judge or navigator', () => {
  const project = comparisonProject();
  project.comparison = draftComparison(project);
  for (const verifier of [undefined, 'judge', 'navigator'] as const) {
    project.comparison.execution.verifier = verifier;
    assert.deepEqual(validateComparison(project), []);
  }
  const invalid = { ...project, comparison: { ...project.comparison, execution: { ...project.comparison.execution, verifier: 'author' } } } as unknown as ProjectConfig;
  assert.ok(validateComparison(invalid).some((issue) => issue.includes('execution.verifier')));
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
