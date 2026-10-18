import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../acceptance/fixture.ts';
import { draftComparison } from '../comparison/config.ts';
import { profileSignature } from './signature.ts';

test('comparison biographies become stale when the fixed company or assigned requirements change', () => {
  const { project, personas } = fixture('http://localhost:3100');
  project.pois.push({ ...project.pois[0], id: 'alternative', name: 'Alternative' });
  project.comparison = draftComparison(project);
  const segment = project.audience!.segments[0];
  const seed = personas[0].seed;
  const before = profileSignature(project, segment, seed);
  project.comparison.decision_context = { company_size: '80 employees', hiring_volume: '30 hires per year', budget: 'EUR 400 monthly', required_integrations: ['Calendar'], requirements: ['Structured interview scorecards'], switching_constraints: 'Import existing candidates' };
  const company = profileSignature(project, segment, seed);
  assert.notEqual(company, before, 'the unchanged general goal cannot hide changed company needs');
  project.comparison.tasks[0].instruction = 'Evaluate the supplied hiring requirements from public documentation.';
  assert.notEqual(profileSignature(project, segment, seed), company);
});

test('comparison profile freshness ignores collection budgets and presentation settings', () => {
  const { project, personas } = fixture('http://localhost:3100');
  project.pois.push({ ...project.pois[0], id: 'alternative', name: 'Alternative' });
  project.comparison = draftComparison(project);
  const signature = () => profileSignature(project, project.audience!.segments[0], personas[0].seed);
  const before = signature();
  project.settings.cost_budget_usd *= 2;
  project.comparison.tasks[0].max_steps++;
  project.comparison.execution.analysis_reserve_fraction = 0.3;
  project.persona_schema!.attributes.forEach((attribute) => { attribute.show_on_card = !attribute.show_on_card; });
  assert.equal(signature(), before);
});
