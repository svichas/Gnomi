// cli.ts end to end with scripted models, on a text POI (no browser): audience files, runs that reuse their personas, and --json output.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'gnomi-cli-'));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'pricing.md'), '# Pricing\n\nStarter is $10 a month.');
writeFileSync(join(dir, 'pois.json'), JSON.stringify([{ type: 'text', path: 'pricing.md', name: 'Pricing' }]));
writeFileSync(join(dir, 'settings.json'), JSON.stringify({ rounds: 1 }));

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), ...args, '--fake-llm'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('an audience file is written once and its personas are reused by runs until the product changes', () => {
  const file = join(dir, 'audience.json');
  cli('audience', 'create', '--out', file, '--name', 'Acme', '--product', 'A pricing page.', '--goal', 'Pick a plan', '--pois', join(dir, 'pois.json'), '--count', '4');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.personas.length, 4);
  assert.deepEqual(saved.product, { name: 'Acme', description: 'A pricing page.', goal: 'Pick a plan' });

  const out = cli('run', '--pois', join(dir, 'pois.json'), '--audience', file, '--settings', join(dir, 'settings.json'), '--project', join(dir, 'run'));
  assert.match(out, /run\.started r-0001: "Pick a plan" on Pricing/);
  assert.doesNotMatch(out, /written again/);
  for (const persona of saved.personas) assert.match(out, new RegExp(`persona\\.created ${persona.name}`));
  assert.ok(existsSync(join(dir, 'run/runs/r-0001/report.json')));
  assert.match(readFileSync(join(dir, 'run/runs/r-0001/report.md'), 'utf8'), /^# Gnomi report: Pick a plan/);

  const changed = cli('run', '--pois', join(dir, 'pois.json'), '--audience', file, '--goal', 'Cancel', '--settings', join(dir, 'settings.json'), '--project', join(dir, 'changed'));
  assert.match(changed, /4 of 4 personas were written again/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).personas, saved.personas, 'the file is never written by a run');
});

test('with --json every line is an object and the last the result, for estimate, personas, run, runs, report and audience update', () => {
  const lines = (...args: string[]) => cli(...args, '--json').trim().split('\n').map((line) => JSON.parse(line));
  const result = (...args: string[]) => lines(...args).at(-1);
  const file = join(dir, 'agent.json');
  const pois = join(dir, 'pois.json');
  assert.deepEqual(
    (({ kind, personas, written, segments }) => ({ kind, personas, written, segments }))(result('audience', 'create', '--out', file, '--name', 'Acme', '--goal', 'Pick a plan', '--pois', pois, '--count', '4')),
    { kind: 'audience', personas: 4, written: 4, segments: 1 },
  );

  const listed = lines('personas', file);
  assert.deepEqual(listed.map((l) => l.kind), ['persona', 'persona', 'persona', 'persona', 'personas']);
  assert.ok(listed.slice(0, 4).every((p) => p.current));
  assert.equal(result('personas', file, '--id', listed[0].id).background, JSON.parse(readFileSync(file, 'utf8')).personas[0].background);

  const estimate = result('estimate', '--pois', pois, '--audience', file);
  assert.equal(estimate.kind, 'estimate');
  assert.equal(estimate.stale, 0);
  assert.ok(estimate.calls > 0 && estimate.cost_usd[0] <= estimate.cost_usd[1]);

  const run = lines('run', '--pois', pois, '--audience', file, '--settings', join(dir, 'settings.json'), '--project', join(dir, 'agent'));
  assert.ok(run.some((l) => l.kind === 'event' && l.type === 'run.started'));
  const done = run.at(-1);
  assert.equal(done.kind, 'run');
  assert.equal(done.status, 'finished');
  assert.equal(done.summary.personas, 4);
  assert.deepEqual(result('report', join(dir, 'agent')).report, done.summary);
  assert.equal(result('runs', join(dir, 'agent')).runs, 1);

  // An agent edits the file: the two new slots are written, a hand-edited biography is kept.
  const edited = JSON.parse(readFileSync(file, 'utf8'));
  edited.audience.persona_count = 6;
  edited.personas[0].background = 'Edited by hand.';
  writeFileSync(file, JSON.stringify(edited));
  const updated = result('audience', 'update', file);
  assert.equal(updated.personas, 6);
  assert.equal(updated.written, 2);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).personas.find((p: { id: string }) => p.id === edited.personas[0].id).background, 'Edited by hand.');
});
