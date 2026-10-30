import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, DEMO_SOCIALISER, DEMO_SURVEY } from '../llm/scripted.ts';
import { createFsBlobStore } from '../log/blobs.ts';
import { openProject } from '../log/sqlite.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import { targetIn } from './loop.ts';
import { createRecorder, newRunConfig, startRun } from '../run.ts';
import { getPersonaSchema } from '../profile/schema.ts';
import type { BrowserPool, LlmRequest, PageDriver, PageOptions, Responder, SessionStore } from '../seams.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { AccessibilityViolation, Audience, EventOf, EventType, GnomiEvent, Persona, ProjectConfig, RunSettings, SessionInfo, WebPoi } from '../types.ts';

const dir = mkdtempSync(join(tmpdir(), 'gnomi-loop-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const of = <K extends EventType>(events: GnomiEvent[], type: K) => events.filter((e): e is EventOf<K> => e.type === type);
const audience: Audience = { seed: 7, persona_count: 12, segments: [], company_size: [50, 2000], languages: { en: 1 }, accessibility: { none: 1, low_vision: 0, colour_blind: 0, screen_reader: 0, motor: 0 } };
// Patience 1 is a 12-step budget, so three rounds are slices of four steps.
const personas = (n: number): Persona[] => Array.from({ length: n }, (_, i) => ({ ...BUILTIN_PERSONA, id: `p-${i}`, name: `P ${i}`, patience: 1 }));
const step = (type: string, ref: string | null = null, text: string | null = null) => ({ thought: 't', feeling: 0, action: { type, ref, text }, friction: null, opinion: null });
const recruiter: SessionInfo = { role: 'recruiter', start_url: 'http://gym.test/dashboard', hosts: ['gym.test'], recorded_at: 1, verified_at: 1, expires_at: null };
const login = { cookies: [{ name: 'gym_session', value: 'v1' }] };
const sessions: SessionStore = { list: () => [recruiter], save: async () => {}, load: async (role) => (role === recruiter.role ? { info: recruiter, state: login } : null), markVerified: () => {} };

type FakePage = { gotos: string[]; options: PageOptions; closed: boolean };

/** Pages that land where they are sent; a click goes to /jobs. `over` replaces a page's methods. */
function fakeBrowsers(over: (page: FakePage, n: number) => Partial<PageDriver> = () => ({})) {
  const pages: FakePage[] = [];
  let open = 0;
  let peak = 0;
  const browsers = {
    async newPage(options: PageOptions): Promise<PageDriver> {
      const page: FakePage = { gotos: [], options, closed: false };
      pages.push(page);
      peak = Math.max(peak, ++open);
      let url = '';
      return {
        goto: async (to) => void page.gotos.push((url = to)),
        snapshot: async () => ({ url, title: 'Gym', text: '- link "Jobs" [ref=e1]', hash: url }),
        screenshot: async () => new Uint8Array([0xff, 0xd8, 0xff]),
        async act(action) {
          const before = url;
          if (action.type === 'click') url = 'http://gym.test/jobs';
          return { ok: true, url_before: before, url_after: url, dom_changed: true, error: null, target: null, text: null };
        },
        inspect: async () => ({ login: false, challenge: null, live_key: null }),
        errors: () => [],
        async close() {
          if (!page.closed) open--;
          page.closed = true;
        },
        ...over(page, pages.length),
      };
    },
  } as unknown as BrowserPool;
  return { browsers, pages, peak: () => peak };
}

async function runWeb(name: string, opts: { personas: Persona[]; navigator: Responder; browsers: BrowserPool; author?: Responder; settings?: Partial<RunSettings>; project?: Partial<ProjectConfig>; withLogin?: boolean }) {
  const folder = join(dir, name);
  const store = openProject(folder);
  const blobs = createFsBlobStore(folder);
  const project: ProjectConfig = {
    name: 'Gym ATS', description: '', goal: 'Post a job', role: opts.withLogin ? 'recruiter' : null, audience: null, settings: { ...DEFAULT_SETTINGS, social: false, ...opts.settings },
    pois: [{ id: 'poi-1', type: 'web', name: 'Gym ATS', start_url: 'http://gym.test/', allowed_hosts: [], production_domains: ['gym.com'], reset_hook_url: null, mode: 'full', segments: null }],
    ...opts.project,
  };
  store.saveProject(project);
  const record = createRecorder(store, () => {});
  const llm = createScriptedGateway({ navigator: (req) => (req.purpose === 'survey' ? DEMO_SURVEY : opts.navigator(req)), socialiser: DEMO_SOCIALISER, judge: DEMO_JUDGE, author: opts.author ?? DEMO_AUTHOR }, record);
  const config = store.createRun(newRunConfig(project, { personas: opts.personas, sessions: opts.withLogin ? [recruiter] : [], reset: false }));
  const report = await startRun(config, { store, blobs, browsers: opts.browsers, llm, record, sessions: opts.withLogin ? sessions : null }).done;
  const events = store.events(config.run_id);
  store.close();
  return { report, events };
}

test('a target read from the page text keeps its box: the marks are still there, and an element without one has none', () => {
  const text = '- link "Jobs" [ref=e1] [box=8,16,100,20]\n- button "Save" [ref=e2]\n- button [ref=e3] [box=1,2,3,4]';
  assert.deepEqual(targetIn(text, 'e1'), { role: 'link', name: 'Jobs', box: [8, 16, 100, 20] });
  assert.deepEqual(targetIn(text, 'e2'), { role: 'button', name: 'Save', box: null });
  assert.equal(targetIn(text, 'e3'), null, 'nothing to call it by');
  assert.equal(targetIn(text, 'e4'), null);
});

test('each step records what its screenshot spans, and a friction carries its element as this step\'s screenshot shows it', async () => {
  const page = (y: number) => `- button "Save" [ref=e1] [box=8,${y},100,20]`;
  const texts = [page(10), page(300), page(300), '- link "Other" [ref=e1] [box=1,2,3,4]'];
  let look = 0;
  const { browsers } = fakeBrowsers(() => ({
    snapshot: async () => ({ url: 'http://gym.test/', title: 'Gym', text: texts[look++], hash: `h${look}`, viewport: [0, 0, 1280, 800] }),
    act: async (action) => ({ ok: false, url_before: 'http://gym.test/', url_after: 'http://gym.test/', dom_changed: false, error: 'timeout', target: action.ref ? { role: 'button', name: 'Save', box: [8, 10, 100, 20] } : null, text: null }),
  }));
  const said = (what: string, about_ref: string | null) => ({ severity: 2, what, expected: 'Saved', about_ref });
  const answers = [step('click', 'e1'), { ...step('hover', 'e1'), friction: said('Save moved away', null) }, { ...step('click', 'e1'), friction: said('Save is here', 'e1') }, { ...step('done'), friction: said('Save is gone', null) }];
  let asked = 0;
  const { events } = await runWeb('marks', { personas: personas(1), browsers, navigator: () => answers[asked++] });
  assert.deepEqual(of(events, 'persona.step')[0].payload.viewport, [0, 0, 1280, 800]);
  const about = of(events, 'persona.friction_reported').map((e) => [e.payload.what, e.payload.about?.box]);
  assert.deepEqual(about, [['Save moved away', [8, 300, 100, 20]], ['Save is here', [8, 300, 100, 20]], ['Save is gone', null]], 'the failed target where it now stands, the one named, then none: the ref names something else on this page');
});

test('each step keeps the page text the model saw, identical pages share one file, and the author reads it back', async () => {
  const text = '- textbox "Password" [ref=e1] [password: filled]\n- button "Save" [ref=e2]';
  const { browsers } = fakeBrowsers(() => ({ snapshot: async () => ({ url: 'http://gym.test/', title: 'Gym', text, hash: 'abc123' }) }));
  const shown: string[] = [];
  const authored: string[] = [];
  let steps = 0;
  const { report, events } = await runWeb('page-text', {
    personas: personas(1), browsers,
    navigator(req) {
      shown.push(req.user.map((part) => (part.type === 'text' ? part.text : '')).join(''));
      return { ...step(++steps === 2 ? 'done' : 'wait'), friction: { severity: 2, what: 'Save does nothing', expected: 'Saved', about_ref: null } };
    },
    author(req) {
      authored.push(req.user.map((part) => (part.type === 'text' ? part.text : '')).join(''));
      return DEMO_AUTHOR(req);
    },
  });
  assert.equal(report.status, 'finished', report.stop_reason ?? '');
  const hashes = of(events, 'persona.step').map((e) => e.payload.snapshot_hash);
  assert.deepEqual(hashes, ['abc123', 'abc123']);
  assert.deepEqual(readdirSync(join(dir, 'page-text', 'runs', report.run_id, 'snapshots')), ['abc123.txt']);
  assert.equal(readFileSync(join(dir, 'page-text', 'runs', report.run_id, 'snapshots', 'abc123.txt'), 'utf8'), text);
  assert.ok(shown[0].includes(text), 'the file holds exactly what the navigator was shown');
  assert.equal(JSON.parse(authored[0]).themes[0].evidence[0].page_text, '- textbox "Password" [password: filled] - button "Save"');
});

test('between social rounds a persona holds no page: open pages stay within the concurrency, and a woken persona is back where it was, logged in', async () => {
  const { browsers, pages, peak } = fakeBrowsers();
  const { report, events } = await runWeb('slices', {
    personas: personas(12), navigator: () => step('click', 'e1'), browsers, withLogin: true,
    settings: { social: true, rounds: 3, concurrency: 3 }, project: { audience },
  });
  assert.equal(report.status, 'finished', report.stop_reason ?? '');
  assert.equal(of(events, 'run.round_started').length, 3);
  assert.ok(peak() <= 3, `at most three pages open at once, saw ${peak()}`);
  assert.ok(pages.every((p) => p.closed));
  const reopened = pages.filter((p) => p.gotos[0] !== 'http://gym.test/dashboard');
  assert.equal(reopened.length, 24, 'each persona reopens its page in rounds 2 and 3');
  assert.ok(reopened.every((p) => p.gotos[0] === 'http://gym.test/jobs'), 'at its last good URL');
  assert.ok(pages.every((p) => p.options.storageState === login), 'with the recorded login');
});

test('a woken persona carries on as the same visitor: its page reopens with the cookies and storage the last one left with', async () => {
  const own = (n: number) => ({ cookies: [{ name: 'signed_up', value: `page-${n}` }] });
  const { browsers, pages } = fakeBrowsers((_page, n) => ({ storageState: async () => own(n) }));
  const { report } = await runWeb('carried', {
    personas: personas(1), navigator: () => step('click', 'e1'), browsers, withLogin: true,
    settings: { social: true, rounds: 3, concurrency: 1 }, project: { audience },
  });
  assert.equal(report.status, 'finished', report.stop_reason ?? '');
  assert.deepEqual(pages.map((p) => p.options.storageState), [login, own(1), own(2)]);
});

test('an error from reloading a woken persona\'s page is not reported as one the persona ran into', async () => {
  const { browsers } = fakeBrowsers((page) => {
    let reported = false;
    return { errors: () => (page.gotos.length && !reported && (reported = true) ? [{ kind: 'http' as const, status: 405, message: 'GET /users answered 405' }] : []) };
  });
  const { report, events } = await runWeb('reload', {
    personas: personas(1), navigator: () => step('click', 'e1'), browsers, withLogin: true,
    settings: { social: true, rounds: 3, concurrency: 1 }, project: { audience },
  });
  assert.equal(report.status, 'finished', report.stop_reason ?? '');
  assert.equal(of(events, 'signal.error').length, 1, 'only the first page\'s error, which a step saw');
});

test('a page a late redirect replaces under the snapshot is read again; the persona goes on and nobody else is cancelled', async () => {
  let reads = 0;
  const { browsers } = fakeBrowsers((page) => ({
    async snapshot() {
      // The second look of the first persona to get there runs into the navigation.
      if (++reads === 2) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
      const url = page.gotos.at(-1)!;
      return { url, title: 'Gym', text: '- link "Jobs" [ref=e1]', hash: url };
    },
  }));
  const { report, events } = await runWeb('redirect', {
    personas: personas(2), browsers, settings: { concurrency: 2 },
    navigator: (req) => (/Step 2\./.test(JSON.stringify(req.user)) ? step('done', null, 'Posted') : step('scroll', null, 'down')),
  });
  assert.equal(report.status, 'finished', report.stop_reason ?? '');
  assert.deepEqual(report.personas.map((p) => p.outcome), ['done', 'done']);
  assert.equal(of(events, 'persona.step').length, 4);
});

test('a timed-out model call is a failed step, as an invalid answer is, and the run goes on', async () => {
  let calls = 0;
  const { browsers } = fakeBrowsers();
  const { report, events } = await runWeb('timeout', {
    personas: personas(1), browsers,
    navigator: () => {
      if (++calls === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return step('done', null, 'Posted');
    },
  });
  assert.equal(report.status, 'finished', report.stop_reason ?? '');
  assert.deepEqual(of(events, 'persona.step').map((e) => e.payload.result.error), ['invalid_output', null]);
  assert.equal(report.personas[0].outcome, 'done');
});

const needing = (...needs: Persona['accessibility_needs'][]) => personas(needs.length).map((persona, i) => ({ ...persona, accessibility_needs: needs[i] }));
const violation = (rule: string, impact: AccessibilityViolation['impact'] = 'serious'): AccessibilityViolation => ({ rule, impact, category: 'color', help: `${rule} help`, elements: 2, selectors: ['main > p'] });
const shown = (req: LlmRequest<unknown>) => req.user.some((part) => part.type === 'image');

test('with accessibility_checks off nothing changes: no scan, no emulation, and a screen-reader persona gets its screenshots', async () => {
  let scans = 0;
  const { browsers, pages } = fakeBrowsers(() => ({ audit: async () => { scans++; return [violation('color-contrast')]; } }));
  const images: boolean[] = [];
  const { report, events } = await runWeb('checks-off', {
    personas: needing('screen_reader', 'colour_blind', 'low_vision'), browsers,
    navigator(req) {
      images.push(shown(req));
      return step('done', null, 'Posted');
    },
  });
  assert.equal(scans, 0);
  assert.ok(pages.every((page) => !('vision' in page.options)));
  assert.deepEqual(images, [true, true, true]);
  assert.equal(of(events, 'accessibility.scanned').length + of(events, 'signal.accessibility').length, 0);
  assert.ok(of(events, 'persona.episode_started').every((e) => !('perception' in e.payload)));
  assert.ok(!report.methods.limitations?.some((l) => /accessibility|screen-reader|simulated/.test(l)));
});

test('accessibility_checks sets what each need can perceive, and only those with a real emulation', async () => {
  const { browsers, pages } = fakeBrowsers();
  const images = new Map<string, boolean>();
  const { events } = await runWeb('needs', {
    personas: needing('colour_blind', 'low_vision', 'screen_reader', 'motor', 'none'), browsers, settings: { accessibility_checks: true, concurrency: 1 },
    navigator(req) {
      images.set(req.persona_id!, shown(req));
      return step('done', null, 'Posted');
    },
  });
  const started = of(events, 'persona.episode_started');
  const of_ = (i: number) => started.findIndex((e) => e.persona_id === `p-${i}`);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => pages[of_(i)].options.vision), ['deuteranopia', 'blurredVision', undefined, undefined, undefined]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => started[of_(i)].payload.perception), ['deuteranopia', 'blurredVision', 'screen_reader', undefined, undefined]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => images.get(`p-${i}`)), [true, true, false, true, true], 'the screen-reader persona alone gets the page as text');
  assert.ok(of(events, 'persona.step').every((e) => e.payload.screenshot), 'its screenshots are still stored as evidence');
});

test('a need the project keeps out of its prompts changes nothing in code either', async () => {
  const persona_schema = getPersonaSchema();
  persona_schema.attributes.find((a) => a.id === 'accessibility_needs')!.use_in_prompt = false;
  const { browsers, pages } = fakeBrowsers();
  await runWeb('need-off', { personas: needing('colour_blind'), browsers, settings: { accessibility_checks: true }, project: { persona_schema }, navigator: () => step('done', null, 'Posted') });
  assert.ok(!('vision' in pages[0].options));
});

test('personas reaching one page at once scan it once; the signal sits on one step and adds none', async () => {
  let scans = 0;
  const { browsers } = fakeBrowsers(() => ({
    async audit() {
      scans++;
      await new Promise((done) => setTimeout(done, 30));
      return [violation('color-contrast'), violation('region', 'moderate')];
    },
  }));
  const { report, events } = await runWeb('scan-once', {
    personas: personas(4), browsers, settings: { accessibility_checks: true, concurrency: 4 },
    navigator: () => step('done', null, 'Posted'),
  });
  assert.equal(scans, 1);
  const [signal, ...others] = of(events, 'signal.accessibility');
  assert.deepEqual([others.length, signal.payload.rule, signal.payload.ref], [0, 'color-contrast', null]);
  assert.equal(of(events, 'accessibility.scanned').length, 1);
  assert.deepEqual(of(events, 'accessibility.scanned')[0].payload.audit.map((v) => v.rule), ['region']);
  assert.equal(of(events, 'persona.step').length, 4, 'one step each: a scan is no step');
  assert.deepEqual(report.personas.map((p) => p.outcome), ['done', 'done', 'done', 'done']);
  const theme = report.themes!.find((t) => t.scan_only)!;
  assert.deepEqual([theme.trust, theme.personas, theme.evidence[0].persona_id], ['observed', 0, signal.persona_id]);
  assert.deepEqual(report.methods.accessibility_audit?.map((row) => row.rule), ['region']);
});

test('a page state seen again is not scanned again, and a new state of the same page adds no second signal', async () => {
  let scans = 0;
  let look = 0;
  const hashes = ['a', 'a', 'b', 'a'];
  const { browsers } = fakeBrowsers(() => ({
    snapshot: async () => ({ url: 'http://gym.test/jobs/new', title: 'Gym', text: '- link "Jobs" [ref=e1]', hash: hashes[look++] }),
    audit: async () => { scans++; return [violation('color-contrast')]; },
  }));
  const { events } = await runWeb('scan-states', {
    personas: personas(1), browsers, settings: { accessibility_checks: true },
    navigator: (req) => (/Step 4\./.test(JSON.stringify(req.user)) ? step('done', null, 'Posted') : step('scroll', null, 'down')),
  });
  assert.equal(scans, 2);
  assert.equal(of(events, 'signal.accessibility').length, 1);
  assert.deepEqual(of(events, 'accessibility.scanned').map((e) => e.payload.snapshot_hash), ['a', 'b']);
});

test('a scan that fails costs the persona nothing and the report says how many pages went unscanned', async () => {
  const { browsers } = fakeBrowsers(() => ({ audit: async () => { throw new Error('page.evaluate: refused'); } }));
  let steps = 0;
  const { report, events } = await runWeb('scan-fails', {
    personas: personas(1), browsers, settings: { accessibility_checks: true },
    navigator: () => (++steps === 2 ? step('done', null, 'Posted') : step('click', 'e1')),
  });
  assert.equal(report.status, 'finished', report.stop_reason ?? '');
  assert.equal(report.personas[0].outcome, 'done');
  assert.deepEqual(of(events, 'accessibility.scanned').map((e) => e.payload.error), ['page.evaluate: refused', 'page.evaluate: refused']);
  assert.ok(report.methods.limitations?.includes('The accessibility scan failed on 2 pages, so nothing is known about them from the scan.'), JSON.stringify(report.methods.limitations));
});

test('a competitor\'s site is not scanned', async () => {
  const urls: string[] = [];
  const { browsers } = fakeBrowsers((page) => ({ audit: async () => { urls.push(page.gotos.at(-1)!); return []; } }));
  const product: WebPoi = { id: 'poi-1', type: 'web', name: 'Gym ATS', start_url: 'http://gym.test/', allowed_hosts: [], production_domains: ['gym.com'], reset_hook_url: null, mode: 'full', segments: null };
  const rival: WebPoi = { ...product, id: 'poi-2', name: 'Rival', start_url: 'http://rival.test/', production_domains: [], mode: 'observe_only' };
  const { events } = await runWeb('scan-rival', { personas: personas(1), browsers, settings: { accessibility_checks: true }, project: { pois: [product, rival] }, navigator: () => step('done', null, 'Done') });
  assert.deepEqual(of(events, 'persona.step').map((e) => e.poi_id), ['poi-1', 'poi-2'], 'it browsed both');
  assert.deepEqual(urls, ['http://gym.test/']);
});
