import assert from 'node:assert/strict';
import { test } from 'node:test';
import { criterionExcerpt } from './evidence.ts';
import type { ComparisonCriterion } from './types.ts';

test('small per-source allowances preserve criterion matches and their local negations', () => {
  const criteria: ComparisonCriterion[] = Array.from({ length: 16 }, (_, i) => ({ id: `c${i}`, name: `capability${i}`, question: '', evidence_required: '', decision_rule: '', importance: 'must_have' }));
  const text = criteria.map((criterion) => `${'x'.repeat(1000)} Does not include ${criterion.name} on this plan. `).join('');
  const excerpt = criterionExcerpt(text, 2250, criteria);
  assert.ok(excerpt.length <= 2250);
  for (const criterion of criteria) assert.ok(excerpt.includes(`Does not include ${criterion.name} on this plan.`), `${criterion.name} retains the actual claim and negation`);
  assert.match(excerpt, /excerpt gap/);
});

test('source excerpts retain opposing claims at the first and last match', () => {
  const criteria: ComparisonCriterion[] = [{ id: 'cost', name: 'Pricing', question: '', evidence_required: '', decision_rule: '', importance: 'must_have' }];
  const text = `${'Navigation '.repeat(200)}Pricing includes unlimited seats.${' Other content.'.repeat(500)}Pricing excludes additional seats.`;
  const excerpt = criterionExcerpt(text, 1000, criteria);
  assert.ok(excerpt.length <= 1000);
  assert.match(excerpt, /Pricing includes unlimited seats/);
  assert.match(excerpt, /Pricing excludes additional seats/);
});
