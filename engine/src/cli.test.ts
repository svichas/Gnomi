// cli.ts end to end with scripted models, on a text POI (no browser): audience files, runs that reuse their personas, and --json output.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('rejudge records a new judge answer for an ended run, rewrites its report files and leaves the browsing alone', () => {
  const project = join(dir, 'rejudge');
  cli('run', '--pois', join(dir, 'pois.json'), '--settings', join(dir, 'settings.json'), '--goal', 'Pick a plan', '--project', project);
  const lines = cli('rejudge', project, '--run', 'r-0001', '--json').trim().split('\n').map((line) => JSON.parse(line));
  const types = lines.filter((l) => l.kind === 'event').map((l) => l.type);
  assert.ok(types.includes('report.themes'), 'the judge answered again');
  assert.ok(!types.some((t) => t.startsWith('persona.') || t.startsWith('run.')), 'nothing is browsed or run again');
  const done = lines.at(-1);
  assert.equal(done.kind, 'rejudge');
  assert.equal(done.run_id, 'r-0001');
  assert.ok(done.themes > 0);
  assert.equal(`${readFileSync(done.report_md, 'utf8')}\n`, cli('report', project, '--run', 'r-0001', '--format', 'md'));

  const fails = (run: string) => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'rejudge', project, '--run', run, '--fake-llm'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    return result.stderr;
  };
  assert.match(fails('r-0009'), /There is no run r-0009/);
  const sql = (statement: string) => {
    const db = new DatabaseSync(join(project, 'project.sqlite'));
    db.exec(statement);
    db.close();
  };
  // Scripted answers never replace a real model's, and a run without an end event may still be running in the app.
  sql(`UPDATE event SET payload_json = json_set(payload_json, '$.provider', 'anthropic') WHERE type = 'llm.call'`);
  assert.match(fails('r-0001'), /analysed by real models/);
  sql(`DELETE FROM event WHERE type IN ('run.finished', 'run.stopped')`);
  assert.match(fails('r-0001'), /has not ended/);
});

test('rejudge spends within what is left of the run budget unless --budget allows more, and leaves the run row and log current', () => {
  const project = join(dir, 'rejudge-budget');
  cli('run', '--pois', join(dir, 'pois.json'), '--settings', join(dir, 'settings.json'), '--goal', 'Pick a plan', '--project', project);
  const db = new DatabaseSync(join(project, 'project.sqlite'));
  const price = (usd: number) => db.exec(`UPDATE event SET payload_json = json_set(payload_json, '$.cost_usd', ${usd}) WHERE type = 'llm.call'`);
  try {
    price(0.01); // scripted calls are free: as if the run had paid for its own
    cli('rejudge', project);
    const row = JSON.parse(cli('runs', project, '--json').split('\n')[0]);
    assert.equal(row.cost_usd, JSON.parse(cli('report', project, '--format', 'json', '--json')).report.cost_usd, 'runs shows what the report counts');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event WHERE type = 'report.generated'").get()?.n, 2, 'an app with the run open reloads its report');

    price(5); // the run spent its $5 budget
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'rejudge', project, '--fake-llm'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--budget/);
    assert.match(cli('rejudge', project, '--budget', '0.5'), /judged again/);
  } finally {
    db.close();
  }
});

test('--settings routing for one role keeps the default for the others, and a role without a provider and model is refused', () => {
  const settings = join(dir, 'navigator.json');
  writeFileSync(settings, JSON.stringify({ routing: { navigator: { provider: 'openai', model: 'gpt-6-luna' } } }));
  assert.match(cli('estimate', '--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan', '--settings', settings), /model calls/);
  writeFileSync(settings, JSON.stringify({ routing: { judge: { model: 'gpt-6-luna' } } }));
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'estimate', '--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan', '--settings', settings], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"routing\.judge" must be/);
});

test('run checks the key of every role it calls before it writes anything, naming the variable to set', () => {
  const settings = join(dir, 'judge-openai.json');
  writeFileSync(settings, JSON.stringify({ routing: { judge: { provider: 'openai', model: 'gpt-6-luna' } } }));
  const { OPENAI_API_KEY: _, ...env } = process.env;
  const args = ['run', '--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan', '--settings', settings, '--project', join(dir, 'judge-key')];
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), ...args], { encoding: 'utf8', env: { ...env, ANTHROPIC_API_KEY: 'test-key' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set OPENAI_API_KEY \(the judge runs on openai\)/);
});

test('runs, report and rejudge leave a run still live in another process running', () => {
  const project = join(dir, 'live');
  cli('run', '--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan', '--settings', join(dir, 'settings.json'), '--project', project);
  // The app, mid-run: its connection is open and the run is not finished.
  const db = new DatabaseSync(join(project, 'project.sqlite'));
  try {
    db.exec("UPDATE run SET status = 'running', ended_at = NULL");
    assert.match(cli('runs', project), /^r-0001 {2}running,/m);
    assert.match(cli('report', project, '--format', 'md'), /^# Gnomi report: Pick a plan/);
    assert.equal(db.prepare('SELECT status FROM run').get()?.status, 'running');
    // The app runs r-0002 while an agent judges r-0001 again.
    db.exec(`UPDATE run SET status = 'finished';
      INSERT INTO run (id, created_at, status, seed, snapshot_json, cost_usd, started_at) SELECT 'r-0002', created_at, 'running', seed, snapshot_json, 0, started_at FROM run`);
    cli('rejudge', project, '--run', 'r-0001');
    assert.equal(db.prepare("SELECT status FROM run WHERE id = 'r-0002'").get()?.status, 'running');
  } finally {
    db.close();
  }
});
