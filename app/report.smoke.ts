// Report disclosure, evidence navigation, and responsive layout in a disposable Electron project.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
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
  const summary = root.getByRole('region', { name: 'Summary' });
  assert.match(await summary.innerText(), /^The biggest problem in this run is “Users could not tell whether their job was published”, met by 4 of 6 personas who tried it\./);
  assert.ok((await summary.boundingBox())!.y < (await root.getByRole('region', { name: 'At a glance' }).boundingBox())!.y, 'the summary sits above the glance');
  assert.equal(await first.locator('summary').getByText('Fix now', { exact: true }).count(), 1, 'the top finding carries its label');
  assert.match((await first.locator('summary').getByText('Fix now', { exact: true }).getAttribute('title'))!, /where to look first within this run/);
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
  const hesitations = root.locator('.report-fold').filter({ has: page.locator('summary h3').filter({ hasText: 'Reasons for hesitation' }) });
  assert.deepEqual(await hesitations.locator('.report-finding-summary .tone-chip').allInnerTexts(), ['Moderate'], 'an objection has a severity and no priority');
  const singles = root.locator('.report-fold').filter({ has: page.locator('summary h3').filter({ hasText: 'Individual observations' }) });
  assert.equal(await singles.locator('.report-finding-summary').getByText('Later', { exact: true }).count(), 1, 'one self-report waits');
  assert.ok(await root.getByText('Recorded cost', { exact: true }).isVisible());
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'all details fit a narrow viewport');
  for (const variant of ['empty', 'legacy']) {
    await page.evaluate((value) => sessionStorage.setItem('report-variant', value), variant);
    await page.reload();
    await openReport();
    assert.ok(await root.getByText(variant === 'empty' ? 'No shared issues were reported in this run.' : friction.what, { exact: true }).first().isVisible());
    assert.equal(await root.getByRole('region', { name: 'Summary' }).count(), variant === 'empty' ? 1 : 0, 'a report without themes has nothing to summarise');
    await assertFits(page, `${variant} report fits a narrow viewport`);
  }
  assert.deepEqual(errors, []);
  console.log('ok    collapsed findings, written summary, priority labels, keyboard toggles, evidence inspector, continued numbering, detail sections, empty/legacy reports, and 320–1440px layouts');
  passed = true;
} catch (error) {
  await (await app.firstWindow()).screenshot({ path: join(shots, 'report-failure.png'), fullPage: true });
  throw error;
} finally {
  await app.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Report fixture retained: ${dir}`);
}
