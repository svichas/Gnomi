// The M6 test on the real Gym: real browser, SQLite log, signals and report, scripted models. The navigator only reads what the page
// shows, so a theme exists because a defect is on. This proves the comparison's plumbing, not that a live model finds these defects.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFECT_IDS, startGym } from '../../../demo/GymSite/server.ts';
import { launchBrowserPool } from '../browser/pool.ts';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, DEMO_SURVEY, requestText } from '../llm/scripted.ts';
import { createFsBlobStore } from '../log/blobs.ts';
import { openProject } from '../log/sqlite.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import { createRecorder, newRunConfig, startRun } from '../run.ts';
import type { Responder } from '../seams.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { Persona, ProjectConfig, Report } from '../types.ts';
import { diffReports } from './diff.ts';

const SWITCHED_OFF = ['D01', 'D14', 'D16']; // their themes sit on pages that outlive the fix, so their absence can be checked
const SEATS = 'The users page is called Seats here, which I did not expect';
const DRAFT = 'The button says Save draft on a form that publishes the job';
const BYPASS = 'Disable approval bypass reads as a double negative'; // D12 stays on in both builds
const SURVEY = DEMO_SURVEY.frictions[0].what; // every persona's answer, and a theme with no page
const SERVER_ERROR = /^HTTP 500/; // the Gym's own 500 on an apostrophe in feedback (D14), which no persona reports

/** One persona's route. Each step reads the page it is on and acts on an element by its ref; only what the page shows raises a friction. */
function navigator(gym: string): Responder {
  const steps = new Map<string, number>();
  const ref = (page: string, name: RegExp) => new RegExp(`${name.source}.*\\[ref=([^\\]]+)\\]`).exec(page)?.[1] ?? null;
  return (req) => {
    if (req.purpose === 'survey') return DEMO_SURVEY;
    const page = requestText(req);
    const step = steps.get(req.persona_id ?? '') ?? 0;
    steps.set(req.persona_id ?? '', step + 1);
    const answer = (type: string, target: string | null, text: string | null, friction: { what: string; about: string | null } | null = null) => ({
      thought: 'Scripted: following the route.', feeling: 0, action: { type, ref: target, text },
      friction: friction && { severity: 2, what: friction.what, expected: 'A page that says what it does', about_ref: friction.about }, opinion: null,
    });
    const [seats, draft] = [ref(page, /link "Seats"/), ref(page, /button "Save draft"/)];
    switch (step) {
      case 0: return answer('navigate', null, `${gym}/settings`);
      case 1: return answer('click', seats ?? ref(page, /link "Users"/), null, seats ? { what: SEATS, about: seats } : null);
      case 2: return answer('navigate', null, `${gym}/settings/approvals`);
      case 3: return answer('navigate', null, `${gym}/jobs/new`, page.includes('Disable approval bypass') ? { what: BYPASS, about: null } : null);
      case 4: return answer('navigate', null, `${gym}/reviews/1`, draft ? { what: DRAFT, about: draft } : null);
      case 5: return answer('type', ref(page, /textbox "Feedback"/), "I don't think she fits the role", null);
      case 6: return answer('click', ref(page, /button "Send feedback"/), null); // a signal near a self-report on its page would confirm that one instead
      default: return answer('done', null, 'Scripted route finished.');
    }
  };
}

/** The judge's one job here: a theme per group, named by what was reported, so two themes never look alike by a shared template. */
const judge: Responder = (req) => ({
  ...(DEMO_JUDGE(req) as object),
  themes: (JSON.parse(requestText(req)).groups as { id: string; texts: string[] }[]).map((group) => ({ title: group.texts[0], description: group.texts[0], group_ids: [group.id] })),
});

test('the M6 test: with three defects off, exactly those three read as not seen again, and the rest stay', async (t) => {
  const browsers = await launchBrowserPool();
  t.after(() => browsers.close());
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-m6-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const personas: Persona[] = ['p-1', 'p-2', 'p-3', 'p-4'].map((id) => ({ ...BUILTIN_PERSONA, id, name: `Persona ${id}`, device: 'desktop' }));

  const build = async (name: string, defects: string): Promise<Report> => {
    const gym = await startGym({ port: 0, defects, candidatesDelayMs: 0, decisionDelayMs: 0 }); // a new port each, as a restart gives
    t.after(() => gym.close());
    const store = openProject(join(dir, name));
    t.after(() => store.close());
    const project: ProjectConfig = {
      name: 'Gym ATS', description: 'A demo applicant tracking system.', goal: 'Look through the settings, then leave feedback on a candidate', role: null, audience: null,
      pois: [{ id: 'gym', type: 'web', name: 'Gym ATS', start_url: `${gym.url}/`, allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null }],
      settings: { ...DEFAULT_SETTINGS, screenshots: false, concurrency: 4, social: false },
    };
    const record = createRecorder(store, () => {});
    const llm = createScriptedGateway({ navigator: navigator(gym.url), judge, author: DEMO_AUTHOR }, record);
    return startRun(store.createRun(newRunConfig(project, { personas, sessions: [], reset: false })), { store, blobs: createFsBlobStore(join(dir, name)), browsers, llm, record, sessions: null }).done;
  };
  const before = await build('all', DEFECT_IDS.join(','));
  const after = await build('fixed', DEFECT_IDS.filter((id) => !SWITCHED_OFF.includes(id)).join(','));
  assert.deepEqual([before.status, after.status], ['finished', 'finished'], `${before.stop_reason} ${after.stop_reason}`);

  const diff = diffReports([before], [after]);
  const titles = (status: string) => diff.themes.filter((theme) => theme.status === status).map((theme) => theme.before_title ?? theme.after_title ?? '').sort();
  const fixed = titles('fixed');
  assert.equal(fixed.length, 3, JSON.stringify(diff.themes, null, 1));
  assert.deepEqual(fixed.filter((title) => !SERVER_ERROR.test(title)), [SEATS, DRAFT].sort());
  assert.ok(fixed.some((title) => SERVER_ERROR.test(title)), 'the third is the real 500, from the browser and not from a script');
  assert.deepEqual(titles('new'), [], 'nothing else changed');
  assert.deepEqual(titles('not_retested'), [], 'every persona walked the whole route');
  assert.deepEqual(titles('unchanged'), [BYPASS, SURVEY].sort(), 'a defect left on stays, and so does a theme with no page');
  assert.ok(diff.themes.every((theme) => !theme.weak && theme.reached === personas.length), JSON.stringify(diff.themes, null, 1));
  assert.deepEqual(diff.notes, [], 'the same personas and scripted models on two addresses of one product');
});
