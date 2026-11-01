// Project journey and timeline interactions in real Electron, using a disposable synthetic run.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { syntheticRun } from '@gnomi/simulation/graph/synthetic.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { DEFAULT_SETTINGS, PROVIDER_DEFAULTS } from '@gnomi/simulation/settings.ts';
import { startGym } from '../demo/GymSite/server.ts';
import { toRows } from './src/renderer/src/activity.ts';
import { roundMoments, selectMoments } from './src/renderer/src/swarm-moments.ts';
import { assertFits, collectErrors, deadline, launchApp, scratch, seedFinishedRun, seedProject, shots } from './electron.fixture.ts';

const dir = scratch('ui');
const projectDir = join(dir, 'perspectives.gnomi');
const { config: synthetic, events } = syntheticRun({ personas: 6, pois: 1, rounds: 2, seed: 4 });
synthetic.project.name = 'Hiring app';
const config = seedFinishedRun(projectDir, synthetic, events);
const launch = () => launchApp(join(dir, 'user-data'), { GNOMI_PROJECT_DIR: projectDir });
let app = await launch();
deadline('UI smoke timed out.', 300_000);
let passed = false;
const gym = await startGym({ port: 0, defects: 'all' });
try {
  let page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors = collectErrors(page, { console: true });
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor().catch(async (error) => {
    console.error('Initial UI:', await page.locator('body').innerText(), errors);
    await page.screenshot({ path: join(shots, 'ui-startup-failure.png') });
    throw error;
  });
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.getByAltText('Gnomi', { exact: true }).evaluate((image) => (image as HTMLImageElement).naturalWidth > 0));
  assert.ok(await page.evaluate(() => [...document.fonts].some((font) => font.family === 'Inter' && font.status === 'loaded')));
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(246, 245, 240)');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  assert.equal(await skip.evaluate((element) => getComputedStyle(element).opacity), '0');
  await skip.focus();
  assert.equal(await skip.evaluate((element) => getComputedStyle(element).opacity), '1');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content');
  assert.equal(await skip.evaluate((element) => getComputedStyle(element).opacity), '0');
  await page.getByRole('button', { name: 'Continue to audience' }).click();
  await page.getByRole('heading', { name: 'A few different perspectives.' }).waitFor();
  await page.getByRole('button', { name: 'Back to setup', exact: true }).first().click();
  assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Hiring app');
  console.log('ok    bundled logo/font load, brand palette applies, and the guided journey preserves setup');

  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await assertFits(page, `setup overflow at ${width}`);
    for (const label of ['Setup', 'Audience', 'Review', 'Simulation']) {
      assert.ok(await page.getByRole('navigation', { name: 'Project steps' }).getByRole('button', { name: label, exact: true }).isVisible());
    }
    await page.screenshot({ path: join(shots, `revamp-setup-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.locator('#tab-run').click();
  await page.getByRole('heading', { name: 'Report', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Simulation', exact: true }).click();
  await page.getByRole('region', { name: 'Swarm graph' }).waitFor();
  await page.waitForFunction((population) => document.querySelector('#swarm-focus optgroup[label="Simulated people"]')?.childElementCount === population, config.personas.length);
  const graph = page.getByRole('region', { name: 'Swarm graph' });
  const expectedMoments = selectMoments(roundMoments(events, 2, events.at(-1)!.seq), 'social', null);
  await graph.getByRole('button', { name: 'Social', exact: true }).click();
  await graph.getByRole('heading', { name: 'Who’s talking to whom' }).waitFor();
  assert.equal(await graph.locator('.swarm-moments-list li').count(), expectedMoments.length);
  assert.ok(await graph.locator('.swarm-social-arrow').count() > 0, 'social moments have directional arrows');
  const namedPair = expectedMoments.find((moment) => moment.target)!;
  const personName = (id: string) => config.personas.find((persona) => persona.id === id)!.name;
  assert.ok((await graph.locator('.swarm-moment-people').allTextContents()).includes(`${personName(namedPair.persona)} → ${personName(namedPair.target!)}`));
  await graph.screenshot({ path: join(shots, 'swarm-social.png') });
  await graph.getByRole('checkbox', { name: /^Conversations/ }).uncheck();
  assert.equal(await graph.locator('.swarm-social-arrow').count(), 0, 'connection filters also hide the arrows');
  await graph.getByRole('button', { name: 'Friction', exact: true }).click();
  await graph.getByRole('heading', { name: 'Where people struggle' }).waitFor();
  assert.equal(await graph.locator('.swarm-moments-list li:not([data-tone="friction"])').count(), 0);
  await graph.screenshot({ path: join(shots, 'swarm-friction.png') });
  const slider = graph.getByRole('slider');
  await slider.focus();
  await page.keyboard.press('Home');
  await graph.getByText('History · Round 1').waitFor();
  const roundOne = selectMoments(roundMoments(events, 1, events.at(-1)!.seq), 'friction', null);
  await page.waitForFunction((seqs) => JSON.stringify([...document.querySelectorAll('[data-bubble]')].map((el) => Number(el.getAttribute('data-bubble')))) === JSON.stringify(seqs), roundOne.map((m) => m.seq));
  await graph.getByRole('button', { name: 'Back to latest' }).click();
  await graph.getByRole('button', { name: 'All activity', exact: true }).click();
  await graph.getByRole('checkbox', { name: 'Show bubbles' }).uncheck();
  assert.equal(await graph.locator('.swarm-bubble').count(), 0);
  await graph.getByRole('checkbox', { name: 'Show bubbles' }).check();
  const bubble = graph.locator('.swarm-bubble:visible').first();
  const bubbleSeq = Number(await bubble.getAttribute('data-bubble'));
  const bubbleEvent = toRows(events).find((event) => event.seq === bubbleSeq)!;
  await bubble.focus();
  await page.keyboard.press('Enter');
  const graphInspector = page.getByRole('complementary', { name: 'Persona inspector' });
  await graphInspector.waitFor();
  await graphInspector.locator('li.ring-2').waitFor();
  assert.ok((await graphInspector.locator('li.ring-2').innerText()).includes(bubbleEvent.title), 'bubble opens its recorded event in the inspector');
  await graphInspector.getByRole('button', { name: 'Close' }).click();
  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await assertFits(page, `map overflow at ${width}`);
    await graph.screenshot({ path: join(shots, `swarm-moments-${width}.png`) });
  }
  await page.setViewportSize({ width: 1100, height: 900 });
  console.log('ok    graph bubbles, named social arrows, filters, replay, keyboard inspection and responsive widths');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(shots, 'simulation-overview.png') });
  const activity = page.getByRole('region', { name: 'Activity', exact: true });
  await activity.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
  await activity.getByRole('heading', { name: 'Activity', exact: true }).evaluate((element) => element.scrollIntoView({ block: 'start' }));
  const quotedMoment = activity.locator('.timeline-item').filter({ has: page.locator('.moment-quote') }).first();
  await quotedMoment.waitFor();
  assert.ok(await quotedMoment.locator('.moment-quote').isVisible(), 'thoughts and feedback are readable before expanding details');
  assert.ok(await quotedMoment.locator('.timeline-one-line').isVisible(), 'the action stays visible alongside its quote');
  await page.screenshot({ path: join(shots, 'simulation-activity.png') });
  await activity.getByRole('button', { name: 'Filter', exact: true }).click();
  await activity.getByLabel('Kind of event').selectOption('steps');
  await activity.scrollIntoViewIfNeeded();
  const row = activity.locator('.timeline-item').filter({ has: page.locator('.event-message') }).first();
  await row.waitFor();
  const trigger = row.locator('.timeline-trigger');
  await trigger.hover();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'hover leaves activity details collapsed');
  assert.equal(await row.locator('.timeline-detail').isVisible(), false);
  await trigger.focus();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'focus alone leaves details collapsed');
  await trigger.click();
  await row.locator('.timeline-detail').waitFor({ state: 'visible' });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: join(shots, 'revamp-timeline-detail.png') });
  await page.mouse.move(0, 0);
  assert.ok(await row.locator('.timeline-detail').isVisible(), 'clicked details remain open after leaving the row');
  await trigger.click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'click again collapses details');
  await page.keyboard.press('Enter');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'Enter expands details');
  await page.keyboard.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await page.locator('#tab-run').focus();
  await trigger.focus();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  const inspector = page.getByRole('dialog', { name: 'Persona details' });
  const personaName = await row.locator('.timeline-persona-name').innerText();
  const persona = config.personas.find((candidate) => candidate.name === personaName)!;
  const personaRows = toRows(events.filter((event) => event.persona_id === persona.id));
  assert.ok(personaRows.some((item) => item.label === 'Feed'), 'fixture includes routine activity outside the steps filter');
  for (const target of [row.locator('.timeline-persona-name'), row.locator('button.timeline-marker')]) {
    await target.click();
    await inspector.waitFor();
    await inspector.getByRole('heading', { name: personaName, exact: false }).waitFor();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'opening a persona does not expand the activity');
    const history = inspector.getByRole('region', { name: 'Timeline', exact: true }).getByRole('listitem');
    await history.first().waitFor();
    assert.equal(await history.count(), personaRows.length, 'profile includes the entire persona history despite feed filters');
    await inspector.getByText('Full profile', { exact: true }).click();
    assert.ok(await inspector.getByLabel('Profile', { exact: true }).getAttribute('open') !== null);
    await page.screenshot({ path: join(shots, 'revamp-timeline-persona.png') });
    await page.keyboard.press('Escape');
    await inspector.waitFor({ state: 'detached' });
    assert.ok(await target.evaluate((element) => element === document.activeElement), `focus returns to the persona control, got ${await page.evaluate(() => document.activeElement?.tagName)}`);
  }
  await trigger.focus();
  await page.keyboard.press('Space');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'Space expands details');
  await row.getByRole('button', { name: 'View persona & evidence' }).click();
  await inspector.waitFor();
  assert.ok(await inspector.evaluate((dialog) => dialog.contains(document.activeElement)), 'focus enters inspector');
  await page.keyboard.press('Escape');
  await inspector.waitFor({ state: 'detached' });
  await activity.getByRole('button', { name: 'Clear filters' }).click();
  assert.equal(await activity.getByLabel('Kind of event').inputValue(), '');
  await activity.getByRole('button', { name: 'Filter', exact: true }).click();
  const highlights = Number(await activity.locator('.count-label').innerText());
  await activity.getByRole('button', { name: 'All events', exact: true }).click();
  assert.ok(Number(await activity.locator('.count-label').innerText()) > highlights);
  await activity.getByRole('button', { name: 'Highlights', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.locator('#tab-run').focus();
  console.log('ok    click-only timeline details, keyboard controls, persona name/avatar profiles, full history, focus return and filter reset');

  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await activity.scrollIntoViewIfNeeded();
    await assertFits(page, `timeline overflow at ${width}`);
    await page.screenshot({ path: join(shots, `revamp-timeline-${width}.png`) });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await activity.locator('.timeline-item').first().evaluate((element) => getComputedStyle(element).transitionDuration), '0s');
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.getByRole('tab', { name: 'Simulation', exact: true }).focus();
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab', { name: 'Report', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  await page.getByRole('region', { name: 'Swarm graph' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Simulation', exact: true }).getAttribute('aria-selected'), 'true');
  await page.locator('#tab-project').click();
  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(300); // hidden graph resize callbacks must not throw
  await page.locator('#tab-run').click();
  await page.getByRole('region', { name: 'Swarm graph' }).waitFor();
  assert.ok(await page.locator('.sigma-container').evaluate((element) => element.clientWidth > 0));
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await assertFits(page, `projects overflow at ${width}`);
    await page.screenshot({ path: join(shots, `revamp-projects-${width}.png`) });
  }
  const search = page.getByRole('searchbox', { name: 'Search projects' });
  await search.fill('  HIRING  ');
  assert.equal(await page.getByRole('list', { name: 'Projects', exact: true }).getByRole('listitem').count(), 1);
  await search.fill('no matching project');
  await page.getByRole('heading', { name: 'No matching projects', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  assert.equal(await search.inputValue(), '');
  await page.getByRole('button', { name: 'Open Hiring app', exact: true }).click();
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Hiring app');
  console.log('ok    320/768/1024/1440px layouts, reduced motion, no runtime or console errors, and remembered project after restart');

  // The two extra checks at 320 px, on a project that already names a check model, through real runs on Gym with scripted models.
  await app.close();
  const checksDir = join(dir, 'checks.gnomi');
  const check_model = PROVIDER_DEFAULTS.openai.judge;
  seedProject(checksDir, {
    name: 'Gym checks', description: '', goal: 'Look around the site', role: null, audience: null,
    pois: [{ id: 'gym', type: 'web', mode: 'full', segments: null, name: 'Gym', start_url: `${gym.url}/`, allowed_hosts: [], production_domains: [], reset_hook_url: null }],
    settings: { ...DEFAULT_SETTINGS, social: false, check_model },
  });
  app = await launchApp(join(dir, 'user-data'), { GNOMI_PROJECT_DIR: checksDir });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const checkErrors = collectErrors(page, { console: true });
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  await page.setViewportSize({ width: 320, height: 900 });
  const panel = page.locator('#panel-settings');
  const evidence = panel.getByRole('checkbox', { name: /^Evidence check/ });
  const scan = panel.getByRole('checkbox', { name: /^Accessibility scan/ });
  const review = page.locator('#panel-review');
  const estimatedCalls = async () => {
    await page.locator('#tab-review').click();
    return Number((await review.getByText(/about [\d,]+ model calls/).innerText()).match(/about ([\d,]+) model calls/)![1].replace(',', ''));
  };
  /** Starts a run from the Review step and returns its log once its report is in. */
  const runLog = async (id: string) => {
    await review.getByRole('button', { name: 'Start run', exact: true }).click();
    await page.getByRole('tab', { name: 'Report', exact: true }).waitFor();
    await page.locator('.run-history-context code').getByText(id, { exact: true }).waitFor();
    const log = openProject(checksDir, { readOnly: true });
    try {
      for (let wait = 0; wait < 600 && log.listRuns().find((run) => run.run_id === id)?.status === 'running'; wait++) await new Promise((done) => setTimeout(done, 100));
      assert.equal(log.listRuns().find((run) => run.run_id === id)?.status, 'finished');
      return log.events(id);
    } finally {
      log.close();
    }
  };
  const callsOff = await estimatedCalls();
  await page.locator('#tab-settings').click();
  assert.ok(!(await evidence.isChecked()) && !(await scan.isChecked()), 'both are off by default');
  assert.equal(await panel.getByLabel('Evidence check provider').count(), 0, 'no check model to choose while the check is off');
  await evidence.check();
  await evidence.uncheck();
  await page.locator('.save-state[data-dirty="false"]').waitFor(); // off again is the project as it was
  await evidence.check();
  await scan.check();
  await assertFits(page, 'the extra checks fit 320 px');
  for (const box of [evidence, scan]) assert.equal(await box.evaluate((input) => input.getBoundingClientRect().width), 16, 'a long label leaves the checkbox its size');
  await panel.locator('summary', { hasText: 'Model choices' }).click();
  assert.equal(await panel.getByLabel('Evidence check provider').inputValue(), 'openai');
  assert.equal(await panel.getByLabel('Evidence check model').inputValue(), check_model.model);
  await panel.getByText('The selected AI provider is not connected', { exact: false }).last().waitFor();
  await assertFits(page, 'the check model row fits 320 px');
  await page.screenshot({ path: join(shots, 'settings-checks-320.png'), fullPage: true });

  assert.equal(await estimatedCalls(), callsOff + 3, 'the estimate counts the check\'s calls');
  await review.getByText('The estimate includes the evidence check after the run.').waitFor();
  await review.getByText('The accessibility scan makes no model calls', { exact: false }).waitFor();
  await review.getByRole('region', { name: 'Models', exact: true }).getByText(`OpenAI · ${check_model.model}`).waitFor();
  await assertFits(page, 'the review fits 320 px with both checks on');
  const on = await runLog('r-0001');
  const started = on.find((event) => event.type === 'run.started');
  assert.ok(started?.type === 'run.started');
  assert.equal(started.payload.config.project.settings.finding_check, true);
  assert.equal(started.payload.config.project.settings.accessibility_checks, true);
  assert.deepEqual(started.payload.config.project.settings.check_model, check_model);
  assert.ok(on.some((event) => event.type === 'accessibility.scanned'), 'the run scanned its pages');

  await page.locator('#tab-settings').click();
  await evidence.uncheck();
  await scan.uncheck();
  await panel.getByLabel('Evidence check provider').waitFor({ state: 'detached' });
  assert.equal(await estimatedCalls(), callsOff, 'the estimate drops the check again');
  assert.equal(await review.getByText('Evidence check', { exact: true }).count(), 0);
  const off = await runLog('r-0002');
  const offStarted = off.find((event) => event.type === 'run.started');
  assert.ok(offStarted?.type === 'run.started');
  assert.ok(!('finding_check' in offStarted.payload.config.project.settings) && !('accessibility_checks' in offStarted.payload.config.project.settings));
  assert.ok(!off.some((event) => event.type === 'accessibility.scanned' || event.type === 'report.checks'), 'nothing of either ran');
  assert.deepEqual(checkErrors, []);
  console.log('ok    the extra checks fit 320 px, count in the estimate, reach a run from the app, and leave a run with them off as before');
  passed = true;
} catch (error) {
  await (await app.firstWindow()).screenshot({ path: join(shots, 'revamp-failure.png') });
  throw error;
} finally {
  await app.close();
  await gym.close();
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`UI fixture retained: ${dir}`);
}
