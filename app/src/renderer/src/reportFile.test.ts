import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import tailwindcss from '@tailwindcss/vite';
import { createServer } from 'vite';
import type { Report } from '@gnomi/simulation/types.ts';
import { HYPOTHESIS_BANNER } from '@gnomi/simulation/report/build.ts';
import { comparisonFixture } from './comparisonReport.fixture.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Node cannot load TSX or CSS, so Vite transforms the export module as the app build does, Tailwind included.
// The engine client in ui.tsx listens for its port when it loads, so it needs a window.
Object.assign(globalThis, { window: new EventTarget() });
const vite = await createServer({ configFile: false, root: import.meta.dirname + '/..', plugins: [tailwindcss()], logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true } });
after(() => vite.close());
const { IMAGE_BYTES, reportFile } = (await vite.ssrLoadModule('/src/reportFile.tsx')) as typeof import('./reportFile.tsx');

function fixture(count: number, frictionsEach: number): Report {
  const personas = Array.from({ length: count }, (_, i) => ({
    id: `p-1-${i}`, name: `Persona ${i}`, job_title: 'Recruiter', segment_id: 'seg-a', device: 'desktop' as const,
    outcome: 'abandoned' as const, outcome_text: 'Gave up on the form.', steps: 40, frictions: frictionsEach,
  }));
  const frictions = personas.flatMap((persona, i) => Array.from({ length: frictionsEach }, (_, j) => ({
    seq: i * 100 + j, persona_id: persona.id, persona_name: persona.name, segment_id: 'seg-a', step_no: j + 1, severity: 2,
    what: 'The Save button is ambiguous.', expected: 'A button that says what it does.', url: 'http://localhost:3001/jobs/new',
    quote: 'Is this posting or saving?', screenshot: j === 0 && i === 1 ? null : `runs/r-0001/shots/${persona.id}-${j}.jpg`,
  })));
  return {
    run_id: 'r-0001', status: 'finished', stop_reason: null, goal: 'Post a job for a "backend" <engineer>', pois: [{ id: 'poi-gym', type: 'web', name: 'Gym', start_url: 'http://localhost:3001/' }],
    personas,
    segments: [{ id: 'seg-a', name: 'Recruiters', share: 100, personas: count, outcomes: { done: 0, abandoned: count, budget_exceeded: 0, repeated_failure: 0, blocked: 0, incomplete: 0 }, completion: 0, with_friction: 1, frictions: frictions.length }],
    weighted: { completion: 0, with_friction: 1 }, steps: count * 40, frictions,
    cost_usd: 4.2, llm_calls: count * 40, input_tokens: 1_000_000, output_tokens: 50_000, started_at: 0, ended_at: 600_000, duration_ms: 600_000, banner: HYPOTHESIS_BANNER,
    methods: { seed: 7, roles: [], models: {}, budgets: { cost_usd: 10, wall_clock_min: 60, concurrency: 4 }, allowed_hosts: ['localhost:3001'], blocked_requests: [], blocked: [], tripwires: [], reset: null, concurrency_changes: [] },
  };
}

const thumbnails = (bytes?: number) => async (paths: string[]) =>
  Object.fromEntries(paths.map((path) => [path, `data:image/jpeg;base64,${bytes ? 'A'.repeat(bytes) : btoa(path)}`]));

test('the HTML export is one file with no scripts or external resources, its screenshots inlined and nothing interactive', async () => {
  const report = fixture(2, 2);
  const html = await reportFile(report, 'html', thumbnails());
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*(?!["']?data:)/i, 'every src and href is a data URL');
  assert.doesNotMatch(html, /url\(\s*(?!["']?data:)|@import/i, 'the styles fetch nothing');
  assert.match(html, /data:font\/woff2;base64,/, 'Inter travels inside the file');
  assert.match(html, /src="data:image\/svg\+xml,/, 'the brand logo travels inside the file');
  assert.doesNotMatch(html, /<(?:button|select)\b/, 'no inspector links or export control');
  assert.match(html, /<style>[\s\S]*\.bg-amber-50[\s\S]*@media print/, 'the app styles and the print styles are inline');
  assert.match(html, /<title>Gnomi report: Post a job for a &#34;backend&#34; &#60;engineer&#62;<\/title>/);
  for (const { screenshot } of report.frictions.filter((f) => f.screenshot)) assert.ok(html.includes(`src="data:image/jpeg;base64,${btoa(screenshot!)}"`), `${screenshot} is inlined`);
});

test('a 50-persona report with screenshots stays under 25 MB, leaving out screenshots past the image budget', async () => {
  const thumbnail = 60_000; // a 640-pixel JPEG of a busy page; the Gym's are smaller
  const typical = await reportFile(fixture(50, 6), 'html', thumbnails(thumbnail));
  assert.equal(typical.split('src="data:image/jpeg').length - 1, 50 * 6 - 1, 'all but the missing screenshot are inlined');
  const heavy = await reportFile(fixture(50, 20), 'html', thumbnails(thumbnail));
  for (const html of [typical, heavy]) assert.ok(Buffer.byteLength(html) < 25_000_000, `${Buffer.byteLength(html)} bytes`);
  const inlined = heavy.split('src="data:image/jpeg').length - 1;
  assert.equal(inlined, Math.floor(IMAGE_BYTES / (thumbnail + 'data:image/jpeg;base64,'.length)));
  assert.ok(heavy.includes('This screenshot is not included in the file.'));
});

test('the JSON export round-trips the report', async () => {
  const report = fixture(3, 2);
  assert.deepEqual(JSON.parse(await reportFile(report, 'json', thumbnails())), report);
});

test('HTML exports escape untrusted report text and reject external or active thumbnail resources', async () => {
  const report = fixture(1, 1);
  const attack = '</title><script>alert("report")</script><img src=x onerror="alert(1)">';
  report.goal = attack;
  report.frictions[0].what = attack;
  report.frictions[0].quote = '<svg onload="alert(2)">';
  for (const resource of ['https://example.test/tracker.png', 'javascript:alert(1)', 'data:image/svg+xml,<svg onload="alert(1)"/>']) {
    const html = await reportFile(report, 'html', async (paths) => Object.fromEntries(paths.map((path) => [path, resource])));
    assert.doesNotMatch(html, /<(?:script|img src=x|svg onload)/i);
    assert.ok(html.includes('&lt;script&gt;alert(&quot;report&quot;)&lt;/script&gt;'));
    assert.ok(html.includes('This screenshot is not included in the file.'));
    assert.doesNotMatch(html, /<[^>]+\b(?:src|href)\s*=\s*(?!["']?data:)/i);
  }
});

test('repeated evidence screenshots cannot exceed the embedded image allowance', async () => {
  const report = fixture(1, 3);
  report.frictions.forEach((friction) => { friction.screenshot = 'shared-evidence.jpg'; });
  const html = await reportFile(report, 'html', thumbnails(Math.ceil(IMAGE_BYTES / 2)));
  assert.ok(Buffer.byteLength(html) < 25_000_000);
  assert.ok(html.includes('This screenshot is not included in the file.'));
});

test('the opinion spread and homogeneity render into the export, the sentiment line as inline SVG', async () => {
  const report = fixture(2, 1);
  const stats = {
    posts: 2,
    seeds: [{ seq: 50, post_id: 's1', persona_id: 'p-1-0', persona_name: 'Persona 0', segment_id: 'seg-a', round: 1, text: 'Save <is> broken', injected: false }],
    first_hand: ['p-1-0'],
    second_hand: ['p-1-1'],
    segments: [{ segment_id: 'seg-a', name: 'Recruiters', personas: 2, seed: true }],
    influence: [{ from: 'p-1-0', to: 'p-1-1', poi_id: 'poi', post_id: 's1', seq: 60, round: 2, delta: -1, kind: 'influence' as const }],
    sentiment: [{ round: 1, mean: -1, personas: 1 }, { round: 2, mean: -1.5, personas: 2 }],
  };
  report.spread = [{ poi_id: 'poi', name: 'Gym', ...stats, themes: [{ theme_id: 'g1', rank: 1, title: 'Saving fails', ...stats }] }];
  report.methods.homogeneity = { posts: 0.42, post_count: 2, narratives: 0.1, threshold: 0.3, warning: 'The posts read alike.' };
  const html = await reportFile(report, 'html', thumbnails());
  for (const text of ['Opinion spread', 'About Gym', 'Saving fails', '“Save &lt;is&gt; broken”', 'Persona 0 → Persona 1, round 2, sentiment −1.0', 'Round 2: −1.5', 'Posts 0.42 (2 posts)', 'The posts read alike.']) {
    assert.ok(html.includes(text), text);
  }
  assert.equal(html.split('<svg').length - 1, 2, 'one sentiment line for the POI and one for the theme');
  assert.doesNotMatch(html, /<(?:button|select|script)\b/);
});

test("a text POI's quoted passages and the buying survey render into the HTML and Markdown exports", async () => {
  const report = fixture(1, 1);
  report.pois = [{ id: 'pricing', type: 'text', name: 'Pricing page', start_url: null }];
  Object.assign(report.frictions[0], { url: 'asset:0123456789abcdef.md', screenshot: null, passage: { start: 412, end: 437, text: 'Single sign-on (SAML SSO)' } });
  const like = (text: string) => ({ text, count: 1, personas: 1, seqs: [9] });
  report.buyers = [{ poi_id: 'pricing', segment_id: 'seg-a', name: 'Recruiters', surveyed: 1, sentiment: -1, would_buy: 0, price: { low: 0, fair: 0, high: 0, unclear: 1 }, objections: [like('No SSO on <Team>')], unclear: [like('Whether Team has SSO')] }];
  const html = await reportFile(report, 'html', thumbnails());
  for (const text of ['In the text:', '“Single sign-on (SAML SSO)”', 'Buying survey', 'Would buy or recommend', 'Recruiters: what would stop them buying', 'No SSO on &lt;Team&gt;', 'Whether Team has SSO', '0 / 0 / 0 / 1']) {
    assert.ok(html.includes(text), text);
  }
  const markdown = await reportFile(report, 'md', thumbnails());
  assert.match(markdown, /## Buying survey[\s\S]*\| Recruiters \| 1 \| -1\.00 \| 0% \| 0 \/ 0 \/ 0 \/ 1 \|\n\n- Recruiters, top objections: No SSO on <Team> \(1 persona\)\n- Recruiters, unclear: Whether Team has SSO \(1 persona\)/);
  assert.match(markdown, /- Passage: characters 412–437, "Single sign-on \(SAML SSO\)"/);
});

test('the report puts the most severe problem first and folds each persona, every fold open in the file', async () => {
  const report = fixture(1, 2);
  Object.assign(report.frictions[0], { severity: 1, what: 'A small irritation.' });
  Object.assign(report.frictions[1], { severity: 4, what: 'Could not save the job.' });
  const theme = (id: string, severity: number, score: number) => ({
    id, poi_id: 'poi-gym', rank: 1, title: `Theme ${id}`, description: '', named_by: 'judge' as const, trust: 'reported' as const, severity, impact: 1, score,
    personas: 1, frictions: 1, pages: [], elements: [], affected: [], evidence: [], seqs: [], suggestion: null,
  });
  report.themes = [theme('a', 2, 9), theme('b', 3.5, 1)]; // the engine ranks a first; b's median rounds up to a blocker
  const html = await reportFile(report, 'html', thumbnails());
  assert.ok(html.indexOf('Theme b') < html.indexOf('Theme a'), 'the blocker comes before the moderate problem, whatever its score');
  assert.ok(html.indexOf('Could not save the job.') < html.indexOf('A small irritation.'), "a persona's worst friction comes first");
  assert.ok(html.includes('0 of 1 persona reached the goal.'), 'the verdict leads the report');
  assert.equal(html.split('<details').length, html.split(/<details[^>]*open/).length, 'every fold prints open');
});

test('a problem one persona met is a single report, below and apart from one several met, whatever its severity', async () => {
  const report = fixture(1, 2);
  const theme = (id: string, severity: number, personas: number, exposed: number, category?: 'objection') => ({
    id, poi_id: 'poi-gym', rank: 1, title: `Theme ${id}`, description: '', named_by: 'judge' as const, trust: 'reported' as const, severity, impact: 1, score: 1,
    personas, frictions: personas, pages: [], elements: [], affected: [], evidence: [], seqs: [], suggestion: null, ...(category ? { category } : {}),
    prevalence: { personas, exposed, share: personas / exposed, low: 0.1, high: 0.6, level: personas === 1 ? 'single' as const : 'strong' as const },
  });
  report.themes = [theme('lone', 4, 1, 10), theme('shared', 2, 4, 10), theme('doubt', 3, 3, 10, 'objection')];
  const html = await reportFile(report, 'html', thumbnails());
  assert.ok(html.includes('Fix first: <span class="font-medium">Theme shared</span>'), 'the verdict names the problem several met');
  assert.ok(html.includes('4 of 10 personas affected (40%, likely 10%–60%)'), 'the share and its range are spelled out');
  assert.ok(html.indexOf('Theme shared') < html.indexOf('Objections (1)') && html.indexOf('Objections (1)') < html.indexOf('Theme doubt'), 'objections have their own list');
  assert.ok(html.indexOf('Single reports (1)') < html.indexOf('Theme lone'), 'the blocker one persona met is a single report');
  assert.ok(html.includes('What to fix first (1)'));
});

test('comparison HTML leads with the scoped decision, compares every target and keeps valid denominators visible', async () => {
  const report = fixture(5, 1);
  report.comparison = comparisonFixture();
  const html = await reportFile(report, 'html', thumbnails());
  const sections = ['Decision and scope', 'Side-by-side comparison', 'Where each tool fits', 'Next checks before choosing', 'Coverage and limitations', 'Evidence behind the comparison'];
  for (let i = 1; i < sections.length; i++) assert.ok(html.indexOf(sections[i - 1]) < html.indexOf(sections[i]), `${sections[i - 1]} precedes ${sections[i]}`);
  for (const target of report.comparison.study.targets) assert.ok(html.includes(`<th scope="col" class="p-3 align-top font-medium text-stone-900">${target.name}</th>`));
  for (const text of ['Public-site evaluation', '3 / 4', '75% of valid attempts', '2 / 3', '67% of valid attempts', 'Environment blocked', 'Incomplete', 'Invalid task', 'Not attempted', '2 matched persona/task pairs', '3 / 5 eligible episodes assessed · 1 distinct source', 'Vendor claim', 'Unknown', 'Expected benefit (hypothesis)', 'Validate:', 'Evidence excluded from conclusions', 'Preference collection was not performed.']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /At a glance|What to fix first|How each persona did|persona reached the goal/);
  assert.doesNotMatch(html, /<(?:button|select|script)\b/);
  assert.match(html, /href="#comparison-evidence-2"/);
  assert.match(html, /id="comparison-evidence-2"/);
  assert.ok(html.includes('Applicable monthly plan is at most $400.'), 'the frozen assessment rule remains inspectable');
  assert.match(html, /src="data:image\/jpeg;base64,/);
  assert.equal(html.split('<details').length, html.split(/<details[^>]*open/).length, 'all exported details are visible');
});

test('comparison scenarios and access scopes stay separate, with all targets present in each matrix', async () => {
  const report = fixture(1, 0);
  report.comparison = comparisonFixture();
  report.comparison.study.scenarios.push({ id: 'enterprise', name: 'Enterprise scenario', context: '500 employees.', segment_ids: ['seg-a'] });
  report.comparison.study.targets[3].access_scope = 'prototype';
  for (const cell of report.comparison.cells.filter((cell) => cell.target_id === 'target-3')) cell.access_scope = 'prototype';
  report.comparison.cells.push({ ...report.comparison.cells[0], scenario_id: 'enterprise', assessment: 'does_not_meet', summary: 'The applicable plan excludes a 500-person company.', evidence: [] });
  const html = await reportFile(report, 'html', thumbnails());
  assert.ok(html.includes('Enterprise scenario'));
  assert.ok(html.includes('The applicable plan excludes a 500-person company.'));
  assert.ok(html.includes('Prototype evaluation'));
  assert.ok(html.includes('Different access scope'));
  assert.equal(html.split('>Shared criterion</th>').length - 1, 3, 'scenario and access differences get separate matrices');
  for (const target of report.comparison.study.targets) assert.equal(html.split(`<th scope="col" class="p-3 align-top font-medium text-stone-900">${target.name}</th>`).length - 1, 3);
});

test('comparison text and evidence stay escaped, including target names, sources and proposed actions', async () => {
  const report = fixture(1, 0);
  report.comparison = comparisonFixture();
  const attack = '<img src="https://example.test/escape" onerror="alert(1)"><script>bad()</script>';
  report.comparison.study.targets[0].name = attack;
  report.comparison.cells[0].summary = attack;
  report.comparison.cells[0].evidence[0].source = 'javascript:alert(2)';
  report.comparison.cells[0].evidence[0].quote = attack;
  report.comparison.actions[0].action = attack;
  const html = await reportFile(report, 'html', thumbnails());
  assert.doesNotMatch(html, /<script|<img src="https:|href="javascript:/);
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.match(html, /Source: javascript:alert\(2\)/, 'the captured source is inert text');
  assert.doesNotMatch(html, /<[^>]+\b(?:src|href)="(?!data:|#)/);
});

test('the app comparison exposes transcript inspection while keeping the same decision and matrix as export', async () => {
  const report = fixture(1, 0);
  report.comparison = comparisonFixture();
  const { Report } = await vite.ssrLoadModule('/src/Report.tsx') as typeof import('./Report.tsx');
  const html = renderToStaticMarkup(createElement(Report, { report, onInspect: () => {} }));
  assert.ok(html.includes(report.comparison.decision.summary));
  assert.match(html, /<button[^>]*>Inspect Persona 0’s evidence<\/button>/);
  assert.match(html, /aria-label="Comparison matrix:/);
  assert.match(html, /tabindex="0"/);
  assert.doesNotMatch(html, /At a glance|What to fix first/);
});

test('comparison exports deduplicate source claims while retaining every capture and precise blocked cause', async () => {
  const report = fixture(2, 0);
  report.comparison = comparisonFixture();
  const cell = report.comparison.cells[0];
  cell.evidence.push({ ...cell.evidence[0], event_seq: 400, assessment_seq: 401, episode_id: 'repeated-episode', persona_id: 'p-1-1', captured_at: 1000 });
  report.comparison.coverage[0].episodes = [{ episode_id: 'blocked-episode', persona_id: 'p-1-1', outcome: 'blocked_environment', reason: 'Pricing API api.example.test is denied by the configured host policy.', start_seq: 500, finish_seq: 510, evidence_seqs: [] }];
  for (const format of ['html', 'md'] as const) {
    const output = await reportFile(report, format, thumbnails());
    assert.ok(output.includes('Pricing API api.example.test is denied by the configured host policy.'));
    assert.ok(output.includes('400'), 'repeated capture reference survives');
    assert.ok(output.includes('Applicable monthly plan is at most $400.'), 'frozen rubric is exported');
    assert.ok(output.includes('Find the applicable plan, price and supported integrations.'), 'task is exported');
  }
  const html = await reportFile(report, 'html', thumbnails());
  assert.equal(html.split('src="data:image/jpeg;base64,' + btoa(cell.evidence[0].screenshot!)).length - 1, 1, 'the same claim screenshot is shown once');
});

test('owner studies label the focal tool and action owner; legacy comparison votes remain explicitly legacy', async () => {
  const report = fixture(1, 0);
  report.comparison = comparisonFixture();
  report.comparison.study.purpose = 'improve_own_product';
  report.comparison.study.focal_target_id = 'target-0';
  report.comparison.tradeoffs = [{ focal_target_id: 'target-0', other_target_id: 'target-2', scenario_id: 'small-team', task_id: 'evaluate', segment_id: 'seg-a', criterion_id: 'price', result: 'advantage', summary: 'Harbor meets this cost requirement; Northstar exceeds it.', evidence_seqs: [100, 102] }];
  report.comparison.actions[0].owner = 'product_team';
  report.comparison.actions[0].target_id = 'target-0';
  const html = await reportFile(report, 'html', thumbnails());
  for (const text of ['Your tool', 'Your product team', 'Actions for your product and evaluation', 'Focal-tool advantage', 'Harbor meets this cost requirement; Northstar exceeds it.']) assert.ok(html.includes(text));
  delete report.comparison;
  report.comparisons = [{ poi_id: 'competitor', with_poi_id: 'poi-gym', segments: [], answers: [] }];
  const legacy = await reportFile(report, 'html', thumbnails());
  assert.match(legacy, /Legacy comparison:/);
  assert.match(legacy, /At a glance/);
  assert.doesNotMatch(legacy, /Side-by-side comparison/);
});
