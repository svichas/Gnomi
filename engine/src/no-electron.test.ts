// The engine must stay a plain Node library (tech.md §16.2): this is the "no Electron imports" lint rule.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('engine source never imports electron', () => {
  const dir = import.meta.dirname;
  const offenders = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => /(from\s+|import\(\s*|require\(\s*)['"]electron['"]/.test(readFileSync(join(dir, file), 'utf8')));
  assert.deepEqual(offenders, []);
});
