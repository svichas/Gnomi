// Report disclosure, evidence navigation, and responsive layout in a disposable Electron project.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { syntheticRun } from '@gnomi/simulation/graph/synthetic.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { buildReport } from '@gnomi/simulation/report/build.ts';
import type { ReportFlow, ReportTheme } from '@gnomi/simulation/types.ts';
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
// A wide and a tall screenshot with a frame on each, a plain one, and one with no file: nothing to mark.
const shotPath = (name: string) => `runs/${config.run_id}/shots/${name}.jpg`;
const box = { left: 25, top: 50, width: 20, height: 10, element: 'button "Publish"' };
const [evidence] = report.themes[0].evidence;
report.themes[0].evidence = [{ ...evidence, screenshot: shotPath('wide'), box }, { ...evidence, screenshot: shotPath('tall'), box }, { ...evidence, screenshot: shotPath('wide') }, { ...evidence, screenshot: shotPath('gone'), box }];
const pageName = (i: number) => `staging.hiring.example.com/settings/organisation/users/:id/permissions/${i}`;
const flow: ReportFlow = {
  poi_id: report.pois[0].id, personas: 6, left_out: { pages: 3, ended: 1 },
  pages: Array.from({ length: 8 }, (_, i) => ({ page: pageName(i), reached: 6 - Math.floor(i / 2), ended: i === 0 ? { abandoned: 1 } : i === 7 ? { done: 2, repeated_failure: 1 } : {} })),
  moves: Array.from({ length: 7 }, (_, i) => ({ from: pageName(i), to: pageName(i + 1), personas: 6 - Math.floor(i / 2) })).concat({ from: pageName(3), to: pageName(0), personas: 2 }, { from: pageName(0), to: pageName(7), personas: 1 }),
};
report.flows = [flow];
const exportedFile = join(dir, 'report.html');
/** Every frame on show sits on the same spot of its image, whatever size the image is drawn at. */
async function assertMarks(page: Page, when: string) {
  const placed = await page.locator('.report-shot-box').evaluateAll((marks) => marks.filter((mark) => mark.checkVisibility()).map((mark) => {
    const image = mark.parentElement!.querySelector('img')!.getBoundingClientRect();
    const frame = mark.getBoundingClientRect();
    return [(frame.left - image.left) / image.width, (frame.top - image.top) / image.height, frame.width / image.width, frame.height / image.height];
  }));
  assert.equal(placed.length, 2, `two frames ${when}`);
  for (const at of placed) at.forEach((n, i) => assert.ok(Math.abs(n - [0.25, 0.5, 0.2, 0.1][i]) < 0.015, `the frame ${when} is at ${at}`));
}

const app = await launchApp(join(dir, 'user-data'), { GNOMI_PROJECT_DIR: projectDir });
deadline('Report smoke timed out.', 90_000);
let passed = false;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  const errors = collectErrors(page);
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  mkdirSync(join(projectDir, 'runs', config.run_id, 'shots'), { recursive: true });
  for (const [name, width, height] of [['wide', 1280, 800], ['tall', 393, 659]] as const) {
    await page.setViewportSize({ width, height });
    writeFileSync(join(projectDir, shotPath(name)), await page.screenshot({ type: 'jpeg' }));
  }
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportedFile);
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
  await first.getByRole('button', { name: friction.persona_name, exact: true }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const images = first.locator('.report-shot img');
  await first.getByText('The screenshot could not be loaded.').waitFor();
  for (const i of [0, 1, 2]) await images.nth(i).waitFor();
  assert.equal(await first.locator('.report-shot-box').count(), 3);
  assert.equal(await first.getByRole('img', { name: 'Marked on the screenshot: button "Publish"' }).count(), 2, 'named, and only over an image that loaded');
  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await first.scrollIntoViewIfNeeded();
    await assertFits(page, `expanded report overflow at ${width}`);
    await assertMarks(page, `at ${width}`);
    await page.screenshot({ path: join(shots, `report-expanded-${width}.png`), fullPage: true });
  }
  await page.emulateMedia({ media: 'print', reducedMotion: 'reduce' });
  await assertMarks(page, 'in print with reduced motion');
  await page.emulateMedia({ media: 'screen', reducedMotion: 'no-preference' });
  await trigger.focus();
  await page.keyboard.press('Space');
  assert.equal(await first.locator('details').getAttribute('open'), null, 'Space closes the issue');
  await root.locator('.report-overflow > summary').click();
  const sixth = root.locator('.report-overflow .report-finding').first();
  assert.ok(await sixth.isVisible());
  assert.equal(await sixth.locator('.report-finding-number').innerText(), '06', 'numbering continues past the fold');
  for (const title of ['Individual observations', 'Reasons for hesitation', 'Where personas went', 'Audience breakdown', 'User journeys', 'Run details & methodology']) {
    const fold = root.locator('.report-fold').filter({ has: page.locator('summary h3').filter({ hasText: title }) });
    await fold.locator(':scope > summary').click();
    assert.ok(await fold.locator(':scope > .report-fold-body').isVisible(), title);
  }
  assert.ok(await root.getByText('Recorded cost', { exact: true }).isVisible());
  const graph = root.getByRole('img', { name: /^Moves of 6 personas between 8 pages/ });
  assert.ok(await graph.isVisible());
  assert.equal(await graph.locator('.report-flow-move').count(), 9);
  assert.ok(await root.getByText('3 less visited pages left out, where 1 persona ended.').isVisible());
  assert.equal(await root.locator('section:has(> details .report-flow) table tbody tr').count(), 8, 'the table has every page the graph has');
  assert.ok(await root.getByRole('cell', { name: '3: 2 reached the goal, 1 got stuck' }).isVisible());
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'all details fit a narrow viewport');
  await graph.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-flow-320.png') });
  const overrun = await graph.evaluate((svg) => {
    const width = svg.getBoundingClientRect().width;
    return [...svg.querySelectorAll('text, rect')].filter((part) => { const { x, width: wide } = (part as SVGGraphicsElement).getBBox(); return x + wide > width; }).map((part) => part.textContent);
  });
  assert.deepEqual(overrun, [], 'nothing in the graph is cut off at 320 px');
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.getByRole('button', { name: 'Export report' }).click();
  await page.getByText(/^Report exported to/).waitFor();
  // The exported file itself, opened as a reader would and printed: no script runs in it, so the frames hold up by CSS alone.
  void app.evaluate(({ BrowserWindow }, file) => { new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { partition: 'exported-report' } }).loadFile(file); }, exportedFile); // a session of its own, as printing has: the app's CSP allows no inline styles
  const file = await app.waitForEvent('window');
  await file.locator('.report-shot-box').first().waitFor({ state: 'attached' });
  await assertMarks(file, 'in the exported file');
  await file.emulateMedia({ media: 'print' });
  await assertMarks(file, 'in the exported file, printed');
  assert.equal(await file.locator('.report-flow').count(), 1);
  await file.close();
  await page.setViewportSize({ width: 320, height: 1000 });
  for (const variant of ['empty', 'legacy']) {
    await page.evaluate((value) => sessionStorage.setItem('report-variant', value), variant);
    await page.reload();
    await openReport();
    assert.ok(await root.getByText(variant === 'empty' ? 'No shared issues were reported in this run.' : friction.what, { exact: true }).first().isVisible());
    await assertFits(page, `${variant} report fits a narrow viewport`);
  }
  assert.deepEqual(errors, []);
  console.log('ok    collapsed findings, keyboard toggles, evidence inspector, boxes on screenshots in the app and the printed export, the drop-off flow, continued numbering, detail sections, empty/legacy reports, and 320–1440px layouts');
  passed = true;
} catch (error) {
  await (await app.firstWindow()).screenshot({ path: join(shots, 'report-failure.png'), fullPage: true });
  throw error;
} finally {
  await app.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Report fixture retained: ${dir}`);
}
