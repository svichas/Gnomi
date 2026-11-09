// Report disclosure, evidence navigation, and responsive layout in a disposable Electron project.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startGym } from '../demo/GymSite/server.ts';
import type { Page } from 'playwright-core';
import { syntheticRun } from '@gnomi/simulation/graph/synthetic.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { buildReport } from '@gnomi/simulation/report/build.ts';
import type { ReportFlow, ReportTheme } from '@gnomi/simulation/types.ts';
import { assertFits, collectErrors, deadline, launchApp, scratch, seedFinishedRun, shots } from './electron.fixture.ts';

const dir = scratch('report');
const projectDir = join(dir, 'report.gnomi');
const { config: synthetic, events: plainEvents } = syntheticRun({ personas: 6, pois: 1, rounds: 2, seed: 4 });
synthetic.project.name = 'Hiring app';
synthetic.project.settings = { ...synthetic.project.settings, accessibility_checks: true }; // the rerun below scans in the built host
const shotPath = (name: string) => `runs/r-0001/shots/${name}.jpg`;
// Every persona browsed with simulated vision, so the inspector labels what its screenshots show.
const events = plainEvents.map((event) => (
  event.type === 'persona.step' ? { ...event, payload: { ...event.payload, screenshot: shotPath('wide') } }
    : event.type === 'persona.episode_started' ? { ...event, payload: { ...event.payload, perception: 'deuteranopia' as const } }
    : event
));
// One persona's four steps for the replay: a wide and a tall screenshot, a step with none, and one whose file is gone.
const replayed = events.find((event) => event.type === 'persona.friction_reported')!.persona_id;
const replayShots = [shotPath('wide'), shotPath('tall'), null, shotPath('gone')];
for (const event of events) if (event.type === 'persona.step' && event.persona_id === replayed) event.payload.screenshot = replayShots.shift()!;
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
// What the page scan found alone: as long as real paths get, so the check at 320 px proves they wrap.
const contrast = { rule: 'color-contrast', impact: 'serious', category: 'color', help: 'Elements must meet minimum color contrast ratio thresholds', elements: 12, selectors: Array.from({ length: 3 }, (_, i) => `main:nth-child(2) > div:nth-child(3) > section:nth-child(1) > form:nth-child(3) > button:nth-child(${i + 1})`) } as const;
report.themes.push({
  ...theme('Elements must meet minimum color contrast ratio thresholds on /jobs/new', 8), scan_only: true, trust: 'observed', personas: 0, first_hand: [], suggestion: null,
  prevalence: { personas: 0, exposed: 6, share: 0, low: 0, high: 0.39, level: 'none' }, affected: [{ segment_id: report.segments[0].id, name: report.segments[0].name, affected: 0, reached: 6, rate: 0 }],
  evidence: [{ ...friction, step_seq: null, trust: 'observed', what: `Accessibility scan: ${contrast.help} (color-contrast, serious, 12 elements)`, quote: '', screenshot: null, signals: ['accessibility'], scan: { ...contrast, selectors: [...contrast.selectors] } }],
});
report.methods.accessibility_audit = [{ page: 'app.example.com/dashboard', rule: 'heading-order', impact: 'moderate', help: 'Heading levels should only increase by one', elements: 2, selectors: ['main:nth-child(2) > div:nth-child(3) > section:nth-child(1) > h4:nth-child(1)'] }];
report.methods.grounding = [{ segment_id: report.segments[0].id!, name: report.segments[0].name, facts: 8, remarks: 5, sources: ['a-very-long-file-name-for-interview-notes-from-the-spring-research-round.md', 'tickets.txt'] }];
report.set_aside = [{ ...theme('A persona typed its own name as the hiring manager', 9), check: { verdict: 'agent_mistake', reason: 'The persona entered its own name, so the form was right to refuse it.' } }];
report.went_well = [{ text: 'The job preview was easy to scan', personas: 4, count: 4, seqs: [] }];
// A wide and a tall screenshot with a frame on each, a plain one, and one with no file: nothing to mark.
const box = { left: 25, top: 50, width: 20, height: 10, element: 'button "Publish"' };
const [evidence] = report.themes[0].evidence;
report.themes[0].evidence = [{ ...evidence, screenshot: shotPath('wide'), box, interference: true }, { ...evidence, screenshot: shotPath('tall'), box }, { ...evidence, screenshot: shotPath('wide') }, { ...evidence, screenshot: shotPath('gone'), box }];
report.themes[0].interference = 1;
// Pictures for By screen: three findings on /jobs/new over one screenshot (two of them on the same element), two on /jobs over two, one site-wide, the rest tied to no screen.
const NEW = 'app.example.com/jobs/new';
const JOBS = 'app.example.com/jobs';
const picture = (page: string, screenshot: string, at?: typeof box) => ({ page, screenshot, ...(at ? { box: at } : {}), persona_id: friction.persona_id, step_seq: 1 });
const save = { left: 60, top: 20, width: 25, height: 12, element: 'link "Save draft"' };
const [t0, t1, t2, t3, , t5] = report.themes;
Object.assign(t0, { pages: [NEW], pictures: [picture(NEW, shotPath('wide'), box)] });
Object.assign(t1, { pages: [NEW], pictures: [picture(NEW, shotPath('wide'), save)] });
Object.assign(t2, { pages: [NEW, JOBS], pictures: [picture(NEW, shotPath('wide'), box), picture(JOBS, shotPath('tall'))] });
Object.assign(t3, { pages: [JOBS], pictures: [picture(JOBS, shotPath('wide'), save)] });
Object.assign(t5, { pages: [NEW, JOBS, 'app.example.com/jobs/:id', 'app.example.com/account'], pictures: [picture(NEW, shotPath('wide'))] });
const people = report.personas.map((persona) => persona.id);
report.reach = [{ poi_id: report.pois[0].id, started: people, surveyed: [], pages: { [NEW]: people.slice(0, 4), [JOBS]: people } }];
const pageName = (i: number) => `app.example.com/dashboard/campaigns/new-campaign/summary-${i}`; // as wide as real names get, so the check at 320 px proves the graph's limit
const flow: ReportFlow = {
  poi_id: report.pois[0].id, personas: 6, left_out: { pages: 3, ended: 1 },
  pages: Array.from({ length: 8 }, (_, i) => ({ page: pageName(i), reached: 6 - Math.floor(i / 2), ended: i === 0 ? { abandoned: 1 } : i === 7 ? { done: 2, repeated_failure: 1 } : {} })),
  moves: Array.from({ length: 7 }, (_, i) => ({ from: pageName(i), to: pageName(i + 1), personas: 6 - Math.floor(i / 2) })).concat({ from: pageName(3), to: pageName(0), personas: 2 }, { from: pageName(0), to: pageName(7), personas: 1 }),
};
report.flows = [flow];
report.themes[0].drivers = [{ id: 'seniority', name: 'Seniority', value: 'Lead', holders: { affected: 4, reached: 6 }, others: { affected: 1, reached: 9 }, gap: 0.56 }];
// What the team's own study found, beside a finding that a rejudge renamed; an outcome with no finding left; and a plan with something the quote check took out.
report.themes[0].validation = { status: 'supported', note: 'Five of six participants could not tell whether the job went live.', study_date: '2026-10-12', title: 'An earlier name for this finding' };
report.study_count = { of: 5, supported: 1, contradicted: 0, unresolved: 0, not_studied: 4 };
report.unmatched_outcomes = [{ status: 'contradicted', note: null, study_date: '2026-10-02', title: 'A finding the judge has since merged away', poi_id: report.pois[0].id }];
report.unmatched_edits = [{ title: 'A hidden finding the judge has since merged away', hidden: true, new_title: null, new_description: null }, { title: 'Another finding', hidden: false, new_title: 'Words nobody needs now', new_description: null }];
report.study_plan = {
  screener: ['Do you hire for your company at least once a quarter?'], screener_dropped: 1, left_out: { objections: 1, competitors: 0, set_aside: 1, scan_only: 1, lower_ranked: 2 }, outdated: true,
  hypotheses: [{ title: titles[0], poi_id: report.pois[0].id, tasks: ['Post a job for a new role and make it live.'], dropped: 0, observe: ['Whether people look for a sign that the job is live.'] }, { title: titles[1], poi_id: report.pois[0].id, tasks: [], dropped: 2, observe: [] }],
};
report.coverage![0].thin_pages.push({ page: pageName(1), personas: 2 }, { page: pageName(2), personas: 1 }); // as wide as real names get, for the check at 320 px
const exportedFile = join(dir, 'report.html');
/** Every frame on show sits on the same spot of its image, whatever size the image is drawn at. */
async function assertMarks(page: Page, when: string) {
  const placed = await page.locator('.report-finding .report-shot-box').evaluateAll((marks) => marks.filter((mark) => mark.checkVisibility()).map((mark) => {
    const image = mark.parentElement!.querySelector('img')!.getBoundingClientRect();
    const frame = mark.getBoundingClientRect();
    return [(frame.left - image.left) / image.width, (frame.top - image.top) / image.height, frame.width / image.width, frame.height / image.height];
  }));
  assert.equal(placed.length, 2, `two frames ${when}`);
  for (const at of placed) at.forEach((n, i) => assert.ok(Math.abs(n - [0.25, 0.5, 0.2, 0.1][i]) < 0.015, `the frame ${when} is at ${at}`));
}

const app = await launchApp(join(dir, 'user-data'), { GNOMI_PROJECT_DIR: projectDir });
deadline('Report smoke timed out.', 240_000);
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
    const heard = new WeakSet<MessagePort>(); // per port: React's scheduler posts on a MessageChannel of its own
    MessagePort.prototype.postMessage = function (message, options) {
      if (!heard.has(this)) {
        heard.add(this);
        this.addEventListener('message', ({ data }) => { if (data.kind === 'event' && data.event.type === 'report.generated' && data.event.run_id === 'r-0004') sessionStorage.setItem('set-reported', '1'); });
      }
      // Until the set's last report is written, a read of the set is out of date, so the page only gets it right by reading it again then.
      if (message?.kind === 'request' && message.method === 'get_repeats' && !sessionStorage.getItem('set-reported')) {
        const result = { group: message.params.group, of: 2, compared: 1, running: true, incomplete: false, families: [], findings: [] };
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { kind: 'response', id: message.id, ok: true, result } })));
        return;
      }
      if (message?.kind === 'request' && message.method === 'ask_persona' && sessionStorage.getItem('ask-fails')) {
        sessionStorage.removeItem('ask-fails');
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { kind: 'response', id: message.id, ok: false, error: 'The model did not answer in time.' } })));
        return;
      }
      if (message?.kind === 'request' && message.method === 'estimate_run' && sessionStorage.getItem('estimate-unpriced')) {
        const result = { calls: 1, cost_usd: [0, 0], minutes: [1, 1], unpriced: ['old-judge'] };
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { kind: 'response', id: message.id, ok: true, result } })));
        return;
      }
      // A run started here keeps its real report.
      if (message?.kind !== 'request' || message.method !== 'get_report' || !['r-0001', 'r-0002'].includes(message.params.run_id)) {
        post.call(this, message, Array.isArray(options) ? { transfer: options } : options);
        return;
      }
      const variant = sessionStorage.getItem('report-variant');
      const result = variant === 'empty' ? { ...report, themes: [], frictions: [], set_aside: undefined } : variant === 'all-aside' ? { ...report, themes: [], frictions: [] } : variant === 'legacy' ? { ...report, themes: undefined } : report;
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
  assert.match(await summary.innerText(), /^The biggest problem in this run is “Users could not tell whether their job was published”, met by 4 of 6 personas who reached the page\./);
  assert.ok((await summary.boundingBox())!.y < (await root.getByRole('region', { name: 'At a glance' }).boundingBox())!.y, 'the summary sits above the glance');
  assert.equal(await first.locator('summary').getByText('Fix now', { exact: true }).count(), 1, 'the top finding carries its label');
  assert.match((await first.locator('summary').getByText('Fix now', { exact: true }).getAttribute('title'))!, /where to look first within this run/);
  await page.setViewportSize({ width: 1100, height: 1000 });
  await root.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-overview.png'), fullPage: true });
  // By priority is the default: a small crop beside each finding that has a picture, around its element.
  assert.equal(await page.getByRole('button', { name: 'By priority' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await root.locator('.report-finding-summary:visible .report-crop').count(), 4, 'a crop beside each finding on show that has a picture');
  assert.equal(await root.locator('.report-crop[aria-hidden="true"]').count(), 5, 'hidden from assistive technology');
  await first.locator('.report-crop img').waitFor();
  assert.equal(await root.locator('.report-screen').count(), 0, 'no screen cards until asked for');
  // By screen: one card per screen, the lead picture with numbered pins beside the findings, numbered within the card.
  await page.getByRole('button', { name: 'By screen' }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button', { name: 'By screen' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await root.locator('.report-finding-summary').first().isVisible(), true);
  assert.deepEqual(await root.locator('.report-screen > header h4').allInnerTexts(), ['/jobs', '/jobs/new', 'Across many screens', 'Not tied to one screen'], 'the most reached screen first, then the two groups');
  const newScreen = root.locator('.report-screen').filter({ hasText: '/jobs/new' }).first();
  assert.match(await newScreen.locator('header').innerText(), /3 findings[\s\S]*Blocker[\s\S]*4 personas reached it/);
  assert.deepEqual(await newScreen.locator('.report-finding-number').allInnerTexts(), ['01', '02', '03']);
  assert.equal(await newScreen.getByRole('heading', { level: 5 }).count(), 3, 'a finding is a heading under its screen');
  assert.deepEqual(await newScreen.locator('.report-shot-box b').allInnerTexts(), ['1, 3', '2'], 'findings on one element share a pin');
  await newScreen.locator('.report-screen-body > .report-shot img').waitFor();
  assert.equal(await newScreen.getByRole('img', { name: 'Marked 1 and 3 on the screenshot: button "Publish"' }).count(), 1);
  assert.equal(await newScreen.locator('.report-crop').count(), 0, 'a finding pinned on the lead needs no crop');
  assert.ok(await newScreen.locator('.report-finding-copy').first().getByText('What to improve', { exact: false }).isVisible(), 'each finding names its section');
  const jobsScreen = root.locator('.report-screen').first();
  assert.equal(await jobsScreen.locator('.report-crop').count(), 1, 'a finding off the lead keeps its crop; one whose picture is the lead needs none');
  const lead = (await newScreen.locator('.report-screen-body > .report-shot').boundingBox())!;
  assert.ok(lead.x + lead.width <= (await newScreen.locator('.report-finding').first().boundingBox())!.x, 'the picture sits left of the findings');
  await page.screenshot({ path: join(shots, 'report-by-screen.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'by screen at 320');
  assert.ok((await newScreen.locator('.report-screen-body > .report-shot').boundingBox())!.y < (await newScreen.locator('.report-finding').first().boundingBox())!.y, 'stacked on a narrow screen');
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.getByRole('button', { name: 'By priority' }).click();
  assert.equal(await root.locator('.report-screen').count(), 0);
  assert.equal(await root.locator('.report-finding-summary:visible').count(), 5, 'and back');
  const trigger = first.locator('summary');
  await trigger.focus();
  await page.keyboard.press('Enter');
  assert.ok(await first.getByText('Suggested change', { exact: true }).isVisible());
  assert.ok(await first.getByText('Behind this finding', { exact: true }).isVisible());
  assert.ok(await first.getByText('More common among personas with Seniority Lead: 4 of 6 with it, against 1 of 9 others', { exact: true }).isVisible(), 'a finding says who met it more often, with its counts');
  assert.ok(await first.locator('summary').getByText('possibly interference between personas', { exact: false }).isVisible(), 'the tag shows on the closed finding');
  assert.ok(await first.getByText('1 of 4 reports tagged possibly interference between personas: another persona changed', { exact: false }).isVisible(), 'and says why');
  assert.equal(await first.getByText(/^Tagged possibly interference between personas/).count(), 1, 'on the tagged evidence only');
  await first.getByRole('button', { name: friction.persona_name, exact: true }).first().click();
  await page.getByRole('dialog').waitFor();
  const simulated = 'Simulated red–green colour blindness: the colours here are not the page’s own.';
  await page.getByRole('dialog').getByText(simulated).first().waitFor();
  // The replay as a video, on real steps from the log: buttons, keys, the scrubber, playing, captions, full screen, a step with no screenshot and a phone's width.
  const replay = page.getByRole('dialog').getByRole('region', { name: 'Replay' });
  const info = replay.locator('.replay-info');
  const frames = replay.locator('.replay-frames');
  const stage = replay.locator('.replay-stage');
  const body = replay.locator('.replay-body');
  const previous = replay.getByRole('button', { name: 'Previous step', exact: true });
  const next = replay.getByRole('button', { name: 'Next step', exact: true });
  const play = replay.getByRole('button', { name: /^(Play|Pause|Play from the start)$/ });
  const scrubber = replay.getByRole('slider', { name: 'Step', exact: true });
  // Opened from evidence, the inspector shows that step of the timeline, so the link is the way up to the replay.
  await page.getByRole('navigation', { name: 'Persona sections' }).getByRole('button', { name: 'Replay' }).click();
  assert.equal(await replay.evaluate((section) => section === document.activeElement), true, 'the link hands the keys to the replay');
  const atStep = async (n: number) => {
    await replay.getByText(`${n} / 4`, { exact: true }).waitFor();
    assert.equal(await frames.locator(':scope > *').count(), n === 1 || n === 4 ? 2 : 3, `only step ${n} and its neighbours are in the page`);
    assert.match(await replay.locator('[aria-live]').textContent() ?? '', new RegExp(`^Step ${n}: `), 'one live node, with no total for a new step to change');
  };
  // Opened at a step of the timeline, the replay starts at that step too.
  const opened = Number(/step (\d+)/i.exec(await page.getByRole('dialog').locator('.inspector-timeline li.ring-2').innerText())![1]);
  await atStep(opened);
  for (let n = opened; n > 1; n--) await page.keyboard.press('ArrowLeft');
  await atStep(1);
  assert.equal(await replay.locator('[aria-live]').textContent(), 'Step 1: Clicked button "Next"');
  assert.ok(await info.getByText('Clicked button "Next"', { exact: true }).isVisible(), 'the action');
  assert.ok(await info.getByText('http://gym.test/poi-gym', { exact: true }).isVisible(), 'the page');
  assert.ok(await info.getByText('Feeling neutral', { exact: false }).isVisible(), 'how the persona felt');
  assert.ok(await info.getByText(simulated, { exact: true }).isVisible(), 'a screenshot of simulated vision says so here too');
  assert.ok((await replay.locator('.replay-caption').innerText()).endsWith('Looking for the next step.'), 'the thought is the caption');
  const shown = frames.locator('img:visible');
  await shown.waitFor();
  await page.waitForFunction((image) => (image as HTMLImageElement).naturalWidth > 0, await shown.elementHandle());
  const [screen, words] = [(await stage.boundingBox())!, (await info.boundingBox())!];
  assert.ok(words.y >= screen.y + screen.height, 'the details sit under the picture in the inspector');
  await page.screenshot({ path: join(shots, 'replay.png') });
  assert.equal(await previous.getAttribute('aria-disabled'), 'true');
  await previous.click({ force: true });
  await atStep(1);
  await next.click();
  await atStep(2);
  await replay.focus();
  await page.keyboard.press('ArrowRight');
  await atStep(3);
  assert.ok(await frames.getByText('No screenshot for this step.').isVisible(), 'a step with no screenshot says so');
  assert.equal(await frames.locator('img:visible').count(), 0, 'and shows no neighbour');
  assert.equal(await info.getByText(simulated, { exact: true }).count(), 0, 'with no screenshot there is nothing to label');
  await page.keyboard.press('ArrowRight');
  await atStep(4);
  await frames.getByText('The screenshot could not be loaded.').waitFor();
  await page.keyboard.press('ArrowRight');
  await atStep(4);
  await page.keyboard.press('ArrowLeft');
  await atStep(3);
  await page.keyboard.press('ArrowLeft');
  await atStep(2);
  await previous.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await atStep(1);
  assert.equal(await previous.evaluate((button) => button === document.activeElement), true, 'reaching the first step leaves focus on the button');
  await page.keyboard.press('ArrowRight');
  await atStep(2);
  // The scrubber moves one step per key, and this later build met no friction, so it marks nothing.
  await scrubber.focus();
  await page.keyboard.press('End');
  await atStep(4);
  await page.keyboard.press('ArrowLeft');
  await atStep(3);
  await page.keyboard.press('Home');
  await atStep(1);
  assert.equal(await replay.locator('.replay-mark').count(), 0);
  // Playing steps on by itself and pauses; from the last step it starts over.
  await page.keyboard.press('End');
  await atStep(4);
  assert.equal(await play.getAttribute('aria-label'), 'Play from the start');
  await play.click();
  await atStep(1);
  assert.equal(await play.getAttribute('aria-label'), 'Pause');
  await atStep(2);
  await page.keyboard.press('Space'); // on the focused button: a key acts at once, where a click first waits for the page to settle
  assert.equal(await play.getAttribute('aria-label'), 'Play');
  const paused = await replay.locator('.replay-count').innerText();
  await page.waitForTimeout(3_500);
  assert.equal(await replay.locator('.replay-count').innerText(), paused, 'paused, it stays put');
  // Captions off: the thought moves to the details.
  const cc = replay.getByRole('button', { name: 'CC captions', exact: true });
  await cc.click();
  assert.equal(await cc.getAttribute('aria-pressed'), 'false');
  assert.equal(await replay.locator('.replay-caption').count(), 0);
  assert.ok(await info.getByText('“Looking for the next step.”', { exact: true }).isVisible(), 'the thought is in the details instead');
  await cc.click();
  // A click on the picture fills the window, the details beside it; Esc leaves full screen, not the inspector, and so does a second click.
  await stage.click();
  assert.deepEqual(await body.boundingBox(), { x: 0, y: 0, width: 1100, height: 1000 }, 'over the whole window');
  const [big, beside] = [(await stage.boundingBox())!, (await info.boundingBox())!];
  assert.ok(beside.x >= big.x + big.width && big.width > 600, 'a big picture with the details beside it');
  await page.screenshot({ path: join(shots, 'replay-full.png') });
  await page.keyboard.press('Escape');
  await replay.locator('.replay-body:not([data-full])').waitFor();
  assert.ok(await replay.isVisible(), 'the inspector stays open');
  await replay.getByRole('button', { name: 'Full screen', exact: true }).click();
  await replay.locator('.replay-body[data-full]').waitFor();
  await stage.click();
  await replay.locator('.replay-body:not([data-full])').waitFor();
  await page.setViewportSize({ width: 320, height: 800 });
  await assertFits(page, 'the replay fits a narrow viewport');
  assert.ok(await replay.evaluate((section) => section.scrollWidth <= section.clientWidth), 'nothing in the replay runs wide at 320 px');
  assert.ok(await page.locator('.inspector-jump-links').evaluate((links) => links.scrollWidth <= links.clientWidth), 'the section links still fit at 320 px');
  await replay.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'replay-320.png') });
  await replay.getByRole('button', { name: 'Full screen', exact: true }).click();
  await assertFits(page, 'full screen fits a narrow viewport');
  const [narrow, under] = [(await stage.boundingBox())!, (await info.boundingBox())!];
  assert.ok(under.y >= narrow.y + narrow.height, 'narrow, the details sit under the picture');
  await page.screenshot({ path: join(shots, 'replay-full-320.png') });
  await page.keyboard.press('Escape');
  await replay.locator('.replay-body:not([data-full])').waitFor();
  await page.setViewportSize({ width: 1100, height: 1000 });
  // Scrolling the panel far past its end leaves the report behind it where it was.
  const behind = await page.evaluate(() => scrollY);
  await page.mouse.move(900, 600);
  await page.mouse.wheel(0, 20_000);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => scrollY), behind, 'the report behind the panel stays put');
  await replay.focus();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const images = first.locator('.report-shot img');
  await first.locator('.report-shot').last().scrollIntoViewIfNeeded(); // screenshots load as they come near the viewport
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
  for (const title of ['Individual observations', 'Reasons for hesitation', 'Set aside by the evidence check', 'Where personas went', 'Audience breakdown', 'User journeys', 'Run details & methodology']) {
    const fold = root.locator('.report-fold').filter({ has: page.locator('summary h3').filter({ hasText: title }) });
    await fold.locator(':scope > summary').click();
    assert.ok(await fold.locator(':scope > .report-fold-body').isVisible(), title);
  }
  const aside = root.locator('.report-fold').filter({ has: page.locator('summary h3').filter({ hasText: 'Set aside by the evidence check (1)' }) });
  assert.ok(await aside.getByText("points to a persona's mistake: The persona entered its own name, so the form was right to refuse it.").isVisible(), 'each theme keeps its reason');
  assert.equal(await root.locator('.report-finding').getByText('A persona typed its own name').count(), 0, 'a set-aside theme is not ranked');
  const hesitations = root.locator('.report-fold').filter({ has: page.locator('summary h3').filter({ hasText: 'Reasons for hesitation' }) });
  assert.deepEqual(await hesitations.locator('.report-finding-summary .tone-chip').allInnerTexts(), ['Moderate'], 'an objection has a severity and no priority');
  const singles = root.locator('.report-fold').filter({ has: page.locator('summary h3').filter({ hasText: 'Individual observations' }) });
  assert.equal(await singles.locator('.report-finding-summary').getByText('Later', { exact: true }).count(), 2, 'one self-report and the scan\'s finding wait');
  const scanned = singles.locator('.report-finding').filter({ hasText: 'color contrast' });
  assert.ok(await scanned.locator('summary').getByText('Found by the accessibility scan', { exact: true }).isVisible());
  await scanned.locator('summary').click();
  assert.ok(await scanned.getByText('It sits on the step of whichever persona reached that page first', { exact: false }).isVisible());
  assert.ok(await scanned.getByText('color-contrast, serious, 12 elements: main:nth-child(2)', { exact: false }).isVisible());
  assert.equal(await scanned.getByText(/\d+ of \d+ persona|simulated users? experienced|Met it first-hand|None first-hand/).count(), 0, 'nothing reads as how many personas met it');
  assert.ok(await root.getByText('An audit, not findings: the moderate and minor rules the page scan flagged', { exact: false }).isVisible());
  assert.ok(await root.getByText('Grounded personas are still fictional, and their findings are still hypotheses.', { exact: true }).isVisible(), 'the methods say what grounding does not change');
  assert.ok(await root.getByText(/: 2 sources \(a-very-long-file-name/).isVisible());
  assert.ok(await root.getByText('Recorded cost', { exact: true }).isVisible());
  const coverage = root.getByText('With 6 personas the curve is too short to read.', { exact: true });
  assert.ok(await coverage.isVisible(), 'the methods say how far to read the curve');
  assert.ok(await root.getByText(/^New problems per persona, in the order they began: /).isVisible());
  assert.ok(await root.getByText(/^Barely tested, reached by fewer than 3 personas: .*summary-2 \(1\)/).isVisible());
  assert.ok(await root.getByText(/^"More common among" compares the simulated personas/).isVisible());
  const graph = root.getByRole('img', { name: /^Moves of 6 personas between 8 pages/ });
  assert.ok(await graph.isVisible());
  assert.equal(await graph.locator('.report-flow-move').count(), 9);
  assert.ok(await root.getByText('3 less visited pages left out, where 1 persona ended.').isVisible());
  assert.equal(await root.locator('section:has(> details .report-flow) table tbody tr').count(), 8, 'the table has every page the graph has');
  assert.ok(await root.getByRole('cell', { name: '3: 2 reached the goal, 1 got stuck' }).isVisible());
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'all details fit a narrow viewport');
  await scanned.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-scan-320.png') });
  assert.ok(await scanned.evaluate((finding) => finding.scrollWidth <= finding.clientWidth), 'a long element path wraps at 320 px');
  await coverage.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-coverage-320.png') });
  // A classic scrollbar on any machine, as Windows, Linux and a Mac with a mouse have: an overlay one leaves the graph 15 px that those do not.
  await page.evaluate(() => { const bar = new CSSStyleSheet(); bar.replaceSync('::-webkit-scrollbar { width: 15px }'); document.adoptedStyleSheets.push(bar); });
  assert.equal(await page.evaluate(() => innerWidth - document.documentElement.clientWidth), 15, 'the scrollbar takes its width');
  await graph.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-flow-320.png') });
  const overrun = await graph.evaluate((svg) => {
    const width = svg.getBoundingClientRect().width;
    return [...svg.querySelectorAll('text, rect')].filter((part) => { const { x, width: wide } = (part as SVGGraphicsElement).getBBox(); return x + wide > width; }).map((part) => part.textContent);
  });
  assert.deepEqual(overrun, [], 'nothing in the graph is cut off at 320 px');
  await page.setViewportSize({ width: 1100, height: 1000 });
  await assertFits(page, 'all details fit at desktop width');
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
  // By screen in the file: each lead picture once, every line a link to a card on the page, and neither the switch nor a crop.
  const screens = file.locator('section:has(> div > div > h3#screens-title)');
  assert.equal(await screens.locator('.report-screen').count(), 4);
  assert.equal(await screens.locator('.report-shot img').count(), 2, 'one lead picture for each screen that has one');
  for (const href of await screens.locator('li > a').evaluateAll((links) => links.map((link) => link.getAttribute('href')!))) assert.equal(await file.locator(href).count(), 1, `${href} is a card`);
  assert.equal(await file.locator('.report-crop, .segmented-control').count(), 0);
  assert.ok(await file.getByText('A persona typed its own name as the hiring manager').isVisible(), 'the export keeps what was set aside');
  assert.ok(await file.getByText("Your team's study, 12 Oct 2026: supported", { exact: true }).isVisible(), 'the export says whose the outcome is');
  assert.ok(await file.getByText('Post a job for a new role and make it live.', { exact: true }).isVisible(), 'and carries the plan');
  assert.equal(await file.getByRole('button').count(), 0, 'with no controls');
  assert.equal(await file.getByText('Edits with no matching finding').count(), 0, 'an edit with no finding is for the team, not the file');
  await file.close();
  await page.setViewportSize({ width: 320, height: 1000 });
  // The team's own study, apart from the simulated numbers, at both widths.
  const study = root.getByRole('region', { name: 'Check with real people' });
  assert.ok(await first.locator('summary').getByText("Your team's study, 12 Oct 2026: supported", { exact: true }).isVisible(), 'the outcome sits beside the finding, attributed');
  assert.ok(await study.getByText("Of the top 5 findings, your team's studies supported 1, and 4 are not studied yet.", { exact: true }).isVisible());
  assert.ok(await study.getByText('A finding the judge has since merged away', { exact: true }).isVisible(), 'an outcome with no finding is shown, not dropped');
  assert.ok(await study.getByText('Do not show them to participants', { exact: false }).isVisible());
  assert.ok(await study.getByText('No task is left for this hypothesis', { exact: false }).isVisible());
  assert.ok(await study.getByText('2 drafts left out because they repeated a finding\'s words.', { exact: true }).isVisible());
  assert.ok(await study.getByText(/^Left out of this plan: 2 lower-ranked findings; 1 objection; 1 set aside by the evidence check; 1 found by the accessibility scan alone/).isVisible());
  assert.match(await study.getByRole('button', { name: 'Plan again' }).locator('..').innerText(), /costs at most \$0\.\d{4}/, 'the control says the most it can cost');
  const orphans = root.getByRole('region', { name: 'Edits with no matching finding' });
  assert.ok(await orphans.getByText('A hidden finding the judge has since merged away', { exact: true }).isVisible(), 'an edit with no finding is shown, not dropped');
  assert.ok(await orphans.getByText('is back in exports', { exact: false }).isVisible(), 'and the app says what that means');
  assert.ok(await orphans.getByText('Was reworded: Words nobody needs now', { exact: true }).isVisible());
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'the study section fits a narrow viewport');
  await study.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-study-320.png') });
  await page.setViewportSize({ width: 1100, height: 1000 });
  for (const [variant, message] of [['empty', 'No shared issues were reported in this run.'], ['all-aside', 'No shared issues are left. What the evidence check set aside is below.'], ['legacy', friction.what]]) {
    await page.evaluate((value) => sessionStorage.setItem('report-variant', value), variant);
    await page.reload();
    await openReport();
    assert.ok(await root.getByText(message, { exact: true }).first().isVisible());
    assert.equal(await root.getByRole('region', { name: 'Summary' }).count(), variant === 'legacy' ? 0 : 1, 'a report without themes has nothing to summarise');
    await assertFits(page, `${variant} report fits a narrow viewport`);
  }
  // Compare, reached from the run history: the real engine call, on the real reports of the two seeded runs.
  await page.evaluate(() => sessionStorage.removeItem('report-variant'));
  await page.reload();
  await page.getByRole('heading', { name: 'What to test', exact: true }).waitFor();
  await page.setViewportSize({ width: 1100, height: 1000 });

  // The pre-run summary's repeat count, against the real estimate.
  await page.locator('#tab-review').click();
  const review = page.locator('#panel-review');
  const repeatCount = review.getByLabel('Repeat runs');
  await repeatCount.waitFor();
  assert.equal(await repeatCount.inputValue(), '1');
  assert.equal(await review.getByText('runs of this audience', { exact: false }).count(), 0, 'one run has nothing to explain');
  await repeatCount.fill('3');
  await review.getByText('3 runs of this audience, one after another, each with its own report and $1.67 of the cost limit.', { exact: false }).waitFor();
  assert.ok(await review.getByText('Each finding then shows how many runs it appeared in.', { exact: false }).isVisible());
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'the repeat count fits a narrow viewport');
  await repeatCount.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'review-repeats-320.png') });
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
  const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim());
  await page.waitForFunction(() => document.activeElement?.tagName === 'H2');
  assert.equal(await focused(), `${config.run_id} to r-0002`, 'focus moves to the view that replaced the button');
  assert.ok(await compare.getByText('means the later run did not show a problem, not that it is fixed', { exact: false }).isVisible(), 'the notice leads the view');
  assert.ok(await compare.getByRole('heading', { name: /^Not seen again/ }).isVisible());
  assert.ok(await compare.getByText(/was in 1 of 1 run, not seen in 1 of 1, 6 personas reached its page\./).first().isVisible());
  assert.equal(await compare.getByText(/^Fixed\b/).count(), 0, 'nothing on the screen calls a problem fixed');
  const table = compare.getByRole('region', { name: 'By segment' });
  await table.focus();
  assert.equal(await table.evaluate((box) => box === document.activeElement), true, 'the keyboard can reach a table that scrolls');
  for (const width of [1440, 768, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await assertFits(page, `compare overflow at ${width}`);
    assert.ok(await compare.locator('.report-finding-copy h4').first().evaluate((title) => title.getBoundingClientRect().width > 200), `a theme keeps its width at ${width}`);
    await page.screenshot({ path: join(shots, `compare-${width}.png`), fullPage: true });
  }
  await history.getByRole('button', { name: 'Back to past runs' }).click();
  await history.getByLabel('Earlier run').waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Compare');

  // Run again: refused by the engine with its reason, then a real rerun on another address.
  await page.getByRole('button', { name: 'r-0002', exact: false }).first().click();
  await page.getByRole('button', { name: 'Run again', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Run again' });
  await dialog.getByText(/^About \$/).waitFor();
  await assertFits(page, 'the dialog fits a narrow viewport');
  await page.screenshot({ path: join(shots, 'run-again-320.png') });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.evaluate(() => sessionStorage.setItem('estimate-unpriced', '1'));
  await page.getByRole('button', { name: 'Run again', exact: true }).click();
  await dialog.getByText('No price is known for old-judge.', { exact: false }).waitFor();
  assert.ok(await dialog.getByRole('button', { name: 'Start run' }).isDisabled(), 'a model with no price stops the run, as on the Review step');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.evaluate(() => sessionStorage.removeItem('estimate-unpriced'));
  await page.getByRole('button', { name: 'Run again', exact: true }).click();
  await dialog.getByText(/^About \$/).waitFor();
  const address = dialog.getByLabel(/^Address of/);
  await address.fill('not a web address');
  await dialog.getByRole('button', { name: 'Start run' }).click();
  await dialog.getByText('is not a web address Gnomi can open', { exact: false }).waitFor();
  await address.fill(`${gym.url}/`);
  await dialog.getByLabel('Repeat runs').fill('2');
  await dialog.getByText('shared across 2 runs', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Start run' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.locator('.run-history-context code').getByText('r-0003', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1100, height: 1000 });
  // The set's real reports, compared by the engine: both runs finish and each finding says how it did across them.
  await root.getByText('Run 1 of 2 in a repeat set. 2 runs compared.', { exact: false }).waitFor({ timeout: 120_000 });
  const repeatsLine = root.locator('.report-finding-summary').getByText('Appeared in 2 of 2 runs', { exact: false }).first();
  await repeatsLine.waitFor();
  await repeatsLine.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'repeat-set.png') });
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'the repeat line fits a narrow viewport');
  // A plan and an outcome on the run's real report: each only on a click, each reloading the report through report.generated.
  const logOf = () => { const log = openProject(projectDir); try { return log.events('r-0003'); } finally { log.close(); } };
  assert.equal(logOf().filter((event) => event.type === 'report.study').length, 0, 'opening the report spends nothing');
  const callsBefore = logOf().filter((event) => event.type === 'llm.call').length;
  const planButton = root.getByRole('button', { name: 'Plan a study', exact: true });
  await root.getByText(/costs at most \$/).waitFor();
  await planButton.click();
  await root.getByRole('status').getByText('Study plan written above.', { exact: true }).waitFor(); // what a screen reader hears after the wait
  await root.getByRole('heading', { name: /^Hypothesis 1: / }).waitFor();
  await root.getByRole('button', { name: 'Plan again' }).waitFor();
  assert.equal(logOf().filter((event) => event.type === 'llm.call').length, callsBefore + 1, 'one model call');
  await page.setViewportSize({ width: 1100, height: 1000 });
  await root.getByRole('button', { name: 'Copy the plan' }).click();
  await root.getByText('Study plan copied.').waitFor();
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /^# Study plan: [\s\S]*Do not show them to participants/);
  await root.getByRole('button', { name: 'Export the plan' }).click();
  await root.getByText(/^Study plan exported to/).waitFor();
  assert.match(readFileSync(exportedFile, 'utf8'), /^# Study plan: /);
  assert.match(readFileSync(join(projectDir, 'runs/r-0003/study-plan.md'), 'utf8'), /Do not show them to participants/);
  const studied = root.locator('.report-finding').first();
  await studied.locator('summary').first().click();
  await studied.getByRole('button', { name: 'Record a study outcome' }).click();
  await studied.getByLabel('What your study found').selectOption('contradicted');
  await studied.getByLabel('Study date').fill('2026-10-02');
  await studied.getByLabel('Note, optional').fill('Everyone finished the task.');
  assert.ok(await studied.getByText('Leave out names and contact details', { exact: false }).isVisible(), 'the form warns where a note goes');
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'the outcome form fits a narrow viewport');
  await studied.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-outcome-320.png') });
  await studied.getByRole('button', { name: 'Save study outcome' }).click();
  await studied.locator('summary').first().getByText("Your team's study, 2 Oct 2026: contradicted", { exact: true }).waitFor();
  await studied.getByText('Everyone finished the task.', { exact: true }).waitFor();
  await root.getByRole('region', { name: 'Check with real people' }).getByText(/^Of the top \d findings?, your team's studies contradicted 1/).waitFor();
  assert.equal(logOf().filter((event) => event.type === 'llm.call').length, callsBefore + 1, 'recording an outcome makes no model call');
  assert.match(readFileSync(join(projectDir, 'runs/r-0003/report.md'), 'utf8'), /Your team's study, 2 Oct 2026: contradicted/);
  await assertFits(page, 'the recorded outcome fits a narrow viewport');
  // An edit for sharing on the run's real report: the original stays on screen, each edit reloads it, and only the exported file changes.
  const original = await studied.locator('h4').first().innerText();
  const exported = async () => {
    rmSync(exportedFile, { force: true });
    await page.getByRole('button', { name: 'Export report' }).click();
    while (!existsSync(exportedFile)) await page.waitForTimeout(50);
    await page.getByText(/^Report exported to/).waitFor();
    return readFileSync(exportedFile, 'utf8');
  };
  await studied.getByRole('button', { name: 'Reword for sharing' }).click();
  await studied.getByLabel('Title for exports').fill('Our words for this finding');
  await assertFits(page, 'the wording form fits a narrow viewport');
  await studied.getByLabel('Title for exports').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-edit-320.png') });
  await studied.getByRole('button', { name: 'Save wording' }).click();
  await studied.locator('summary').first().getByText('Reworded for exports', { exact: true }).waitFor();
  await studied.getByText('Our words for this finding', { exact: true }).waitFor();
  assert.equal(await studied.locator('h4').first().innerText(), original, 'the original stays in place');
  assert.ok(await studied.getByText('As the run found it', { exact: true }).isVisible(), 'and shows beside the new words');
  await assertFits(page, 'the two wordings fit a narrow viewport');
  await page.setViewportSize({ width: 1100, height: 1000 });
  const columns = await studied.locator('.report-edit-compare > div').evaluateAll((sides) => sides.map((side) => side.getBoundingClientRect().top));
  assert.equal(columns[0], columns[1], 'side by side at desktop width');
  await page.getByLabel('Export format').selectOption('md');
  const reworded = await exported();
  assert.match(reworded, /hid 0 findings from this copy and reworded 1 finding/);
  assert.match(reworded, /Our words for this finding\n\nReworded by the team\./);
  assert.ok(!reworded.includes(original), 'the file has the new words');
  await studied.getByRole('button', { name: 'Hide from exports' }).click();
  await studied.locator('summary').first().getByText('Hidden from exports', { exact: true }).waitFor();
  assert.equal(await studied.locator('h4').first().innerText(), original, 'a hidden finding stays in place');
  await studied.scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'a hidden finding fits a narrow viewport');
  await page.screenshot({ path: join(shots, 'report-hidden-320.png') });
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.getByLabel('Export format').selectOption('html');
  const hiddenHtml = await exported();
  assert.ok(hiddenHtml.includes('hid 1 finding from this copy and reworded 0 findings') && !hiddenHtml.includes(original) && !hiddenHtml.includes('Our words for this finding'), 'no export has it');
  assert.doesNotMatch(hiddenHtml, /<button/, 'and no control reaches a file');
  assert.ok(readFileSync(join(projectDir, 'runs/r-0003/report.md'), 'utf8').includes(original), 'report.md stays the run\'s record');
  await page.getByLabel('Export format').selectOption('json');
  assert.deepEqual(JSON.parse(await exported()).shared, { hidden: 1, reworded: 0 });
  await studied.getByRole('button', { name: 'Show in exports' }).click();
  await studied.locator('summary').first().getByText('Reworded for exports', { exact: true }).waitFor();
  assert.equal(logOf().filter((event) => event.type === 'llm.call').length, callsBefore + 1, 'an edit makes no model call');
  // A question to a persona on the run's real log, as a chat: only on a send, labelled, and reaching no report or file.
  const generated = 'Generated after the run. This is a new answer from the model, not a memory of why this persona acted.';
  const persona = studied.getByRole('list', { name: /^Evidence for/ }).getByRole('button').first();
  const askedName = await persona.innerText();
  await persona.click();
  // A real run's replay opens at the evidence's step, marks where the persona met friction and gave up, and says what happened at each.
  const real = page.getByRole('dialog').getByRole('region', { name: 'Replay' });
  const evidenceStep = Number(/step (\d+)/i.exec(await page.getByRole('dialog').locator('.inspector-timeline li.ring-2').innerText())![1]);
  await real.getByText(new RegExp(`^${evidenceStep} / \\d+$`)).waitFor();
  assert.deepEqual(await real.locator('.replay-mark').evaluateAll((marks) => marks.map((mark) => mark.getAttribute('data-kind'))), ['friction', 'gave-up']);
  await real.getByRole('slider', { name: 'Step', exact: true }).focus();
  await page.keyboard.press('End');
  await real.locator('.replay-info').getByText('Gave up:', { exact: true }).waitFor();
  assert.ok(await real.locator('.replay-flags').getByText('Gave up', { exact: true }).isVisible(), 'the picture is flagged');
  await page.keyboard.press('ArrowLeft');
  await real.locator('.replay-info').getByText(/^Friction, severity \d of 4:$/).waitFor();
  assert.ok(await real.locator('.replay-flags').getByText('Friction', { exact: true }).isVisible());
  await real.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'replay-real.png') });
  const asked = page.getByRole('dialog').getByRole('region', { name: 'Questions after the run' });
  const box = asked.getByLabel(`Ask ${askedName} about this run`);
  const send = asked.getByRole('button', { name: 'Send', exact: true });
  await page.getByRole('navigation', { name: 'Persona sections' }).getByRole('button', { name: 'Ask', exact: true }).click();
  assert.equal(await box.evaluate((field) => field === document.activeElement), true, 'Ask lands in the chat box');
  await asked.getByText(/costs at most \$/).waitFor();
  assert.ok(await asked.getByText(generated, { exact: false }).isVisible(), 'the chat opens with the label');
  assert.equal(await send.isDisabled(), true, 'nothing to send yet');
  assert.equal(logOf().filter((event) => event.type === 'llm.call').length, callsBefore + 1, 'opening a persona spends nothing');
  await asked.getByRole('button', { name: 'What was hardest for you?', exact: true }).click();
  assert.equal(await box.inputValue(), 'What was hardest for you?', 'an idea fills the box');
  assert.equal(logOf().filter((event) => event.type === 'llm.call').length, callsBefore + 1, 'and sends nothing');
  await box.fill('Why did you stop?');
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'the chat fits a narrow viewport');
  await asked.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-ask-320.png') });
  await box.press('Enter');
  await asked.getByText(/Scripted demo answer: /).waitFor();
  assert.equal(await box.inputValue(), '', 'Enter sends, and the box empties');
  await box.fill('And what would you change?');
  await send.click();
  await asked.getByText(/Scripted demo answer: /).nth(1).waitFor();
  const thread = await asked.getByRole('log', { name: `Conversation with ${askedName}` }).innerText();
  assert.ok(thread.indexOf('Why did you stop?') < thread.indexOf('And what would you change?'), 'oldest first, as in a chat');
  assert.equal(await asked.getByText('Generated after the run', { exact: true }).count(), 2, 'every answer is marked');
  await assertFits(page, 'the answers fit a narrow viewport');
  await asked.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-answers-320.png') });
  await page.setViewportSize({ width: 1100, height: 1000 });
  await assertFits(page, 'the answers fit at desktop width');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  // The report's own chats: everyone in the run, the latest conversation first, the same answers as the inspector's.
  const chats = root.getByRole('region', { name: 'Ask the personas' });
  const people = chats.getByRole('list', { name: 'Personas' });
  const latest = await people.getByRole('button').first().innerText();
  assert.ok(latest.includes(askedName) && latest.includes('Scripted demo answer'), 'the latest conversation leads the list');
  await chats.getByLabel('Search personas').fill('nobody by this name');
  await chats.getByText('No one matches “nobody by this name”.', { exact: true }).waitFor();
  await chats.getByLabel('Search personas').fill('');
  await people.getByRole('button').first().click();
  const chat = chats.getByRole('log', { name: `Conversation with ${askedName}` });
  assert.equal(await chat.getByText(/Scripted demo answer: /).count(), 2, 'the inspector’s answers are here too');
  const reportBox = chats.getByLabel(`Ask ${askedName} about this run`);
  assert.equal(await reportBox.evaluate((field) => field === document.activeElement), true, 'opening a chat lands in its box');
  await page.evaluate(() => sessionStorage.setItem('ask-fails', '1'));
  await reportBox.fill('What did you look for first?');
  await reportBox.press('Enter');
  await chat.getByText('The model did not answer in time.', { exact: true }).waitFor();
  assert.ok(await chat.getByText('Not answered', { exact: true }).isVisible(), 'a refused question stays, marked');
  await chat.getByRole('button', { name: 'Try again', exact: true }).click();
  await chat.getByText(/Scripted demo answer: /).nth(2).waitFor();
  assert.equal(await chat.getByText('Not answered', { exact: true }).count(), 0, 'and goes once it is answered');
  assert.equal(await chat.getByText('What did you look for first?').count(), 1, 'with no second copy'); // not exact: a screen reader's "You asked: " leads it
  // The name opens the profile, which can start the replay inside the chat, and a step of it becomes a question.
  await chats.locator('.chat-header').getByRole('button', { name: `${askedName}'s profile`, exact: true }).click();
  const card = page.getByRole('dialog', { name: `${askedName}'s profile` });
  await card.waitFor();
  assert.ok(await card.getByText('Gave up', { exact: true }).isVisible(), 'with how the run went');
  await page.screenshot({ path: join(shots, 'report-chat-profile.png') });
  await card.getByRole('button', { name: 'Watch replay', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  const video = chat.getByRole('region', { name: 'Replay' });
  await video.waitFor();
  await video.getByRole('button', { name: 'Ask about this step', exact: true }).click();
  assert.match(await reportBox.inputValue(), /^About step \d+, when you /, 'a step of the replay becomes a question');
  assert.equal(await reportBox.evaluate((field) => field === document.activeElement), true, 'ready to send');
  await reportBox.fill('');
  await chats.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-chat.png') });
  // Someone not asked yet gets question ideas from their own run.
  await people.getByRole('button').nth(1).click();
  const ideas = chats.getByRole('group', { name: 'Question ideas' });
  assert.ok(await ideas.getByRole('button', { name: 'Why did you give up?', exact: true }).isVisible(), 'from how it ended');
  assert.ok(await ideas.getByRole('button', { name: /^At step \d+ you reported “/ }).isVisible(), 'and from the worst friction');
  assert.ok(await chats.getByRole('button', { name: /^Session replay/ }).isVisible(), 'and the session waits as a video message');
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'the report chat fits a narrow viewport');
  assert.equal(await people.isVisible(), false, 'a narrow page shows the chat alone');
  await chats.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-chat-320.png') });
  await chats.getByRole('button', { name: 'All personas', exact: true }).click();
  await people.waitFor();
  await page.setViewportSize({ width: 1100, height: 1000 });
  assert.equal(logOf().filter((event) => event.type === 'llm.call').length, callsBefore + 4, 'one call per question');
  assert.equal(logOf().filter((event) => event.type === 'persona.interviewed').length, 3);
  const leftOut = await exported();
  assert.ok(!leftOut.includes('Why did you stop?') && !leftOut.includes('Scripted demo answer') && !leftOut.includes('Ask the personas'), 'no export has an interview');
  assert.ok(!readFileSync(join(projectDir, 'runs/r-0003/report.md'), 'utf8').includes('Why did you stop?'), 'and report.md has none');
  await page.setViewportSize({ width: 320, height: 1000 });
  const rerun = openProject(projectDir);
  const scans = rerun.events('r-0003', { types: ['accessibility.scanned'] });
  rerun.close();
  assert.ok(scans.length > 0 && scans.every((scan) => scan.type === 'accessibility.scanned' && scan.payload.error === null), `axe-core loads and runs in the built host: ${JSON.stringify(scans[0]?.payload)}`);

  // A set with a trait-free run, seeded: only `gnomi run` starts one. The real engine compares its reports.
  for (const index of [1, 2, 3]) seedFinishedRun(projectDir, { ...synthetic, repeat: { group: 'trait-free', index, of: 3, trait_free: 3 } }, events);
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.reload();
  await openReport();
  await root.getByText('Run 3 of 3 in a repeat set, of personas with no traits. 2 runs compared.', { exact: false }).waitFor();
  await page.locator('#tab-runs').click();
  await page.getByRole('button', { name: 'r-0005', exact: false }).first().click();
  await root.getByText('Run 1 of 3 in a repeat set. 2 runs compared.', { exact: false }).waitFor();
  assert.ok(await root.getByText('One more run, of personas with no traits, is in no count here.', { exact: false }).isVisible());
  const traitFreeLine = root.locator('.report-finding-summary').getByText('Personas with no traits hit this too, so it may say more about the model than this audience', { exact: false }).first();
  await traitFreeLine.waitFor();
  await traitFreeLine.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'trait-free.png') });
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'the trait-free note fits a narrow viewport');
  await traitFreeLine.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'trait-free-320.png') });

  // Returning personas: never the default, at 320 px too, and a real report that says what its personas knew and what they only repeated.
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.locator('#tab-runs').click();
  await page.getByRole('button', { name: 'r-0003', exact: false }).first().click();
  await page.getByRole('button', { name: 'Run again', exact: true }).click();
  await dialog.getByText(/^About \$/).waitFor();
  const remember = dialog.getByLabel('Personas remember r-0003, though prior knowledge can hide first-use problems');
  assert.equal(await remember.isChecked(), false, 'never the default');
  await assertFits(page, 'the returning option fits a wide viewport');
  await page.setViewportSize({ width: 320, height: 1000 });
  await remember.check();
  await dialog.getByText(/^About \$/).waitFor();
  await assertFits(page, 'the returning option fits a narrow viewport');
  await page.screenshot({ path: join(shots, 'run-again-returning-320.png') });
  await dialog.getByRole('button', { name: 'Start run' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.locator('.run-history-context code').getByText('r-0008', { exact: true }).waitFor();
  const returningNotice = root.locator('.report-header').getByText('These personas used the product before, in r-0003, so this run says little about first use.', { exact: true });
  await returningNotice.waitFor({ timeout: 120_000 });
  await assertFits(page, 'the returning notice fits a narrow viewport');
  await returningNotice.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-returning-320.png') });
  // Scripted personas only repeat themselves, so every finding here has nobody first-hand and waits with the individual observations.
  const remembered = root.locator('.report-fold').filter({ has: page.locator('summary h3').filter({ hasText: 'Individual observations' }) });
  await remembered.locator(':scope > summary').click();
  await remembered.locator('.report-finding summary').first().click();
  await remembered.getByText('more after remembering it from an earlier visit', { exact: false }).first().waitFor();
  await assertFits(page, 'the remembered count fits a narrow viewport');
  const methodsFold = root.locator('.report-fold').filter({ has: page.locator('summary h3').filter({ hasText: 'Run details & methodology' }) });
  await methodsFold.locator(':scope > summary').click();
  await methodsFold.getByText('Earlier visit', { exact: true }).waitFor();
  assert.ok(await methodsFold.locator('dd').getByText('in r-0003', { exact: false }).isVisible(), 'the methods name the base run');
  await assertFits(page, 'the methods row fits a narrow viewport');
  await page.setViewportSize({ width: 1100, height: 1000 });
  await assertFits(page, 'the returning report fits a wide viewport');
  await returningNotice.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'report-returning.png') });
  const returned = openProject(projectDir);
  const frozen = returned.listRuns().find((run) => run.run_id === 'r-0008')!.config.prior!;
  const prompts = returned.transcripts('r-0008').map(({ request_json }) => request_json).join('\n');
  returned.close();
  assert.equal(frozen.run_id, 'r-0003');
  assert.match(prompts, /remembered imperfectly/, 'the prompts carry the memory');
  // A what-if set of three pairs, seeded so the pairs differ: the runs without the post lose some of its posts. The real engine compares them.
  const posted = events.flatMap((event) => (event.type === 'social.post' ? [event.seq] : []));
  for (const index of [1, 2, 3, 4, 5, 6]) {
    const [pair, post] = [Math.ceil(index / 2), index % 2 === 0];
    seedFinishedRun(projectDir, { ...synthetic, repeat: { group: 'what-if', index, of: 6, what_if: { pair, post, text: 'Salary bands are on every job page now.', round: 1, poi_id: report.pois[0].id } } }, post ? events : events.filter((event) => !posted.slice(0, pair).includes(event.seq)));
  }
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.reload();
  await openReport();
  await root.getByText('Run 6 of 6 in a repeat set, pair 3, with the post your team added.', { exact: false }).waitFor();
  const whatIf = root.getByRole('region', { name: 'What-if post' });
  await whatIf.getByText('Inside the simulator, adding this post moved these numbers.', { exact: false }).waitFor();
  await whatIf.getByText('3 of 3 pairs finished', { exact: false }).waitFor();
  await whatIf.getByRole('cell', { name: /^[-+]\d+\.\d+ to [-+]\d+\.\d+$/ }).first().waitFor();
  await whatIf.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'what-if-pairs.png') });
  await page.setViewportSize({ width: 320, height: 1000 });
  await assertFits(page, 'the what-if table fits a narrow viewport');
  await page.screenshot({ path: join(shots, 'what-if-pairs-320.png') });
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.locator('#tab-runs').click();
  const picker = page.locator('#panel-runs').getByLabel('Later run');
  const offered = await picker.locator('option').allTextContents();
  assert.ok(offered.some((option) => option.startsWith('r-0013')) && !offered.some((option) => option.startsWith('r-0014')), 'a run with the post is no side of a comparison');
  await page.getByRole('button', { name: 'r-0014', exact: false }).first().getByText('repeat 6 of 6, pair 3, with the post your team added', { exact: false }).waitFor();
  assert.deepEqual(errors, []);
  console.log('ok    collapsed findings, written summary, priority labels, trait counts, coverage in the methods, keyboard toggles, evidence inspector and its replay, boxes on screenshots in the app and the printed export, the drop-off flow, continued numbering, detail sections, set-aside themes, empty/legacy reports, compare and run again, the repeat count and a real repeat set read again when its last report is written, a set with a trait-free run, a what-if set, a study plan, a study outcome, edits for sharing and questions to a persona on a real report, returning personas, and 320–1440px layouts');
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
