// The simulation owns the boundary (new_simulation.md §2): nothing in it imports Electron, the engine or the app.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const FORBIDDEN = /(from\s+|import\s*\(?\s*|require\(\s*)['"](electron['"]|@gnomi\/(engine|app)\b|(\.\.\/)+(engine|app)\/)/;

test('simulation source never imports electron, the engine or the app', () => {
  const dir = import.meta.dirname;
  const offenders = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && file !== 'no-engine.test.ts') // this file names the forbidden paths in its sample
    .filter((file) => FORBIDDEN.test(readFileSync(join(dir, file), 'utf8')));
  assert.deepEqual(offenders, []);
  assert.ok(FORBIDDEN.test(`import x from '../../engine/src/x.ts';`), 'a relative reach-back is caught');
});
