// The simulation owns the boundary (new_simulation.md §2): nothing in it imports Electron, the engine or the app.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('simulation source never imports electron, the engine or the app', () => {
  const dir = import.meta.dirname;
  const offenders = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => /(from\s+|import\(\s*|require\(\s*)['"](electron|@gnomi\/engine|@gnomi\/app|\.\.\/engine|\.\.\/app)/.test(readFileSync(join(dir, file), 'utf8')));
  assert.deepEqual(offenders, []);
});
