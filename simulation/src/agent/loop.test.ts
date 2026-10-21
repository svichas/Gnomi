import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, DEMO_SOCIALISER, DEMO_SURVEY } from '../llm/scripted.ts';
import { createFsBlobStore } from '../log/blobs.ts';
import { openProject } from '../log/sqlite.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import { createRecorder, newRunConfig, startRun } from '../run.ts';
import type { BrowserPool, PageDriver, PageOptions, Responder, SessionStore } from '../seams.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { Audience, EventOf, EventType, GnomiEvent, Persona, ProjectConfig, RunSettings, SessionInfo } from '../types.ts';

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

async function runWeb(name: string, opts: { personas: Persona[]; navigator: Responder; browsers: BrowserPool; settings?: Partial<RunSettings>; project?: Partial<ProjectConfig>; withLogin?: boolean }) {
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
  const llm = createScriptedGateway({ navigator: (req) => (req.purpose === 'survey' ? DEMO_SURVEY : opts.navigator(req)), socialiser: DEMO_SOCIALISER, judge: DEMO_JUDGE, author: DEMO_AUTHOR }, record);
  const config = store.createRun(newRunConfig(project, { personas: opts.personas, sessions: opts.withLogin ? [recruiter] : [], reset: false }));
  const report = await startRun(config, { store, blobs, browsers: opts.browsers, llm, record, sessions: opts.withLogin ? sessions : null }).done;
  const events = store.events(config.run_id);
  store.close();
  return { report, events };
}

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
