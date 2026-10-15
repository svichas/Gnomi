import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PersonaSchema, ProfileAttribute } from '@gnomi/engine/types.ts';
import { getPersonaSchema } from '@gnomi/engine/profile/schema.ts';
import { choiceValues, customAttribute, defaultRule, formatAttribute, parseProfileTemplate, serializeProfileTemplate, setAttributeChoices, setSegmentRule } from './profile.ts';

const schema: PersonaSchema = { version: 1, attributes: [] };

test('custom attribute IDs stay stable, unique, snake_case and bounded', () => {
  const first = customAttribute(schema, 'Procurement region', 'choice');
  assert.equal(first.id, 'procurement_region');
  const second = customAttribute({ ...schema, attributes: [first] }, 'Procurement region', 'number');
  assert.equal(second.id, 'procurement_region_2');
  assert.match(customAttribute(schema, '123 $$$', 'text').id, /^[a-z][a-z0-9_]{0,63}$/);
  assert.ok(customAttribute(schema, 'x'.repeat(120), 'text').id.length <= 64);
  assert.equal(customAttribute(schema, 'Attributes', 'text').id, 'attributes_2');
});

test('custom IDs cannot redefine optional built-ins omitted by an imported template', () => {
  const template = getPersonaSchema();
  template.attributes = template.attributes.filter((attribute) => attribute.id !== 'motivation');
  const custom = customAttribute(template, 'Motivation', 'choice');
  assert.equal(custom.id, 'motivation_2');
  template.attributes.push(custom);
  assert.doesNotThrow(() => serializeProfileTemplate(template));
});

test('templates round-trip custom segment rules and reject invalid or weakened core schemas before applying', () => {
  const template = getPersonaSchema();
  template.attributes.push(setSegmentRule(customAttribute(template, 'Procurement region', 'choice'), 'recruiters', { kind: 'fixed', value: 'Option A' }));
  assert.deepEqual(parseProfileTemplate(serializeProfileTemplate(template)), template);
  const before = structuredClone(template);
  assert.throws(() => parseProfileTemplate('{bad json'), /JSON|property/i);
  const weakened = structuredClone(template);
  weakened.attributes.find((attribute) => attribute.id === 'name')!.enabled = false;
  assert.throws(() => parseProfileTemplate(JSON.stringify(weakened)), /Core/i);
  const invalid = structuredClone(template);
  invalid.attributes.at(-1)!.sampling!.default = { kind: 'choices', choices: [{ value: 'Option A', weight: 0 }] };
  assert.throws(() => serializeProfileTemplate(invalid), /weighted choices/i);
  assert.deepEqual(template, before);
});

test('all custom types have typed default rules and independent segment overrides', () => {
  assert.deepEqual(defaultRule('number'), { kind: 'range', min: 1, max: 5, integer: true });
  assert.deepEqual(defaultRule('boolean'), { kind: 'choices', choices: [{ value: true, weight: 50 }, { value: false, weight: 50 }] });
  assert.deepEqual(defaultRule('list'), { kind: 'fixed', value: [] });
  const attribute = customAttribute(schema, 'Volume', 'number');
  const changed = setSegmentRule(attribute, 'recruiters', { kind: 'range', min: 10, max: 20, integer: true });
  assert.equal(Object.keys(attribute.sampling!.by_segment).length, 0);
  assert.deepEqual(changed.sampling!.default, attribute.sampling!.default);
  assert.deepEqual(changed.sampling!.by_segment.recruiters, { kind: 'range', min: 10, max: 20, integer: true });
  assert.deepEqual(setSegmentRule(changed, 'recruiters', null).sampling!.by_segment, {});
});

test('editing choice options preserves matching weights and removes obsolete values in every rule', () => {
  let attribute = customAttribute(schema, 'Procurement region', 'choice');
  attribute = { ...attribute, choices: ['EMEA', 'Americas'], sampling: {
    default: { kind: 'choices', choices: [{ value: 'EMEA', weight: 80 }, { value: 'Americas', weight: 20 }] },
    by_segment: { buyers: { kind: 'fixed', value: 'Americas' }, users: { kind: 'choices', choices: [{ value: 'EMEA', weight: 100 }, { value: 'Americas', weight: 0 }] } },
  } };
  const next = setAttributeChoices(attribute, ['EMEA', 'APAC']);
  assert.deepEqual(next.choices, ['EMEA', 'APAC']);
  assert.deepEqual(next.sampling!.default, { kind: 'choices', choices: [{ value: 'EMEA', weight: 80 }, { value: 'APAC', weight: 1 }] });
  assert.deepEqual(next.sampling!.by_segment.buyers, { kind: 'fixed', value: 'EMEA' });
  assert.deepEqual(next.sampling!.by_segment.users, { kind: 'choices', choices: [{ value: 'EMEA', weight: 100 }, { value: 'APAC', weight: 1 }] });
  assert.deepEqual(choiceValues(' EMEA\n\nAmericas\nEMEA '), ['EMEA', 'Americas']);
});

test('profile values render booleans and lists readably without losing false or zero', () => {
  const number = customAttribute(schema, 'Volume', 'number');
  assert.equal(formatAttribute(number, 0), '0');
  assert.equal(formatAttribute(customAttribute(schema, 'Uses CRM', 'boolean'), false), 'No');
  assert.equal(formatAttribute(customAttribute(schema, 'Tools', 'list'), ['ATS', 'Sheets']), 'ATS, Sheets');
  assert.equal(formatAttribute({ ...number, id: 'country' } as ProfileAttribute, 'DE'), 'Germany');
});
