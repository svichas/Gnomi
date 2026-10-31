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
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { createRecorder } from '@gnomi/simulation/run.ts';
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

test('study plans from an ended run, writes the plan on its own and spends under the rules rejudge does', () => {
  const project = join(dir, 'study');
  cli('run', '--pois', join(dir, 'pois.json'), '--settings', join(dir, 'settings.json'), '--goal', 'Pick a plan', '--project', project);
  const study = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'study', project, '--fake-llm', ...args], { encoding: 'utf8' });

  const lines = cli('study', project, '--json').trim().split('\n').map((line) => JSON.parse(line));
  assert.match(lines.find((l) => l.kind === 'note').text, /One call to .*about \$.*with \$5\.00 to spend/, 'what it will cost, before it runs');
  const calls = lines.filter((l) => l.kind === 'event' && l.type === 'llm.call');
  assert.equal(calls.length, 1);
  const done = lines.at(-1);
  assert.deepEqual([done.kind, done.run_id, done.plan.hypotheses.length > 0], ['study', 'r-0001', true]);
  assert.match(readFileSync(done.study_plan_md, 'utf8'), /^# Study plan: Pick a plan\n\n> These hypotheses come from simulated users and are unproven\. Do not show them to participants/);
  assert.match(readFileSync(done.report_md, 'utf8'), /## Study plan/, 'the report files are written again');
  assert.deepEqual(JSON.parse(cli('report', project, '--format', 'json', '--json')).report.study_plan, done.plan, 'the plan comes back from the log');

  const db = new DatabaseSync(join(project, 'project.sqlite'));
  try {
    db.exec(`UPDATE event SET payload_json = json_set(payload_json, '$.cost_usd', 5) WHERE type = 'llm.call'`); // the run spent its $5 budget
    const spent = study();
    assert.equal(spent.status, 1);
    assert.match(spent.stderr, /has spent its \$5\.00 budget; pass --budget <usd> to let study spend more/);
    assert.match(study('--budget', 'nothing').stderr, /--budget must be a positive amount/);
    assert.match(cli('study', project, '--budget', '0.5'), /study plan: /);
    db.exec(`UPDATE event SET payload_json = json_set(payload_json, '$.provider', 'anthropic') WHERE type = 'llm.call'`);
    assert.match(study('--budget', '0.5').stderr, /analysed by real models/);
    db.exec(`DELETE FROM event WHERE type IN ('run.finished', 'run.stopped')`);
    assert.match(study('--budget', '0.5').stderr, /has not ended/);
  } finally {
    db.close();
  }
  assert.match(study('--run', 'r-0009').stderr, /There is no run r-0009/);
});

test('study names the key it needs, and calls nothing without it', () => {
  const project = join(dir, 'study-key');
  cli('run', '--pois', join(dir, 'pois.json'), '--settings', join(dir, 'settings.json'), '--goal', 'Pick a plan', '--project', project);
  const { ANTHROPIC_API_KEY: _, ...env } = process.env;
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'study', project], { encoding: 'utf8', env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set ANTHROPIC_API_KEY \(the author runs on anthropic\)/);
});

test('outcome records what a team found, refuses what is wrong, survives a rejudge and moves no simulated number', () => {
  const project = join(dir, 'outcome');
  cli('run', '--pois', join(dir, 'pois.json'), '--settings', join(dir, 'settings.json'), '--goal', 'Pick a plan', '--project', project);
  const report = () => JSON.parse(cli('report', project, '--format', 'json', '--json')).report;
  const before = report();
  const { id: theme, title } = before.themes[0];
  const outcome = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'outcome', project, ...args], { encoding: 'utf8' });
  const good = ['--run', 'r-0001', '--theme', theme, '--status', 'supported', '--date', '2026-10-12'];

  assert.match(outcome('--run', 'r-0001').stderr, /outcome needs --run, --theme, --status and --date/);
  assert.match(outcome('--run', 'r-0001').stderr, /Leave out names and contact details/, 'the usage warns what a note must not hold');
  assert.match(outcome(...good.slice(0, 5), 'maybe', '--date', '2026-10-12').stderr, /status must be/);
  assert.match(outcome(...good.slice(0, 7), 'yesterday').stderr, /real date/);
  assert.match(outcome(...good.slice(0, 7), '2999-01-01').stderr, /in the future/);
  assert.match(outcome('--run', 'r-0001', '--theme', 'g99', ...good.slice(4)).stderr, /has no finding "g99"/);

  const done = JSON.parse(outcome(...good, '--note', 'Five of six stalled here.', '--json').stdout.trim().split('\n').at(-1)!);
  assert.deepEqual([done.kind, done.theme_id, done.status, done.study_count.supported], ['outcome', theme, 'supported', 1]);
  const after = report();
  assert.deepEqual(after.themes[0].validation, { status: 'supported', note: 'Five of six stalled here.', study_date: '2026-10-12', title });
  assert.equal(after.llm_calls, before.llm_calls, 'no model call');
  assert.match(readFileSync(done.report_md, 'utf8'), /Your team's study, 12 Oct 2026: supported/);
  assert.equal(JSON.parse(cli('report', project, '--json')).report.study_count.supported, 1, "an agent's summary carries it");

  cli('rejudge', project, '--run', 'r-0001');
  assert.equal(report().themes.find((t: { validation?: object }) => t.validation)?.validation.note, 'Five of six stalled here.', 'a rejudge keeps it, as it is in the log');

  const store = openProject(project);
  const gone = { keys: ['["poi",null,"kind","gone"]'], category: 'friction' as const, title: 'A finding the judge merged away', status: 'contradicted' as const, note: null, study_date: '2026-10-02' };
  createRecorder(store, () => {})({ run_id: 'r-0001', round: 1, persona_id: null, poi_id: before.themes[0].poi_id, type: 'finding.validated', payload: gone });
  store.close();
  const { unmatched_outcomes } = JSON.parse(cli('report', project, '--json')).report;
  assert.deepEqual(unmatched_outcomes.map((o: { title: string }) => o.title), [gone.title], "an agent's summary lists what has no finding left");
});

test('edit hides and rewords for sharing only: report and its files keep what the run found, and --for-sharing gives the copy', () => {
  const project = join(dir, 'edit');
  cli('run', '--pois', join(dir, 'pois.json'), '--settings', join(dir, 'settings.json'), '--goal', 'Pick a plan', '--project', project);
  const report = (...args: string[]) => JSON.parse(cli('report', project, '--format', 'json', '--json', ...args)).report;
  const before = report();
  const [first, second] = before.themes;
  const edit = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'edit', project, ...args], { encoding: 'utf8' });
  const on = (theme: { id: string }) => ['--run', 'r-0001', '--theme', theme.id];

  assert.match(edit('--run', 'r-0001').stderr, /edit needs --run, --theme and exactly one of --hide, --show, --title, --description or --reset/);
  assert.match(edit(...on(first)).stderr, /exactly one of/);
  assert.match(edit(...on(first), '--hide', '--show').stderr, /exactly one of/);
  assert.match(edit(...on(first), '--title', 'A', '--description', 'B').stderr, /exactly one of/);
  assert.match(edit(...on({ id: 'g99' }), '--hide').stderr, /has no finding "g99"/);
  assert.match(edit('--run', 'r-0009', '--theme', first.id, '--hide').stderr, /There is no run r-0009/);
  assert.match(edit(...on(first), '--title', 'x'.repeat(121)).stderr, /121 characters, and the limit is 120/);

  const done = JSON.parse(edit(...on(first), '--hide', '--json').stdout.trim().split('\n').at(-1)!);
  assert.deepEqual([done.kind, done.theme_id, done.hidden], ['edit', first.id, true]);
  assert.equal(JSON.parse(edit(...on(second), '--title', 'Our words', '--json').stdout.trim().split('\n').at(-1)!).new_title, 'Our words');
  const after = report();
  assert.deepEqual([after.themes[0].title, after.themes[1].title], [first.title, second.title], 'report reads what the run found');
  assert.equal(after.llm_calls, before.llm_calls, 'no model call');
  assert.equal(after.shared, undefined);
  assert.ok(readFileSync(done.report_md, 'utf8').includes(first.title), 'report.md stays the record');

  const shared = report('--for-sharing');
  assert.deepEqual(shared.shared, { hidden: 1, reworded: 1 });
  assert.equal(shared.themes.find((t: { id: string }) => t.id === second.id).title, 'Our words');
  assert.ok(!shared.themes.some((t: { id: string }) => t.id === first.id));
  const markdown = cli('report', project, '--format', 'md', '--for-sharing');
  assert.match(markdown, /hid 1 finding from this copy and reworded 1 finding/);
  assert.match(markdown, /Our words\n\nReworded by the team\./);
  assert.ok(!markdown.includes(first.title));
  assert.deepEqual(JSON.parse(cli('report', project, '--json', '--for-sharing')).report.shared, { hidden: 1, reworded: 1 }, "an agent's summary carries the line");

  const repeat = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'report', project, '--repeat', 'set-a', '--for-sharing'], { encoding: 'utf8' });
  assert.match(repeat.stderr, /--for-sharing is for one run's report/);

  edit(...on(first), '--show');
  edit(...on(second), '--reset');
  assert.deepEqual(report('--for-sharing').themes, before.themes, 'back as it was');
});

test('ask answers from the log under rejudge\'s budget rule, says what the answer is, and stays out of every report', () => {
  const project = join(dir, 'ask');
  cli('run', '--pois', join(dir, 'pois.json'), '--settings', join(dir, 'settings.json'), '--goal', 'Pick a plan', '--project', project);
  const persona = JSON.parse(cli('report', project, '--format', 'json', '--json')).report.personas[0].id;
  const ask = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'ask', project, '--fake-llm', ...args], { encoding: 'utf8' });
  const good = ['--run', 'r-0001', '--persona', persona, '--question', 'Why did you stop?'];

  assert.match(ask('--run', 'r-0001').stderr, /ask needs --run, --persona and --question/);
  assert.match(ask('--run', 'r-0009', '--persona', persona, '--question', 'Why?').stderr, /There is no run r-0009/);
  assert.match(ask('--run', 'r-0001', '--persona', 'nobody', '--question', 'Why?').stderr, /r-0001 has no persona nobody/);
  assert.match(ask('--run', 'r-0001', '--persona', persona, '--question', ' ').stderr, /Write a question first/);

  const lines = ask(...good, '--json').stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.match(lines.find((l) => l.kind === 'note').text, /One call to .*about \$.*with \$5\.00 to spend/, 'what it will cost, before it runs');
  assert.deepEqual(lines.filter((l) => l.kind === 'event').map((l) => l.type), ['llm.call', 'persona.interviewed', 'report.generated']);
  const done = lines.at(-1);
  assert.deepEqual([done.kind, done.persona_id, done.question], ['ask', persona, 'Why did you stop?']);
  assert.match(done.answer, /Scripted demo answer/);
  assert.match(done.label, /^Generated after the run\. This is a new answer from the model, not a memory of why this persona acted\.$/);
  assert.match(ask(...good).stdout, /Generated after the run\./, 'a person reads the label too');

  const files = ['json', 'md'].map((format) => readFileSync(join(project, `runs/r-0001/report.${format}`), 'utf8'));
  assert.ok(files.every((file) => !file.includes('Why did you stop') && !file.includes('Scripted demo answer')), 'report.json and report.md hold no interview');
  assert.ok(!cli('report', project, '--format', 'md', '--for-sharing').includes('Why did you stop'));

  const db = new DatabaseSync(join(project, 'project.sqlite'));
  try {
    db.exec(`UPDATE event SET payload_json = json_set(payload_json, '$.cost_usd', 5) WHERE type = 'llm.call'`); // the run spent its $5 budget
    const spent = ask(...good);
    assert.equal(spent.status, 1);
    assert.match(spent.stderr, /has spent its \$5\.00 budget; pass --budget <usd> to let ask spend more/);
    assert.match(ask(...good, '--budget', 'nothing').stderr, /--budget must be a positive amount/);
    assert.equal(ask(...good, '--budget', '0.5').status, 0);
    db.exec(`UPDATE event SET payload_json = json_set(payload_json, '$.provider', 'anthropic') WHERE type = 'llm.call'`);
    assert.match(ask(...good, '--budget', '0.5').stderr, /analysed by real models/);
    db.exec(`DELETE FROM event WHERE type IN ('run.finished', 'run.stopped')`);
    assert.match(ask(...good, '--budget', '0.5').stderr, /has not ended/);
  } finally {
    db.close();
  }
});

test('ask names the key it needs, and calls nothing without it', () => {
  const project = join(dir, 'ask-key');
  cli('run', '--pois', join(dir, 'pois.json'), '--settings', join(dir, 'settings.json'), '--goal', 'Pick a plan', '--project', project);
  const { ANTHROPIC_API_KEY: _, ...env } = process.env;
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'ask', project, '--run', 'r-0001', '--persona', 'p', '--question', 'Why?'], { encoding: 'utf8', env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set ANTHROPIC_API_KEY \(the navigator runs on anthropic\)/);
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

test('audience analytics counts the personas a share change would write, and audience update writes them', () => {
  const file = join(dir, 'shares.json');
  cli('audience', 'create', '--out', file, '--name', 'Acme', '--goal', 'Pick a plan', '--pois', join(dir, 'pois.json'), '--count', '12');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const [first] = saved.audience.segments;
  saved.audience.segments = [{ ...first, share: 50 }, { ...first, id: 'seg-2', name: 'Admins', share: 50 }];
  writeFileSync(file, JSON.stringify(saved));
  cli('audience', 'update', file);
  const csv = join(dir, 'shares.csv');
  writeFileSync(csv, 'Segment,Users\nEveryone,90\nAdmins,10\n');
  const last = (text: string) => JSON.parse(text.trim().split('\n').at(-1)!);
  const dry = last(cli('audience', 'analytics', file, '--file', csv, '--dry-run', '--json'));
  assert.deepEqual(dry.changes, ['Everyone: share 50% → 90%', 'Admins: share 50% → 10%']);
  assert.equal(dry.stale, 3, 'nine and three instead of six and six');
  assert.equal(last(cli('audience', 'analytics', file, '--file', csv, '--json')).stale, 3);
  assert.equal(last(cli('audience', 'update', file, '--json')).written, 3);
  assert.equal(last(cli('audience', 'analytics', file, '--file', csv, '--dry-run', '--json')).stale, 0, 'nothing is left to write');
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

test('gate reads saved sets with no model calls, and each outcome has its exit code and its reasons', () => {
  const project = join(dir, 'gate');
  const pois = join(dir, 'pois.json');
  const gate = (base: string, run: string, ...more: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'gate', project, '--base', base, '--run', run, ...more], { encoding: 'utf8' });
  const lines = (result: ReturnType<typeof spawnSync>) => JSON.parse(String(result.stdout).trim().split('\n').at(-1)!);
  const db = () => new DatabaseSync(join(project, 'project.sqlite'));
  const calls = () => { const open = db(); const { n } = open.prepare(`SELECT count(*) AS n FROM event WHERE type = 'llm.call'`).get() as { n: number }; open.close(); return n; };
  // A person in that run meets a new problem, as if the scripted run had shown it.
  const worsen = (run_id: string) => {
    const open = db();
    open.exec(`INSERT INTO event (run_id, seq, ts, round, persona_id, poi_id, type, payload_json)
      SELECT run_id, (SELECT max(seq) + 1 FROM event WHERE run_id = '${run_id}'), ts, round, persona_id, poi_id, 'persona.friction_reported', json_object(
        'step_no', 1, 'severity', 4, 'what', 'The plan table is empty', 'expected', 'Prices', 'where', json_object('url', 'asset:other.md', 'ref', NULL), 'heard_post_ids', json_array())
      FROM event WHERE run_id = '${run_id}' AND type = 'persona.step' LIMIT 1`);
    open.close();
  };
  cli('run', '--pois', pois, '--goal', 'Pick a plan', '--settings', join(dir, 'settings.json'), '--project', project, '--repeats', '3');
  cli('rerun', project, '--base', 'r-0001', '--repeats', '3');
  const spent = calls();

  const passed = gate('r-0001', 'r-0005');
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /^# Gnomi gate: passed\n/);
  assert.ok(passed.stdout.includes('No new high-severity theme in these simulated runs. This does not show that people will not hit one.'));
  assert.deepEqual(lines(gate('r-0002', 'r-0004', '--json')), { kind: 'gate', decision: 'passed', base: ['r-0001', 'r-0002', 'r-0003'], run: ['r-0004', 'r-0005', 'r-0006'], failing: [], warnings: [], reasons: [] });

  worsen('r-0004');
  const once = gate('r-0001', 'r-0004', '--json');
  assert.equal(once.status, 0, 'one sighting warns');
  assert.deepEqual([lines(once).decision, lines(once).failing, lines(once).warnings.map((theme: { status: string }) => theme.status)], ['passed', [], ['new']]);
  assert.match(gate('r-0001', 'r-0004').stdout, /## Warnings \(1\)/);

  worsen('r-0005');
  const failed = gate('r-0001', 'r-0004', '--json');
  assert.equal(failed.status, 1);
  const { decision, failing } = lines(failed);
  assert.equal(decision, 'failed');
  assert.deepEqual(failing.map((theme: { status: string; after: { seen_in: number; of: number }; sightings: { run_id: string }[] }) => [theme.status, theme.after, theme.sightings.map(({ run_id }) => run_id)]), [['new', { seen_in: 2, of: 3 }, ['r-0004', 'r-0005']]]);
  assert.match(gate('r-0001', 'r-0004').stdout, /^# Gnomi gate: failed\n/);
  assert.equal(calls(), spent, 'reading never calls a model');

  cli('rerun', project, '--base', 'r-0001');
  const old = gate('r-0001', 'r-0007', '--json');
  assert.equal(old.status, 2);
  assert.deepEqual([lines(old).decision, lines(old).reasons], ['could_not_decide', ['The later side has 1 finished run, and the gate needs 3 from one repeat set.']]);

  const open = db();
  open.exec(`UPDATE run SET status = 'interrupted' WHERE id = 'r-0006'`);
  open.close();
  const stopped = gate('r-0001', 'r-0004', '--json');
  assert.equal(stopped.status, 2);
  assert.match(lines(stopped).reasons.join(), /later side has 2 finished runs[\s\S]*Only 2 of the 3 runs of the later set/);

  assert.equal(gate('r-0001', 'r-0404').status, 2, 'an unknown run is no regression');
  assert.match(gate('r-0001', 'r-0404').stdout, /There is no run r-0404/);
  assert.match(lines(gate('r-0001', 'r-0002', '--json')).reasons.join(), /one run or one repeat set/);
  const fails = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), ...args], { encoding: 'utf8' }).status;
  assert.equal(fails('gate', project, '--base', 'r-0001'), 2, 'a missing flag');
  assert.equal(fails('gate', join(dir, 'no-such-project'), '--base', 'r-0001', '--run', 'r-0002'), 2, 'not a project');
  assert.equal(fails('gate', project, '--base', 'r-0001', '--run', 'r-0002', '--nonsense'), 2, 'a flag parseArgs refuses');
  assert.equal(fails('compare', project, '--base', 'r-0001', '--run', 'r-0404'), 1, 'other commands are as they were');
});

test('gate refuses personas written again under the same ids and names, and a set with another goal, but a rerun of an audience passes', () => {
  const [project, file, copy, pois, settings] = [join(dir, 'gate-audience'), join(dir, 'gate-audience.json'), join(dir, 'gate-audience-2.json'), join(dir, 'pois.json'), join(dir, 'settings.json')];
  const gate = (at: string, base: string, run: string) => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'gate', at, '--base', base, '--run', run, '--json'], { encoding: 'utf8' });
    return [result.status, JSON.parse(result.stdout.trim().split('\n').at(-1)!).reasons];
  };
  cli('audience', 'create', '--out', file, '--name', 'Acme', '--goal', 'Pick a plan', '--pois', pois, '--count', '3');
  cli('run', '--pois', pois, '--audience', file, '--settings', settings, '--project', project, '--repeats', '3');
  cli('rerun', project, '--base', 'r-0001', '--repeats', '3');
  assert.deepEqual(gate(project, 'r-0001', 'r-0004'), [0, []], 'a rerun keeps the frozen personas');

  const saved = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(copy, JSON.stringify({ ...saved, personas: saved.personas.map((persona: object) => ({ ...persona, background: 'Someone else entirely.', job_title: 'Astronaut' })) }));
  cli('run', '--pois', pois, '--audience', copy, '--settings', settings, '--project', project, '--repeats', '3');
  assert.deepEqual(gate(project, 'r-0001', 'r-0007'), [2, ['The two sides have different personas, so a change may come from who tried it rather than the build.']]);

  const goals = join(dir, 'gate-goals');
  cli('run', '--pois', pois, '--goal', 'Pick a plan', '--settings', settings, '--project', goals, '--repeats', '3');
  cli('run', '--pois', pois, '--goal', 'Cancel my plan', '--settings', settings, '--project', goals, '--repeats', '3');
  assert.deepEqual(gate(goals, 'r-0001', 'r-0004'), [2, ['The two sides have different goals, so a change may come from what they tried rather than the build.']]);
});

test('--also-trait-free adds one run to a set, in its snapshot alone, and only a matching finding changes', () => {
  const project = join(dir, 'trait-free');
  const [file, pois, settings] = [join(dir, 'trait-free.json'), join(dir, 'pois.json'), join(dir, 'settings.json')];
  const lines = (...args: string[]) => cli(...args, '--json').trim().split('\n').map((line) => JSON.parse(line));
  cli('audience', 'create', '--out', file, '--name', 'Acme', '--product', 'A pricing page.', '--goal', 'Pick a plan', '--pois', pois, '--count', '4');
  const saved = readFileSync(file, 'utf8');
  const base = ['--pois', pois, '--audience', file, '--settings', settings];

  const plain = lines('estimate', ...base, '--repeats', '2').at(-1);
  const whole = lines('estimate', ...base, '--repeats', '2', '--also-trait-free').at(-1);
  assert.deepEqual([plain.runs, whole.runs, plain.run_budget_usd / whole.run_budget_usd], [2, 3, 1.5], 'the estimate and the budget split count it');
  assert.ok(whole.cost_usd[1] > plain.cost_usd[1]);

  const out = lines('run', ...base, '--project', project, '--repeats', '2', '--also-trait-free');
  const done = out.at(-1);
  assert.deepEqual([done.kind, done.of, done.compared, done.incomplete, done.trait_free, done.run_ids], ['repeats', 2, 2, false, 'r-0003', ['r-0001', 'r-0002', 'r-0003']]);
  assert.ok(done.findings.length > 0 && done.findings.every((finding: { seen_in: number; of: number; trait_free: boolean; themes: object }) => finding.seen_in === 2 && finding.of === 2 && finding.trait_free && !('r-0003' in finding.themes)));
  assert.equal(readFileSync(file, 'utf8'), saved, 'the audience file is as it was');

  const db = new DatabaseSync(join(project, 'project.sqlite'));
  const stored = db.prepare('SELECT count(*) AS n FROM persona').get() as { n: number };
  const started = (run_id: string) => JSON.parse((db.prepare(`SELECT payload_json FROM event WHERE run_id = ? AND type = 'run.started'`).get(run_id) as { payload_json: string }).payload_json).config;
  const [ordinary, control] = [started('r-0001'), started('r-0003')];
  const people = JSON.parse(saved).personas;
  assert.deepEqual([stored.n, ordinary.personas], [4, people], 'the project keeps its personas, and an ordinary run has them');
  assert.deepEqual(control.repeat, { group: done.group, index: 3, of: 3, trait_free: 3 });
  assert.deepEqual(control.personas.map((persona: { id: string; seed: number }) => [persona.id, persona.seed]), people.map((persona: { id: string; seed: number }) => [persona.id, persona.seed]));
  assert.ok(control.personas.every((persona: { background: string; attributes: object; voice: string; goal_interpretation: string }) => persona.background === control.project.audience.segments[0].description && !Object.keys(persona.attributes).length && persona.voice === 'Plain and brief.' && persona.goal_interpretation === 'Pick a plan'));
  assert.deepEqual(control.project, ordinary.project, 'and so does the project in the snapshot');
  db.close();

  assert.match(cli('runs', project), /^r-0003 .*repeat 3 of 3 in set \S+, with no persona traits$/m);
  assert.match(cli('report', project, '--run', 'r-0001', '--format', 'md'), /- Repeats: Appeared in 2 of 2 runs\. Personas with no traits hit this too, so it may say more about the model than this audience/);
  assert.match(cli('report', project, '--repeat', done.group, '--format', 'md'), /One more run, of personas with no traits, is in no count here\./);

  const refused = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), ...args, '--fake-llm'], { encoding: 'utf8' });
  assert.match(refused('study', project, '--run', 'r-0003').stderr, /r-0003 is a set's trait-free run/);
  assert.match(cli('study', project), /r-0002 study plan: /, 'with no --run the control is passed over, though it is the newest');

  cli('rerun', project, '--base', 'r-0001', '--repeats', '2');
  const compared = lines('compare', project, '--base', 'r-0001', '--run', 'r-0004').at(-1);
  assert.deepEqual(compared.before, ['r-0001', 'r-0002'], 'a control is no sample of the audience');
  assert.ok(!compared.notes.some((note: string) => note.includes('did not finish')), compared.notes.join(' | '));

  assert.match(refused('rerun', project, '--base', 'r-0003').stderr, /r-0003 is a set's trait-free run/);
  assert.match(refused('rerun', project, '--base', 'r-0001', '--also-trait-free').stderr, /--also-trait-free is for run/);
  const empty = join(dir, 'trait-free-none');
  assert.match(refused('run', '--pois', pois, '--goal', 'Pick a plan', '--project', empty, '--also-trait-free').stderr, /needs an audience/);
  assert.ok(!existsSync(join(empty, 'runs')), 'before any run starts');
});
