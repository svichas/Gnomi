// Report disclosure, evidence navigation, and responsive layout in a disposable Electron project.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { startGym } from '../demo/GymSite/server.ts';
import { syntheticRun } from '@gnomi/simulation/graph/synthetic.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { buildReport } from '@gnomi/simulation/report/build.ts';
import type { ReportTheme } from '@gnomi/simulation/types.ts';
import { assertFits, collectErrors, deadline, launchApp, scratch, seedFinishedRun, shots } from './electron.fixture.ts';

const dir = scratch('report');
const projectDir = join(dir, 'report.gnomi');
const { config: synthetic, events } = syntheticRun({ personas: 6, pois: 1, rounds: 2, seed: 4 });
synthetic.project.name = 'Hiring app';
const config = seedFinishedRun(projectDir, synthetic, events);
// The later build: the same personas on the same pages, with nobody meeting the frictions of the first.
seedFinishedRun(projectDir, synthetic, events.filter((event) => event.type !== 'persona.friction_reported'));
const gym = await startGym({ port: 0, defects: 'none' });
const store = openProject(projectDir);
const report = buildReport(store.events(config.run_id));
store.close();
const friction = report.frictions[0];
assert.ok(friction, 'the fixture contains inspectable evidence');
const titles = ['Users could not tell whether their job was published', 'The application form lost progress after an error', 'Salary information was difficult to find', 'Search filters were easy to miss', 'The confirmation message left users unsure what happens next', 'Users struggled to return to their saved jobs'];
const theme = (title: string, i: number): ReportTheme => ({
  id: `theme-${i}`, poi_id: report.pois[0].id, rank: i + 1, title, description: 'Users expected a clear next step, but the interface left them unsure how to continue.',
  named_by: 'judge', category: 'friction', severity: i === 0 ? 4 : i < 3 ? 3 : 2, trust: 'reported', score: 1, personas: 4, frictions: 4,
  pages: [], elements: [], seqs: [friction.seq], prevalence: { personas: 4, exposed: 6, share: 4 / 6, low: 0.3, high: 0.9, level: 'strong' },
  affected: [{ segment_id: report.segments[0].id, name: report.segments[0].name, affected: 4, reached: 6, rate: 4 / 6 }],
  suggestion: { change: 'Make the next action clear and confirm when it is complete.', solution: 'Use a specific button label and a short confirmation with a link to the published job.' },
  evidence: [{ ...friction, step_seq: null, trust: 'reported', quote: 'Did that save a draft or publish my job?', screenshot: null, signals: [] }],
});
report.themes = titles.map(theme);
report.themes.push({ ...theme('One user wanted a keyboard shortcut', 6), personas: 1, prevalence: { personas: 1, exposed: 6, share: 1 / 6, low: 0.03, high: 0.56, level: 'single' } });
report.themes.push({ ...theme('Users hesitated at the subscription price', 7), category: 'objection' });
report.went_well = [{ text: 'The job preview was easy to scan', personas: 4, count: 4, seqs: [] }];
const app = await launchApp(join(dir, 'user-data'), { GNOMI_PROJECT_DIR: projectDir });
deadline('Report smoke timed out.', 90_000);
let passed = false;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  const errors = collectErrors(page);
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  // Keep the real run and inspector; only replace the generated prose with a stable report fixture.
  await page.addInitScript((report) => {
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, options) {
      if (message?.kind !== 'request' || message.method !== 'get_report') {
        post.call(this, message, Array.isArray(options) ? { transfer: options } : options);
        return;
      }
      const variant = sessionStorage.getItem('report-variant');
      const result = variant === 'empty' ? { ...report, themes: [], frictions: [] } : variant === 'legacy' ? { ...report, themes: undefined } : report;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { kind: 'response', id: message.id, ok: true, result } })));
    };
  }, report);
  const openReport = async () => {
    await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
    await page.locator('#tab-run').click();
    await page.getByRole('heading', { name: 'Report', exact: true }).waitFor();
  };
  await page.reload();
  await openReport();
  const root = page.locator('.report-page');
  const first = root.locator('.report-finding').first();
  assert.equal(await root.locator('details[open]').count(), 0, 'all supporting detail starts closed');
  assert.equal(await root.locator('.report-finding-summary:visible').count(), 5, 'five readable issues lead the report');
  assert.equal(await root.getByText('Suggested change', { exact: true }).first().isVisible(), false);
  assert.equal(await root.getByText('Recorded cost', { exact: true }).isVisible(), false);
  await page.setViewportSize({ width: 1100, height: 1000 });
  await root.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-overview.png'), fullPage: true });
  const trigger = first.locator('summary');
  await trigger.focus();
  await page.keyboard.press('Enter');
  assert.ok(await first.getByText('Suggested change', { exact: true }).isVisible());
  assert.ok(await first.getByText('Behind this finding', { exact: true }).isVisible());
  await first.getByRole('button', { name: friction.persona_name, exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await first.scrollIntoViewIfNeeded();
    await assertFits(page, `expanded report overflow at ${width}`);
    await page.screenshot({ path: join(shots, `report-expanded-${width}.png`), fullPage: true });
  }
  await trigger.focus();
  await page.keyboard.press('Space');
  assert.equal(await first.locator('details').getAttribute('open'), null, 'Space closes the issue');
  await root.locator('.report-overflow > summary').click();
  const sixth = root.locator('.report-overflow .report-finding').first();
  assert.ok(await sixth.isVisible());
  assert.equal(await sixth.locator('.report-finding-number').innerText(), '06', 'numbering continues past the fold');
  for (const title of ['Individual observations', 'Reasons for hesitation', 'Audience breakdown', 'User journeys', 'Run details & methodology']) {
    const fold = root.locator('.report-fold').filter({ has: page.locator('summary h3').filter({ hasText: title }) });
    await fold.locator(':scope > summary').click();
    assert.ok(await fold.locator(':scope > .report-fold-body').isVisible(), title);
  }
  assert.ok(await root.getByText('Recorded cost', { exact: true }).isVisible());
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'all details fit a narrow viewport');
  for (const variant of ['empty', 'legacy']) {
    await page.evaluate((value) => sessionStorage.setItem('report-variant', value), variant);
    await page.reload();
    await openReport();
    assert.ok(await root.getByText(variant === 'empty' ? 'No shared issues were reported in this run.' : friction.what, { exact: true }).first().isVisible());
    await assertFits(page, `${variant} report fits a narrow viewport`);
  }
  // Compare, reached from the run history: the real engine call, on the real reports of the two seeded runs.
  await page.evaluate(() => sessionStorage.removeItem('report-variant'));
  await page.reload();
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.locator('#tab-runs').click();
  const history = page.locator('#panel-runs');
  assert.equal(await history.getByLabel('Earlier run').inputValue(), config.run_id, 'the two newest runs to begin with');
  await assertFits(page, 'the run picker fits');
  await history.getByLabel('Later run').selectOption(config.run_id);
  assert.ok(await history.getByRole('button', { name: 'Compare', exact: true }).isDisabled(), 'a run against itself says nothing');
  await history.getByLabel('Later run').selectOption('r-0002');
  await history.getByRole('button', { name: 'Compare', exact: true }).click();
  const compare = history.getByRole('region', { name: 'Comparison of two runs' });
  await compare.waitFor();
  assert.ok(await compare.getByText('means the later run did not show a problem, not that it is fixed', { exact: false }).isVisible(), 'the notice leads the view');
  assert.ok(await compare.getByRole('heading', { name: /^Not seen again/ }).isVisible());
  assert.ok(await compare.getByText(/was in 1 of 1 run, not seen in 1 of 1, 6 personas reached its page\./).first().isVisible());
  assert.equal(await compare.getByText(/^Fixed\b/).count(), 0, 'nothing on the screen calls a problem fixed');
  for (const width of [1440, 768, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await assertFits(page, `compare overflow at ${width}`);
    assert.ok(await compare.locator('.report-finding-copy h4').first().evaluate((title) => title.getBoundingClientRect().width > 200), `a theme keeps its width at ${width}`);
    await page.screenshot({ path: join(shots, `compare-${width}.png`), fullPage: true });
  }
  await history.getByRole('button', { name: 'Back to past runs' }).click();
  await history.getByLabel('Earlier run').waitFor();

  // Run again: refused by the engine with its reason, then a real rerun on another address.
  await page.getByRole('button', { name: 'r-0002', exact: false }).first().click();
  await page.getByRole('button', { name: 'Run again', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Run again' });
  await dialog.getByText(/^About \$/).waitFor();
  await assertFits(page, 'the dialog fits a narrow viewport');
  await page.screenshot({ path: join(shots, 'run-again-320.png') });
  const address = dialog.getByLabel(/^Address of/);
  await address.fill('not a web address');
  await dialog.getByRole('button', { name: 'Start run' }).click();
  await dialog.getByText('is not a web address Gnomi can open', { exact: false }).waitFor();
  await address.fill(`${gym.url}/`);
  await dialog.getByRole('button', { name: 'Start run' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.locator('.run-history-context code').getByText('r-0003', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.getByRole('button', { name: 'Run again', exact: true }).waitFor({ timeout: 30_000 });
  assert.deepEqual(errors, []);
  console.log('ok    collapsed findings, keyboard toggles, evidence inspector, continued numbering, detail sections, empty/legacy reports, compare and run again, and 320–1440px layouts');
  passed = true;
} catch (error) {
  await (await app.firstWindow()).screenshot({ path: join(shots, 'report-failure.png'), fullPage: true });
  throw error;
} finally {
  await app.close();
  await gym.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Report fixture retained: ${dir}`);
}
