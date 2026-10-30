// The scan through a whole run on the real Gym: real browser, SQLite log, signals and report, scripted models. This proves the plumbing
// and what a report says, not that a live model complains about these defects.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startGym } from '../../../demo/GymSite/server.ts';
import { defectScores } from '../acceptance/checks.ts';
import { launchBrowserPool } from '../browser/pool.ts';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, DEMO_SURVEY } from '../llm/scripted.ts';
import { createFsBlobStore } from '../log/blobs.ts';
import { openProject } from '../log/sqlite.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import { createRecorder, newRunConfig, startRun } from '../run.ts';
import type { Responder } from '../seams.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { Persona, ProjectConfig } from '../types.ts';
import { reportToMarkdown } from './markdown.ts';
import { writtenSummary } from './summary.ts';

const CATALOGUE = readFileSync(new URL('../../../demo/GymSite/defects.yaml', import.meta.url), 'utf8');
const PALE = 'Send invitation is hard to read on that pale button';

/** Everyone walks the same route and p-3 alone says anything: on the users page, the page the scan flags on the defect build. */
function navigator(gym: string): Responder {
  const steps = new Map<string, number>();
  return (req) => {
    if (req.purpose === 'survey') return { ...DEMO_SURVEY, frictions: [], items: [] };
    const step = steps.get(req.persona_id ?? '') ?? 0;
    steps.set(req.persona_id ?? '', step + 1);
    const answer = (type: string, text: string | null, what: string | null = null) => ({
      thought: 'Scripted: following the route.', feeling: 0, action: { type, ref: null, text },
      friction: what && { severity: 2, what, expected: 'Text a person can read', about_ref: null }, opinion: null,
    });
    if (step === 0) return answer('navigate', `${gym}/jobs/new`);
    if (step === 1) return answer('navigate', `${gym}/settings/users`);
    return answer('done', 'Scripted route finished.', req.persona_id === 'p-3' ? PALE : null);
  };
}

test('on the real Gym a scan\'s finding is an observed theme, a complaint that fits it is confirmed, and the control build has neither', async (t) => {
  const browsers = await launchBrowserPool();
  t.after(() => browsers.close());
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const personas: Persona[] = ['p-1', 'p-2', 'p-3'].map((id) => ({ ...BUILTIN_PERSONA, id, name: `Persona ${id}`, device: 'desktop' }));
  const build = async (name: string, defects: string) => {
    const gym = await startGym({ port: 0, defects, candidatesDelayMs: 0, decisionDelayMs: 0 });
    t.after(() => gym.close());
    const store = openProject(join(dir, name));
    t.after(() => store.close());
    const project: ProjectConfig = {
      name: 'Gym ATS', description: 'A demo applicant tracking system.', goal: 'Look at the job form and the users page', role: null, audience: null,
      pois: [{ id: 'gym', type: 'web', name: 'Gym ATS', start_url: `${gym.url}/`, allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null }],
      settings: { ...DEFAULT_SETTINGS, concurrency: 3, social: false, accessibility_checks: true },
    };
    const record = createRecorder(store, () => {});
    const llm = createScriptedGateway({ navigator: navigator(gym.url), judge: (req) => ({ ...(DEMO_JUDGE(req) as object), themes: [] }), author: DEMO_AUTHOR }, record);
    const config = store.createRun(newRunConfig(project, { personas, sessions: [], reset: false }));
    const report = await startRun(config, { store, blobs: createFsBlobStore(join(dir, name)), browsers, llm, record, sessions: null }).done;
    assert.equal(report.status, 'finished', report.stop_reason ?? '');
    return { report, signals: store.events(config.run_id, { types: ['signal.accessibility'] }) };
  };

  const { report, signals } = await build('defects', 'all');
  assert.equal(signals.length, 2, 'three personas on two pages: one signal each, whoever got there first');
  const [form, users] = ['/jobs/new', '/settings/users'].map((path) => report.themes!.find((theme) => theme.pages.some((page) => page.endsWith(path)))!);
  assert.deepEqual([form.scan_only, form.trust, form.personas], [true, 'observed', 0]);
  assert.equal(form.title, 'Elements must meet minimum color contrast ratio thresholds on /jobs/new');
  assert.deepEqual([users.scan_only, users.trust, users.first_hand], [undefined, 'confirmed', ['p-3']]);
  assert.equal(users.evidence[0].scan?.rule, 'color-contrast');
  assert.deepEqual(defectScores(report.themes!, CATALOGUE, ['D10', 'D24']).found, 2, 'D10 by the scan alone, D24 confirmed');
  assert.equal(report.weighted.with_friction?.toFixed(4), (1 / 3).toFixed(4), 'only the persona who complained ran into friction, whoever\'s step the scan sits on');
  assert.deepEqual(report.themes!.map((theme) => theme.rank), [1, 2], 'what a persona met comes first');
  assert.match(writtenSummary(report)!, /^The biggest problem in this run is “Reported friction on \/settings\/users”, met by 1 of 3 personas who reached the page\..*Next, look at “Elements must meet/);
  const md = reportToMarkdown(report);
  assert.ok(md.includes('- Evidence: Found by the accessibility scan of the page, not by a persona.'));
  assert.ok(md.includes('- Accessibility scan: color-contrast, serious, 1 element: body &gt; main:nth-child(2)'));

  const control = await build('control', 'none');
  assert.equal(control.signals.length, 0);
  assert.deepEqual(control.report.themes!.map((theme) => theme.trust), ['reported'], 'the complaint stands alone, with no confirmed theme on the control build');
});
