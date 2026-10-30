// cli.ts end to end with scripted models, on a text POI (no browser): audience files, runs that reuse their personas, and --json output.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { isPriced } from '@gnomi/simulation/llm/prices.ts';
import { readsImages } from '@gnomi/simulation/settings.ts';
import type { ModelChoice, ProviderId } from '@gnomi/simulation/types.ts';

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

test('a theme only the scan found says so in the summary, and gives no count of personas', () => {
  const project = join(dir, 'scanned');
  const file = join(dir, 'scanned.json');
  const pois = join(dir, 'pois.json');
  cli('audience', 'create', '--out', file, '--name', 'Acme', '--goal', 'Pick a plan', '--pois', pois, '--count', '2');
  cli('run', '--pois', pois, '--audience', file, '--settings', join(dir, 'settings.json'), '--project', project);
  const db = new DatabaseSync(join(project, 'project.sqlite'));
  db.exec(`INSERT INTO event (run_id, seq, ts, round, persona_id, poi_id, type, payload_json)
    SELECT run_id, (SELECT max(seq) + 1 FROM event), ts, round, persona_id, poi_id, 'signal.accessibility', json_object(
      'step_no', json_extract(payload_json, '$.step_no'), 'url', json_extract(payload_json, '$.result.url_before'), 'ref', NULL, 'rule', 'color-contrast',
      'impact', 'serious', 'category', 'color', 'help', 'Elements must meet minimum color contrast ratio thresholds', 'elements', 1, 'selectors', json_array('main > p'))
    FROM event WHERE type = 'persona.step' LIMIT 1`);
  db.close();
  const { report } = JSON.parse(cli('report', project, '--json'));
  const themes = report.pois[0].themes;
  const theme = themes.find((t: { scan_only?: true }) => t.scan_only);
  assert.deepEqual([theme.personas, theme.share, theme.evidence, theme.trust], [null, null, 'none', 'observed']);
  assert.ok(themes.filter((t: object) => t !== theme).every((t: object) => !('scan_only' in t)));
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

test('the evidence check runs when a run asks for it or rejudge --check does, and a rejudge without either drops the older check', () => {
  const eventsOf = (out: string) => out.trim().split('\n').map((line) => JSON.parse(line)).filter((l) => l.kind === 'event').map((l) => l.type);
  const report = (project: string) => JSON.parse(cli('report', project, '--run', 'r-0001', '--format', 'json', '--json')).report;
  writeFileSync(join(dir, 'check.json'), JSON.stringify({ rounds: 1, finding_check: true }));
  const asked = join(dir, 'asked');
  cli('run', '--pois', join(dir, 'pois.json'), '--settings', join(dir, 'check.json'), '--goal', 'Pick a plan', '--project', asked);
  assert.ok(report(asked).themes.some((t: { check?: { verdict: string } }) => t.check?.verdict === 'product'), 'the scripted check calls each theme product');

  const off = join(dir, 'off');
  cli('run', '--pois', join(dir, 'pois.json'), '--settings', join(dir, 'settings.json'), '--goal', 'Pick a plan', '--project', off);
  assert.ok(report(off).themes.every((t: { check?: unknown }) => t.check === undefined));
  const types = eventsOf(cli('rejudge', off, '--run', 'r-0001', '--check', '--json'));
  assert.ok(types.indexOf('report.themes') < types.indexOf('report.checks') && types.indexOf('report.checks') < types.indexOf('report.suggestions'), types.join());
  assert.ok(report(off).themes.some((t: { check?: unknown }) => t.check !== undefined));
  assert.ok(!eventsOf(cli('rejudge', off, '--run', 'r-0001', '--json')).includes('report.checks'));
  assert.ok(report(off).themes.every((t: { check?: unknown }) => t.check === undefined));

  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ check_model: { provider: 'nobody', model: 'x' } }));
  const refused = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'estimate', '--pois', join(dir, 'pois.json'), '--settings', join(dir, 'bad.json')], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /"check_model" must be/);
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
    db.exec(`UPDATE run SET snapshot_json = json_set(snapshot_json, '$.project.settings.cost_budget_usd', ${5 / 3})`);
    const split = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'rejudge', project, '--fake-llm'], { encoding: 'utf8' });
    assert.match(split.stderr, /has spent its \$1\.67 budget/);
    assert.match(cli('rejudge', project, '--budget', '0.5'), /judged again/);
  } finally {
    db.close();
  }
});

test('audience analytics reports the changes, keeps the file on a dry run, and stores only the name and hash of the export', () => {
  const file = join(dir, 'analytics.json');
  cli('audience', 'create', '--out', file, '--name', 'Acme', '--goal', 'Pick a plan', '--pois', join(dir, 'pois.json'), '--count', '2');
  const csv = join(dir, 'export.csv');
  writeFileSync(csv, 'Country,Users\nGermany,3\nGreece,1\nAtlantis,1\n');
  const before = readFileSync(file, 'utf8');
  const dry = cli('audience', 'analytics', file, '--file', csv, '--segment', 'seg-1', '--dry-run', '--json').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(dry.at(-1).changes, ['Everyone: countries DE 75%, GR 25%']);
  assert.deepEqual(dry.at(-1).skipped, ['Skipped country "Atlantis": 1 user.']);
  assert.equal(dry.at(-1).dry_run, true);
  assert.equal(readFileSync(file, 'utf8'), before, 'a dry run writes nothing');
  assert.match(cli('audience', 'analytics', file, '--file', csv, '--segment', 'seg-1'), /1 change saved to/);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.audience.segments[0].countries, { DE: 75, GR: 25 });
  assert.equal(saved.audience.segments[0].grounding.sources[0].name, 'export.csv');
  assert.match(saved.audience.segments[0].grounding.sources[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(saved).includes('Atlantis'), false, 'no row of the file is kept');
  const update = cli('audience', 'update', file, '--json').trim().split('\n').map((line) => JSON.parse(line)).at(-1);
  assert.equal(update.kind, 'audience');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).personas.every((p: { country: string }) => ['DE', 'GR'].includes(p.country)));
});

test('audience sources warns first, keeps a digest and no source text, and a refusal leaves the file as it was', () => {
  const file = join(dir, 'sources.json');
  cli('audience', 'create', '--out', file, '--name', 'Acme', '--goal', 'Pick a plan', '--pois', join(dir, 'pois.json'), '--count', '2');
  const notes = join(dir, 'ana-interview.md');
  writeFileSync(notes, '# Interview\n\nI compare plans in a spreadsheet, ask ana@acme.io.\n\nA very private second line.');
  const before = readFileSync(file, 'utf8');
  const refused = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'audience', 'sources', file, '--segment', 'seg-1', '--file', notes, '--budget', '0.000001', '--fake-llm'], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /could cost up to .* budget/);
  assert.equal(readFileSync(file, 'utf8'), before);
  for (const args of [['--segment', 'seg-9', '--file', notes], ['--segment', 'seg-1'], ['--segment', 'seg-1', '--file', notes, '--budget', '0'], ['--segment', 'seg-1', '--file', join(dir, 'pois.json')]]) {
    assert.equal(spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'audience', 'sources', file, ...args, '--fake-llm'], { encoding: 'utf8' }).status, 1, args.join(' '));
  }
  const lines = cli('audience', 'sources', file, '--segment', 'seg-1', '--file', notes, '--json').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].kind, 'note');
  assert.match(lines[0].text, /Emails removed: 1\. Phone numbers removed: 0\. .*Names and other details are not removed, and the text goes to your model provider .*keep some interviews back for a study/);
  const result = lines.at(-1);
  assert.deepEqual([result.kind, result.segment, result.facts, result.remarks, result.dropped, result.stale], ['sources', 'seg-1', 1, 1, 0, 2]);
  assert.deepEqual(result.sources.map((s: { name: string }) => s.name), ['ana-interview.md']);
  const saved = readFileSync(file, 'utf8');
  assert.match(saved, /I compare plans in a spreadsheet, ask \[email removed\]\./);
  assert.equal(saved.includes('private second line') || saved.includes('ana@acme'), false, 'only the digest stays');
  assert.equal(cli('audience', 'update', file, '--json').includes('"written":2'), true, 'a grounded segment is written again');
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

test('--repeats and --also-model run a set one after another; each run keeps its report and the set is read through report --repeat', () => {
  const project = join(dir, 'repeats');
  const settings = join(dir, 'three-dollars.json');
  writeFileSync(settings, JSON.stringify({ rounds: 1, cost_budget_usd: 3 }));
  const lines = (...args: string[]) => cli(...args, '--json').trim().split('\n').map((line) => JSON.parse(line));
  const base = ['--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan', '--settings', settings];
  const also = ['--repeats', '2', '--also-model', 'deepseek:deepseek-v4-pro'];

  const [one, set] = [lines('estimate', ...base).at(-1), lines('estimate', ...base, ...also).at(-1)];
  assert.deepEqual([one.runs, set.runs, set.calls, set.budget_usd, set.run_budget_usd], [1, 3, one.calls * 3, 3, 1]);
  assert.ok(set.cost_usd[1] > one.cost_usd[1]);
  assert.ok(set.run_high_usd >= one.cost_usd[1] && set.run_high_usd < set.cost_usd[1], 'the dearest run, not the total');
  assert.match(cli('estimate', ...base, ...also), /budget \$3 \(\$1\.00 a run, the dearest may cost \$\d+\.\d\d\)/);
  assert.doesNotMatch(cli('estimate', ...base), /a run/, 'a lone run has the whole budget');

  const out = lines('run', ...base, '--project', project, ...also);
  assert.ok(out.some((l) => l.kind === 'note' && /differ in images as well as model/.test(l.text)), 'run says it too, before anything is paid for');
  assert.deepEqual(out.filter((l) => l.kind === 'run').map((l) => [l.run_id, l.status]), [['r-0001', 'finished'], ['r-0002', 'finished'], ['r-0003', 'finished']]);
  const done = out.at(-1);
  assert.deepEqual([done.kind, done.of, done.compared, done.running, done.incomplete, done.families, done.run_ids], ['repeats', 3, 3, false, false, ['anthropic', 'deepseek'], ['r-0001', 'r-0002', 'r-0003']]);
  assert.ok(done.findings.length > 0 && done.findings.every((f: { seen_in: number; of: number }) => f.seen_in === 3 && f.of === 3), 'scripted runs meet the same groups');

  const report = (run: string) => JSON.parse(readFileSync(join(project, `runs/${run}/report.json`), 'utf8'));
  assert.deepEqual(report('r-0002').repeat, { group: done.group, index: 2, of: 3 });
  assert.deepEqual(['r-0001', 'r-0002', 'r-0003'].map((run) => report(run).methods.budgets.cost_usd), [1, 1, 1]);
  assert.deepEqual(['r-0001', 'r-0003'].map((run) => report(run).methods.models.navigator.provider), ['anthropic', 'deepseek']);
  assert.deepEqual(['r-0001', 'r-0003'].map((run) => report(run).methods.models.judge.provider), ['anthropic', 'anthropic']);

  const rows = lines('runs', project).filter((l) => l.kind === 'run_row');
  assert.deepEqual(rows.map((r) => r.repeat), [3, 2, 1].map((index) => ({ group: done.group, index, of: 3 })));
  assert.match(cli('runs', project), new RegExp(`^r-0001 .*repeat 1 of 3 in set ${done.group}$`, 'm'));

  const read = lines('report', project, '--repeat', done.group).at(-1);
  assert.deepEqual(read, (({ project: _p, run_ids: _r, ...rest }) => rest)(done));
  assert.match(cli('report', project, '--repeat', done.group, '--format', 'md'), new RegExp(`^# Gnomi repeat set ${done.group}[\\s\\S]*3 of 3 runs \\| anthropic, deepseek`));
  assert.match(cli('report', project, '--run', 'r-0002', '--format', 'md'), /- Repeats: Appeared in 3 of 3 runs/);
  assert.doesNotMatch(readFileSync(join(project, 'runs/r-0002/report.md'), 'utf8'), /Appeared in/, "a run's own report is not rewritten");
});

test('a stopped run ends its set, which is labelled incomplete, and runs from before sets read as they did', () => {
  const project = join(dir, 'repeats-stopped');
  const settings = join(dir, 'no-budget.json');
  writeFileSync(settings, JSON.stringify({ rounds: 1, cost_budget_usd: 0 }));
  const out = cli('run', '--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan', '--settings', settings, '--project', project, '--repeats', '3', '--json').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(out.filter((l) => l.kind === 'run').map((l) => [l.run_id, l.status]), [['r-0001', 'stopped']], 'no second run after the stop');
  const done = out.at(-1);
  assert.deepEqual([done.kind, done.of, done.compared, done.incomplete, done.run_ids], ['repeats', 3, 0, true, ['r-0001']]);
  assert.match(cli('report', project, '--repeat', done.group, '--format', 'md'), /Incomplete set: 0 of 3 runs finished/);

  const lone = join(dir, 'lone');
  const run = cli('run', '--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan', '--settings', join(dir, 'settings.json'), '--project', lone, '--json').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(run.at(-1).kind, 'run', 'a lone run ends as it did');
  assert.equal(JSON.parse(cli('runs', lone, '--json').split('\n')[0]).repeat, null);
  assert.equal(JSON.parse(readFileSync(join(lone, 'runs/r-0001/report.json'), 'utf8')).repeat, undefined);
  assert.doesNotMatch(cli('report', lone, '--format', 'md'), /Repeat/);
});

test('a Ctrl-C that lands once a run has logged its end still ends the set', async () => {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'run', '--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan', '--settings', join(dir, 'settings.json'), '--project', join(dir, 'repeats-sigint'), '--repeats', '3', '--json', '--fake-llm']);
  let stdout = '';
  let sent = false;
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
    if (sent || !stdout.includes('"type":"run.finished"')) return;
    sent = true; // a second Ctrl-C quits at once
    child.kill('SIGINT');
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const out = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(out.some((l) => l.kind === 'note' && /^Stopping/.test(l.text)));
  const done = out.at(-1);
  // The signal may reach the next run just after it starts, which then stops: either way that is the last run, and only the first finished.
  assert.deepEqual([done.kind, done.of, done.compared, done.running, done.incomplete, done.run_ids.includes('r-0003')], ['repeats', 3, 1, false, true, false]);
  assert.equal(out.filter((l) => l.kind === 'run')[0].status, 'finished');
});

test('report --repeat from another process tells a set still going from one that died', () => {
  const project = join(dir, 'repeats-read');
  const settings = join(dir, 'settings.json');
  const { group } = JSON.parse(cli('run', '--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan', '--settings', settings, '--project', project, '--repeats', '2', '--json').trim().split('\n').at(-1)!);
  const set = () => JSON.parse(cli('report', project, '--repeat', group, '--json'));
  const db = new DatabaseSync(join(project, 'project.sqlite'));
  db.exec("DELETE FROM event WHERE run_id = 'r-0002' AND type IN ('run.finished', 'report.generated'); UPDATE run SET status = 'running' WHERE id = 'r-0002';");
  assert.deepEqual([set().running, set().incomplete, set().compared], [true, false, 1]);
  assert.match(cli('report', project, '--repeat', group, '--format', 'md'), /1 of 2 runs finished so far\./);
  db.exec("UPDATE run SET status = 'interrupted' WHERE id = 'r-0002';");
  db.close();
  assert.deepEqual([set().running, set().incomplete, set().compared], [false, true, 1]);
  assert.match(cli('report', project, '--repeat', group, '--format', 'md'), /Incomplete set: 1 of 2 runs finished\./);
});

test('--also-model says when its run and the others differ in images, and only then', () => {
  const notes = (settings: object, model: string) => {
    const file = join(dir, 'also.json');
    writeFileSync(file, JSON.stringify(settings));
    return cli('estimate', '--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan', '--settings', file, '--also-model', model, '--json').trim().split('\n').map((line) => JSON.parse(line)).filter((l) => l.kind === 'note').map((l) => l.text);
  };
  const deepseek = (model: string) => ({ routing: { navigator: { provider: 'deepseek', model } } });
  assert.match(notes({}, 'deepseek:deepseek-v4-pro')[0], /Only the runs other than deepseek-v4-pro read screenshots.*differ in images as well as model/);
  assert.match(notes(deepseek('deepseek-v4-pro'), 'anthropic:claude-sonnet-5-5')[0], /Only the claude-sonnet-5-5 run reads screenshots/, 'the other way round too');
  assert.deepEqual(notes({}, 'deepseek:deepseek-flash'), [], 'both read images');
  assert.deepEqual(notes(deepseek('deepseek-v4-pro'), 'deepseek:deepseek-v4-pro'), [], 'neither does');
  assert.deepEqual(notes({ screenshots: false }, 'deepseek:deepseek-v4-pro'), [], 'nobody is sent any');
});

test("the skill's --also-model commands name a priced model that reads images, so its runs differ only in model", () => {
  const skill = readFileSync(join(import.meta.dirname, '../../.claude/skills/gnomi/SKILL.md'), 'utf8');
  const models = [...skill.matchAll(/^npm run .* --also-model (\w+):(\S+)/gm)].map(([, provider, model]): ModelChoice => ({ provider: provider as ProviderId, model: model! }));
  assert.equal(models.length, 2);
  for (const model of models) assert.ok(readsImages(model) && isPriced(model), model.model);
});

test('--repeat, --repeats and --also-model refuse what cannot work, before anything runs', () => {
  const fails = (...args: string[]) => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), ...args, '--fake-llm'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout);
    return result.stderr;
  };
  const base = ['--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan'];
  assert.match(fails('run', ...base, '--project', join(dir, 'refused'), '--repeats', '0'), /whole number/);
  assert.match(fails('run', ...base, '--project', join(dir, 'refused'), '--repeats', 'two'), /whole number/);
  assert.match(fails('run', ...base, '--project', join(dir, 'refused'), '--also-model', 'deepseek'), /provider:model/);
  assert.match(fails('estimate', ...base, '--also-model', 'other:model'), /provider:model/);
  assert.match(fails('run', ...base, '--project', join(dir, 'refused'), '--also-model', 'openai:no-such-model'), /no price/);
  assert.equal(cli('runs', join(dir, 'refused')).startsWith('0 runs'), true, 'no run was started');
  const project = join(dir, 'lone');
  assert.match(fails('report', project, '--repeat', 'no-such-set'), /There is no repeat set no-such-set/);
});

test('rerun runs a finished run again on what it froze, and compare reads the two with no model calls', () => {
  const project = join(dir, 'rerun');
  const lines = (...args: string[]) => cli(...args, '--json').trim().split('\n').map((line) => JSON.parse(line));
  cli('run', '--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan', '--settings', join(dir, 'settings.json'), '--project', project);
  const rerun = lines('rerun', project, '--base', 'r-0001');
  assert.deepEqual([rerun.at(-1).kind, rerun.at(-1).run_id, rerun.at(-1).status], ['run', 'r-0002', 'finished']);
  assert.ok(rerun.some((line) => line.kind === 'note' && /^Estimate for 1 personas: about \d+ model calls/.test(line.text)), 'it says what it may spend, as run does');
  assert.ok(existsSync(join(project, 'runs/r-0002/report.md')));
  const goals = lines('report', project, '--run', 'r-0002', '--format', 'json').at(-1).report;
  assert.equal(goals.goal, 'Pick a plan');

  const compared = lines('compare', project, '--base', 'r-0001', '--run', 'r-0002').at(-1);
  assert.deepEqual([compared.kind, compared.before, compared.after], ['compare', ['r-0001'], ['r-0002']]);
  assert.ok(compared.themes.length > 0 && compared.themes.every((theme: { status: string }) => theme.status === 'unchanged'));
  assert.match(cli('compare', project, '--base', 'r-0001', '--run', 'r-0002'), /^# Gnomi comparison: r-0001 to r-0002\n\n> "Not seen again" means/);

  const set = lines('rerun', project, '--base', 'r-0001', '--repeats', '2');
  assert.deepEqual([set.at(-1).kind, set.at(-1).compared, set.at(-1).run_ids], ['repeats', 2, ['r-0003', 'r-0004']]);
  const against = lines('compare', project, '--base', 'r-0002', '--run', 'r-0004').at(-1);
  assert.deepEqual(against.after, ['r-0003', 'r-0004']);
  assert.ok(against.themes.every((theme: { after: { of: number } }) => theme.after.of === 2));
});

test('estimate --base prices a rerun on what the run froze, not on the defaults, in a project with no pois file', () => {
  const project = join(dir, 'rerun-estimate');
  const lines = (...args: string[]) => cli(...args, '--json').trim().split('\n').map((line) => JSON.parse(line));
  const settings = join(dir, 'frozen.json');
  writeFileSync(settings, JSON.stringify({ rounds: 1, cost_budget_usd: 2, routing: { navigator: { provider: 'openai', model: 'gpt-6-astra' } } }));
  const fresh = ['--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan'];
  cli('run', ...fresh, '--settings', settings, '--project', project);

  const rerun = lines('estimate', project, '--base', 'r-0001', '--repeats', '2').at(-1);
  const frozen = lines('estimate', ...fresh, '--settings', settings, '--repeats', '2').at(-1);
  assert.deepEqual([rerun.kind, rerun.runs, rerun.calls, rerun.cost_usd, rerun.run_budget_usd, rerun.budget_usd], ['estimate', 2, frozen.calls, frozen.cost_usd, 1, 2]);
  assert.notDeepEqual(rerun.cost_usd, lines('estimate', ...fresh, '--repeats', '2').at(-1).cost_usd, 'the defaults would mislead here');
  assert.match(cli('estimate', project, '--base', 'r-0001'), /^1 personas: about \d+ model calls.*budget \$2/);

  const fails = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), ...args], { encoding: 'utf8' }).stderr;
  assert.match(fails('estimate', project, '--base', 'r-0009'), /There is no run r-0009/);
  assert.match(fails('estimate', '--base', 'r-0001'), /Name the project folder/);
});

test('rerun and compare refuse what cannot work, before anything runs', () => {
  const project = join(dir, 'rerun-refused');
  cli('run', '--pois', join(dir, 'pois.json'), '--goal', 'Pick a plan', '--settings', join(dir, 'settings.json'), '--project', project);
  const fails = (...args: string[]) => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), ...args], { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '' } });
    assert.notEqual(result.status, 0, args.join(' '));
    return result.stderr;
  };
  assert.match(fails('rerun', project, '--fake-llm'), /rerun needs --base/);
  assert.match(fails('compare', project, '--base', 'r-0001'), /compare needs --base and --run/);
  assert.match(fails('rerun', project, '--base', 'r-0009', '--fake-llm'), /There is no run r-0009/);
  assert.match(fails('rerun', project, '--base', 'r-0001', '--url', 'poi-1', '--fake-llm'), /--url must be <poi id>=<url>/);
  assert.match(fails('rerun', project, '--base', 'r-0001', '--url', 'poi-9=http://a.test', '--fake-llm'), /no web point of interest "poi-9"; it has none/);
  assert.match(fails('rerun', project, '--base', 'r-0001', '--repeats', '0', '--fake-llm'), /whole number/);
  assert.match(fails('rerun', project, '--base', 'r-0001'), /ANTHROPIC_API_KEY/);
  assert.match(fails('compare', project, '--base', 'r-0001', '--run', 'r-0001'), /one run or one repeat set/);
  assert.match(fails('compare', project, '--base', 'r-0001', '--run', 'r-0009'), /There is no run r-0009/);

  // The app, mid-run: rerun leaves its run running and refuses to start a second.
  const db = new DatabaseSync(join(project, 'project.sqlite'));
  try {
    db.exec(`INSERT INTO run (id, created_at, status, seed, snapshot_json, cost_usd, started_at) SELECT 'r-0002', created_at, 'running', seed, snapshot_json, 0, started_at FROM run`);
    assert.match(fails('rerun', project, '--base', 'r-0001', '--fake-llm'), /r-0002 is still running/);
    assert.match(fails('compare', project, '--base', 'r-0001', '--run', 'r-0002'), /r-0002 is still running/);
    assert.equal(db.prepare("SELECT status FROM run WHERE id = 'r-0002'").get()?.status, 'running');
    db.exec("UPDATE run SET status = 'stopped' WHERE id = 'r-0002'");
    assert.match(fails('rerun', project, '--base', 'r-0002', '--fake-llm'), /r-0002 is stopped, and only a finished run/);
  } finally {
    db.close();
  }
});

test('--url still names the one web app of a run, the last one given', () => {
  const out = cli('estimate', '--url', 'http://localhost:1', '--url', 'http://localhost:2', '--goal', 'Look around', '--json');
  assert.equal(JSON.parse(out.trim().split('\n').at(-1)!).kind, 'estimate');
});
