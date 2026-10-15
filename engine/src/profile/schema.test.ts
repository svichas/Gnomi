import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PERSONA } from '../persona.ts';
import type { PersonaSchema, ProfileAttribute } from '../types.ts';
import { attributeValue, getPersonaSchema, isAttributeEnabled, profileEntries, validatePersonaSchema } from './schema.ts';

export const custom: ProfileAttribute = {
  id: 'region', name: 'Region', description: 'The sales region this person works in.', group: 'work', type: 'choice',
  core: false, enabled: true, show_on_card: true, use_in_prompt: true, report_dimension: true, choices: ['EMEA', 'Americas'],
  sampling: { default: { kind: 'choices', choices: [{ value: 'EMEA', weight: 70 }, { value: 'Americas', weight: 30 }] }, by_segment: {} },
};

test('the shipped schema is valid, returns independent copies, and covers the full profile groups', () => {
  const schema = getPersonaSchema();
  validatePersonaSchema(schema);
  assert.deepEqual(new Set(schema.attributes.map((a) => a.group)), new Set(['identity', 'work', 'capability', 'context', 'psychology', 'intent', 'voice', 'biography']));
  for (const id of ['country', 'timezone', 'languages', 'seed', 'name', 'background', 'voice', 'goal_interpretation', 'device', 'tech_skill', 'patience']) {
    assert.ok(schema.attributes.find((a) => a.id === id)?.core, id);
  }
  schema.attributes[0].name = 'Changed';
  assert.notEqual(getPersonaSchema().attributes[0].name, 'Changed');
  assert.deepEqual(attributeValue(BUILTIN_PERSONA, getPersonaSchema().attributes.find((a) => a.id === 'languages')!), ['en']);
});

test('profile projections obey enabled and each surface flag, including built-in fields', () => {
  const schema: PersonaSchema = { ...getPersonaSchema(), attributes: [...getPersonaSchema().attributes, structuredClone(custom)] };
  schema.attributes.find((a) => a.id === 'employer')!.enabled = false;
  schema.attributes.find((a) => a.id === 'pronouns')!.use_in_prompt = false;
  schema.attributes.find((a) => a.id === 'device')!.show_on_card = false;
  const persona = { ...BUILTIN_PERSONA, employer: 'Private Corp', attributes: { region: 'EMEA', ignored: 'never visible' } };
  const ids = (purpose: 'card' | 'prompt' | 'report' | 'all') => profileEntries(persona, schema, purpose).map((e) => e.attribute.id);
  for (const purpose of ['card', 'prompt', 'report', 'all'] as const) {
    assert.ok(!ids(purpose).includes('employer'));
    assert.ok(!ids(purpose).includes('ignored'));
    assert.ok(ids(purpose).includes('region'));
  }
  assert.ok(!ids('prompt').includes('pronouns'));
  assert.ok(ids('card').includes('pronouns'));
  assert.ok(!ids('card').includes('device'));
  assert.ok(ids('prompt').includes('device'));
  assert.equal(isAttributeEnabled(schema, 'pronouns', 'prompt'), false);
  assert.equal(isAttributeEnabled(schema, 'not_known'), false);
});

test('schema imports reject weakening core fields and redefining engine or prototype identities', () => {
  for (const change of [
    (s: PersonaSchema) => { s.attributes = s.attributes.filter((a) => a.id !== 'device'); },
    (s: PersonaSchema) => { s.attributes.find((a) => a.id === 'country')!.core = false; },
    (s: PersonaSchema) => { s.attributes.find((a) => a.id === 'languages')!.enabled = false; },
    (s: PersonaSchema) => { s.attributes.find((a) => a.id === 'background')!.use_in_prompt = false; },
    (s: PersonaSchema) => { s.attributes.find((a) => a.id === 'patience')!.sampling = custom.sampling; },
    (s: PersonaSchema) => { s.attributes.find((a) => a.id === 'name')!.type = 'number'; },
    (s: PersonaSchema) => { s.attributes.push({ ...custom, id: 'segment_id' }); },
    (s: PersonaSchema) => { s.attributes.push({ ...custom, id: '__proto__' }); },
    (s: PersonaSchema) => { s.attributes.push({ ...custom, core: true }); },
    (s: PersonaSchema) => { s.attributes.push({ ...custom }, { ...custom }); },
  ]) {
    const schema = getPersonaSchema();
    change(schema);
    assert.throws(() => validatePersonaSchema(schema), /profile|attribute|schema|core/i);
  }
  const polluted = JSON.parse(JSON.stringify({ ...getPersonaSchema(), attributes: [...getPersonaSchema().attributes, custom] }).replace('"by_segment":{}', '"by_segment":{"__proto__":{"kind":"fixed","value":"EMEA"}}'));
  assert.throws(() => validatePersonaSchema(polluted), /profile|schema|attribute/i);
});

test('sampling validation rejects incompatible values, nonfinite or empty weights, bad bounds and oversized input', () => {
  const invalid: unknown[] = [
    { kind: 'fixed', value: 'APAC' },
    { kind: 'fixed', value: 10 },
    { kind: 'range', min: 1, max: 3, integer: true },
    { kind: 'choices', choices: [{ value: 'EMEA', weight: 0 }] },
    { kind: 'choices', choices: [{ value: 'EMEA', weight: Infinity }] },
    { kind: 'choices', choices: [{ value: 'EMEA', weight: -1 }] },
    { kind: 'choices', choices: [{ value: 'APAC', weight: 1 }] },
    { kind: 'choices', choices: [{ value: 'EMEA', weight: 1 }, { value: 'EMEA', weight: 1 }] },
  ];
  for (const rule of invalid) {
    const schema = getPersonaSchema();
    schema.attributes.push({ ...custom, sampling: { default: rule as never, by_segment: {} } });
    assert.throws(() => validatePersonaSchema(schema));
  }
  const schema = getPersonaSchema();
  schema.attributes.push({ ...custom, id: 'volume', type: 'number', choices: undefined, sampling: { default: { kind: 'range', min: 4, max: 2, integer: true }, by_segment: {} } });
  assert.throws(() => validatePersonaSchema(schema));
  assert.throws(() => validatePersonaSchema({ version: 1, attributes: Array(1000).fill(custom) }));
});
