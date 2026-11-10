import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schema } from '@dicebear/lorelei';
import { HAIR, personaFace } from './face.ts';

test('the same slot in two audiences gets two faces, since the seed is id and name', () => {
  assert.notEqual(personaFace('p-seg1-01', 'Jennifer Adams', 'she'), personaFace('p-seg1-01', 'Jennifer Walsh', 'she'));
});

test('the hair pools name only Lorelei variants', () => {
  const known = new Set((schema.properties!.hair as { items: { enum: string[] } }).items.enum);
  for (const hair of Object.values(HAIR).flat()) assert.ok(known.has(String(hair)), String(hair));
});
