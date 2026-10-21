import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { getPersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import { blankAudience } from '../renderer/src/audience.ts';
import { AudienceLibrary } from './audiences.ts';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-audiences-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'audiences.json');
  return { file, library: new AudienceLibrary(file) };
}

test('saved audiences list newest first, and a name already saved is replaced in place of a duplicate', (t) => {
  const { library } = setup(t);
  assert.deepEqual(library.list(), []);
  const first = library.save(' Recruiters ', blankAudience({ name: 'Hiring teams', role: null, goal: '' }), getPersonaSchema());
  library.save('Buyers', blankAudience({ name: 'Finance leads', role: null, goal: '' }), getPersonaSchema());
  const replaced = library.save('recruiters', { ...blankAudience({ name: 'Hiring teams', role: null, goal: '' }), persona_count: 12 }, getPersonaSchema());
  assert.equal(first.name, 'Recruiters');
  assert.equal(replaced.id, first.id);
  assert.deepEqual(library.list().map((entry) => [entry.name, entry.audience.persona_count]), [['recruiters', 12], ['Buyers', 50]]);
  assert.deepEqual(library.remove(first.id).map((entry) => entry.name), ['Buyers']);
});

test('saving checks the name, the audience and the profile schema', (t) => {
  const { library } = setup(t);
  assert.throws(() => library.save('  ', blankAudience({ name: '', role: null, goal: '' }), getPersonaSchema()), /name/);
  assert.throws(() => library.save('A', { ...blankAudience({ name: '', role: null, goal: '' }), segments: [] }, getPersonaSchema()), /segments/);
  assert.throws(() => library.save('A', { ...blankAudience({ name: '', role: null, goal: '' }), countries: { XX: 100 } }, getPersonaSchema()));
  assert.throws(() => library.save('A', blankAudience({ name: '', role: null, goal: '' }), { version: 2 }));
  assert.deepEqual(library.list(), []);
});

test('an unreadable library is reported and never overwritten', (t) => {
  const { file, library } = setup(t);
  writeFileSync(file, '{ not json');
  assert.throws(() => library.list(), /could not be read/);
  assert.throws(() => library.save('A', blankAudience({ name: '', role: null, goal: '' }), getPersonaSchema()), /could not be read/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
});
