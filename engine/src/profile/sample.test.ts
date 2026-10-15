import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProfileAttribute } from '../types.ts';
import { getPersonaSchema } from './schema.ts';
import { sampleProfile } from './sample.ts';

const region: ProfileAttribute = {
  id: 'region', name: 'Region', description: 'Sales territory.', group: 'work', type: 'choice', core: false,
  enabled: true, show_on_card: true, use_in_prompt: true, report_dimension: true, choices: ['EMEA', 'Americas'],
  sampling: { default: { kind: 'choices', choices: [{ value: 'EMEA', weight: 60 }, { value: 'Americas', weight: 40 }] }, by_segment: { managers: { kind: 'fixed', value: 'Americas' } } },
};

test('attributes draw independently by seed and segment with fixed, choice and range rules', () => {
  const schema = getPersonaSchema();
  schema.attributes.push(region, { ...region, id: 'volume', name: 'Volume', type: 'number', choices: undefined, sampling: { default: { kind: 'range', min: 1, max: 50, integer: true }, by_segment: {} } });
  const a = sampleProfile(schema, 'recruiters', 123);
  assert.deepEqual(a, sampleProfile(structuredClone(schema), 'recruiters', 123));
  assert.equal(sampleProfile(schema, 'managers', 123).region, 'Americas');
  assert.ok(Number.isInteger(a.volume) && Number(a.volume) >= 1 && Number(a.volume) <= 50);
  const counts = Array.from({ length: 2000 }, (_, seed) => sampleProfile(schema, 'recruiters', seed));
  assert.ok(Math.abs(counts.filter((p) => p.region === 'EMEA').length / counts.length - 0.6) < 0.04);
  schema.attributes.find((a) => a.id === 'region')!.sampling!.default = { kind: 'fixed', value: 'Americas' };
  const { region: before, ...rest } = a;
  const { region: after, ...other } = sampleProfile(schema, 'recruiters', 123);
  assert.deepEqual(rest, other);
  schema.attributes.reverse();
  assert.deepEqual(sampleProfile(schema, 'recruiters', 123), { ...other, region: 'Americas' });
});

test('disabled fields are not sampled; prompt-private fields remain available for cards and reports', () => {
  const schema = getPersonaSchema();
  schema.attributes.push({ ...region, use_in_prompt: false });
  assert.ok(['EMEA', 'Americas'].includes(String(sampleProfile(schema, 'recruiters', 2).region)));
  schema.attributes.find((a) => a.id === 'region')!.enabled = false;
  assert.equal(sampleProfile(schema, 'recruiters', 2).region, undefined);
  assert.ok(Array.isArray(sampleProfile(schema, 'recruiters', 2).prior_tools));
});
