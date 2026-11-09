import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import tailwindcss from '@tailwindcss/vite';
import { createServer } from 'vite';
import type { Report, ReportTheme } from '@gnomi/simulation/types.ts';
import { HYPOTHESIS_BANNER } from '@gnomi/simulation/report/build.ts';
import { comparisonFixture } from './comparisonReport.fixture.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRIORITY_NOTE, reportToMarkdown } from '@gnomi/simulation/report/markdown.ts';
import { WHAT_IF_NOTE } from '@gnomi/simulation/report/repeats.ts';

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
    segments: [{ id: 'seg-a', name: 'Recruiters', share: 100, personas: count, outcomes: { done: 0, abandoned: count, budget_exceeded: 0, repeated_failure: 0, model_failed: 0, blocked: 0, incomplete: 0, not_started: 0 }, completion: 0, with_friction: 1, frictions: frictions.length }],
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

test('every export leaves a hidden finding out whole, marks a reworded one, says how many, and carries no control', async () => {
  const report = fixture(2, 1);
  const [gone, kept] = report.frictions;
  Object.assign(gone, { what: 'ZZHIDDEN what', expected: 'ZZHIDDEN expected', quote: 'ZZHIDDEN quote' });
  const theme = (id: string, rank: number, title: string, friction: Report['frictions'][number], edit?: ReportTheme['edit']): ReportTheme => ({
    id, poi_id: 'poi-gym', rank, title, description: `${id} ${edit?.hidden ? 'ZZHIDDEN ' : ''}description`, named_by: 'judge', trust: 'reported', severity: 3, score: 1, personas: 1, frictions: 1, pages: [], elements: [],
    affected: [], seqs: [friction.seq], evidence: [{ ...friction, step_seq: 1, trust: 'reported', signals: [] }], suggestion: { change: `${id} change`, solution: `${id} solution` }, ...(edit ? { edit } : {}),
  });
  report.themes = [
    theme('g1', 1, 'ZZHIDDEN title', gone, { hidden: true, new_title: null, new_description: null }),
    theme('g2', 2, 'ZZORIGINAL title', kept, { hidden: false, new_title: 'Our title', new_description: null }),
  ];
  report.unmatched_edits = [{ title: 'ZZHIDDEN from an older grouping', hidden: true, new_title: null, new_description: null }];
  for (const format of ['html', 'pdf', 'md', 'json'] as const) {
    const file = await reportFile(report, format, thumbnails());
    assert.ok(!file.includes('ZZHIDDEN'), `${format} has no trace of the hidden finding`);
    assert.ok(!file.includes('ZZORIGINAL title'), `${format} has the team's words`);
    assert.ok(file.includes('Our title') && file.includes('g2 description'), `${format} keeps the rest of the finding`);
    if (format === 'json') {
      const { shared, themes } = JSON.parse(file) as Report;
      assert.deepEqual(shared, { hidden: 1, reworded: 1 });
      assert.deepEqual(themes!.map((t) => [t.title, t.reworded, t.edit]), [['Our title', true, undefined]]);
    } else {
      assert.ok(file.includes('hid 1 finding from this copy and reworded 1 finding'), `${format} says so`);
      assert.ok(file.includes('Reworded by the team'), `${format} marks it`);
    }
    if (format === 'html' || format === 'pdf') assert.doesNotMatch(file, /<(?:button|select|script)\b|Hide from exports|Reword for sharing/);
  }
  assert.ok((await reportFile(report, 'html', thumbnails())).includes('Left out of this copy'), 'a persona whose friction went with the finding does not read as having had none');
  const plain = fixture(2, 1);
  assert.equal(await reportFile(plain, 'md', thumbnails()), reportToMarkdown(plain), 'with nothing edited, an export is the report');
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
  assert.equal(html.split('viewBox="0 0 168 64"').length - 1, 2, 'one sentiment line for the POI and one for the theme');
  assert.doesNotMatch(html, /<(?:button|select|script)\b/);
});

test('the box on a finding and the flow render into the export with no script, and the frame shows only over an image', async () => {
  const report = fixture(1, 1);
  const friction = report.frictions[0];
  const evidence = { ...friction, step_seq: 1, trust: 'reported' as const, signals: [] };
  report.themes = [{
    id: 'g1', poi_id: 'poi-gym', rank: 1, title: 'Saving fails', description: 'Save does nothing.', named_by: 'rules', trust: 'reported', severity: 2, score: 0.5, personas: 1, frictions: 1, pages: [], elements: [], affected: [], seqs: [1], suggestion: null,
    evidence: [{ ...evidence, box: { left: 25, top: 50, width: 20, height: 12.5, element: 'button "<Save>"' } }, evidence],
  }];
  report.flows = [{
    poi_id: 'poi-gym', personas: 2, left_out: { pages: 3, ended: 1 },
    pages: [{ page: 'gym.test/jobs', reached: 2, ended: { abandoned: 1 } }, { page: 'gym.test/jobs/new', reached: 1, ended: { done: 1 } }],
    moves: [{ from: 'gym.test/jobs', to: 'gym.test/jobs/new', personas: 1 }],
  }];
  const html = await reportFile(report, 'html', thumbnails());
  assert.equal(html.split('style="left:25%;top:50%;width:20%;height:12.5%"').length - 1, 1, 'one frame, in percent of the image');
  assert.equal(html.split('aria-label="Marked on the screenshot: button &quot;&lt;Save&gt;&quot;"').length - 1, 1, 'it names the element');
  assert.match(html, /\.report-shot:has\(img\) ?> ?\.report-shot-box/, 'without an image there is nothing for it to mark');
  for (const text of ['Where personas went', '2 reached · 1 ended here', '1: 1 gave up', '1: 1 reached the goal', 'gym.test/jobs/new (1)', '3 less visited pages left out, where 1 persona ended.', 'where an episode ended, not why']) assert.ok(html.replaceAll('&quot;', '"').includes(text), text);
  assert.match(html, /<svg role="img" aria-label="Moves of 2 personas between 2 pages\./);
  assert.doesNotMatch(html, /<(?:button|select|script)\b/);
  assert.doesNotMatch(html, /dropped off/i);
});

test('the file groups findings by screen: each lead picture once with its pins, a link to every card, no crop and no switch', async () => {
  const report = fixture(2, 1);
  const evidence = { ...report.frictions[0], step_seq: 1, trust: 'reported' as const, signals: [], screenshot: null };
  const box = (left: number) => ({ left, top: 50, width: 20, height: 10, element: `button "B${left}"` });
  const picture = (page: string, screenshot: string, left?: number) => ({ page, screenshot, ...(left ? { box: box(left) } : {}), persona_id: 'p-1-0', step_seq: 1 });
  const NEW = 'gym.test/jobs/new';
  const JOBS = 'gym.test/jobs';
  const theme = (id: string, title: string, pages: string[], pictures: ReturnType<typeof picture>[]): ReportTheme => ({
    id, poi_id: 'poi-gym', rank: 1, title, description: `${id} description`, named_by: 'judge', trust: 'reported', severity: 2, score: 1, personas: 1, frictions: 1, pages, elements: [],
    ...(pictures.length ? { pictures } : {}), affected: [], seqs: [1], evidence: [evidence], suggestion: null,
  });
  report.themes = [
    theme('a', 'Save is unclear', [NEW], [picture(NEW, 'shots/new.jpg', 10)]),
    theme('b', 'Title field is easy to miss', [NEW], [picture(NEW, 'shots/new.jpg', 30)]),
    theme('c', 'Errors disappear', [NEW, JOBS], [picture(NEW, 'shots/new.jpg', 10), picture(JOBS, 'shots/jobs.jpg')]),
    theme('d', 'Slow everywhere', ['gym.test/a', 'gym.test/b', 'gym.test/c', 'gym.test/d'], [picture('gym.test/a', 'shots/a.jpg')]),
    theme('e', 'Tone feels cold', [], []),
  ];
  report.reach = [{ poi_id: 'poi-gym', started: ['p-1-0', 'p-1-1'], surveyed: [], pages: { [NEW]: ['p-1-0'], [JOBS]: ['p-1-0', 'p-1-1'] } }];
  const html = await reportFile(report, 'html', thumbnails());
  const from = html.indexOf('id="screens-title"');
  const section = html.slice(from, html.indexOf('</section>', from));
  assert.ok(section.includes('Findings by screen'));
  assert.ok(section.indexOf('>/jobs<') < section.indexOf('>/jobs/new<'), 'the page more personas reached comes first');
  assert.ok(section.includes('2 personas reached it'));
  for (const name of ['>Across many screens<', '>Not tied to one screen<']) assert.ok(section.includes(name), name);
  for (const shot of ['shots/new.jpg', 'shots/jobs.jpg']) assert.equal(section.split(`src="data:image/jpeg;base64,${btoa(shot)}"`).length - 1, 1, `${shot} is the lead of its screen, drawn once`);
  assert.equal(section.split('src="data:image/jpeg').length - 1, 2, 'a site-wide or untied finding has no lead picture');
  assert.ok(section.includes('aria-label="Marked 1 and 3 on the screenshot: button &quot;B10&quot;"'), 'findings with one box share a pin');
  assert.ok(section.includes('aria-label="Marked 2 on the screenshot: button &quot;B30&quot;"'));
  const links = [...section.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  assert.equal(links.length, 6, 'a finding on two screens is listed on both');
  for (const id of links) assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} is one finding card`);
  assert.doesNotMatch(html, /class="report-crop"|Group findings|>By priority<|>By screen</);
  const none = fixture(1, 1);
  none.themes = [theme('a', 'Save is unclear', [], [])];
  assert.doesNotMatch(await reportFile(none, 'html', thumbnails()), /Findings by screen/, 'with no screen to name, the section would only repeat the list');
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
  assert.match(markdown, /## Buying survey[\s\S]*\| Recruiters \| 1 \| -1\.00 \| 0% \| 0 \/ 0 \/ 0 \/ 1 \|\n\n- Recruiters, top objections: No SSO on &lt;Team&gt; \(1 persona\)\n- Recruiters, unclear: Whether Team has SSO \(1 persona\)/);
  assert.match(markdown, /- Passage: characters 412–437, "Single sign-on \(SAML SSO\)"/);
});

test('the report puts the most severe problem first and folds each persona, every fold open in the file', async () => {
  const report = fixture(1, 2);
  Object.assign(report.frictions[0], { severity: 1, what: 'A small irritation.' });
  Object.assign(report.frictions[1], { severity: 4, what: 'Could not save the job.' });
  const theme = (id: string, severity: number, rank: number) => ({
    id, poi_id: 'poi-gym', rank, title: `Theme ${id}`, description: '', named_by: 'judge' as const, trust: 'reported' as const, severity, score: 1,
    personas: 1, frictions: 1, pages: [], elements: [], affected: [], evidence: [], seqs: [], suggestion: null,
  });
  report.themes = [theme('a', 2, 2), theme('b', 3.5, 1)]; // the engine ranks the more severe b first
  const html = await reportFile(report, 'html', thumbnails());
  assert.ok(html.indexOf('Theme b') < html.indexOf('Theme a'), 'the engine rank orders problems of the same evidence');
  assert.ok(html.indexOf('Could not save the job.') < html.indexOf('A small irritation.'), "a persona's worst friction comes first");
  assert.match(html, /Reached the goal<\/p><p class="report-stat-value">0 of 1<\/p>/, 'completion stays visible in the overview');
  assert.equal(html.split('<details').length, html.split(/<details[^>]*open/).length, 'every fold prints open');
});

test('a problem one persona met is a single report, below and apart from one several met, whatever its severity', async () => {
  const report = fixture(1, 2);
  const theme = (id: string, severity: number, personas: number, exposed: number, category?: 'objection') => ({
    id, poi_id: 'poi-gym', rank: 1, title: `Theme ${id}`, description: '', named_by: 'judge' as const, trust: 'reported' as const, severity, score: 1,
    personas, frictions: personas, pages: [], elements: [], affected: [], evidence: [], seqs: [], suggestion: null, ...(category ? { category } : {}),
    prevalence: { personas, exposed, share: personas / exposed, low: 0.1, high: 0.6, level: personas === 1 ? 'single' as const : 'strong' as const },
  });
  report.themes = [theme('lone', 4, 1, 10), theme('shared', 2, 4, 10), theme('doubt', 3, 3, 10, 'objection')];
  const whole = await reportFile(report, 'html', thumbnails());
  const html = whole.slice(whole.indexOf('At a glance')); // the summary above it names the top two as well
  assert.ok(html.indexOf('Theme shared') < html.indexOf('Theme lone'), 'the main list leads with the problem several met');
  assert.ok(html.includes('4 of 10 personas affected (40%, likely 10%–60%)'), 'the share and its range are spelled out');
  assert.ok(html.indexOf('Theme shared') < html.indexOf('Reasons for hesitation (1)') && html.indexOf('Reasons for hesitation (1)') < html.indexOf('Theme doubt'), 'objections have their own list');
  assert.ok(html.indexOf('Individual observations (1)') < html.indexOf('Theme lone'), 'the blocker one persona met is a single report');
  assert.ok(html.includes('What to improve <span>1</span>'));
});

test('the share says who read about it first, trust shows its mix, and a competitor never leads the verdict', async () => {
  const report = fixture(1, 1);
  report.pois.push({ id: 'rival', type: 'web', name: 'Rival', start_url: 'http://rival.test/', competitor: true });
  const theme = (id: string, poi_id: string, rank: number) => ({
    id, poi_id, rank, title: `Theme ${id}`, description: '', named_by: 'judge' as const, trust: 'confirmed' as const, trust_counts: { confirmed: 1, observed: 0, reported: 3 },
    severity: 3, score: 1, personas: 4, frictions: 4, heard_first: 2, pages: [], elements: [], affected: [], evidence: [], seqs: [], suggestion: null,
    prevalence: { personas: 2, exposed: 10, share: 0.2, low: 0.06, high: 0.51, level: 'some' as const },
  });
  report.themes = [theme('rival', 'rival', 1), theme('ours', 'poi-gym', 1)];
  const html = await reportFile(report, 'html', thumbnails());
  assert.ok(html.indexOf('Theme ours') < html.indexOf('Competitor findings (1)') && html.indexOf('Competitor findings (1)') < html.indexOf('Theme rival'), "the competitor's problem stays outside the team's list");
  assert.match(html, /2 of 10 personas affected \(20%, likely 6%–51%\)<\/span>, \+2 more after reading the feed/);
  assert.ok(html.includes('1 confirmed, 3 reported'));
});

test('a finding nobody met first-hand does not say everyone read about it, when they remembered it', async () => {
  const report = fixture(1, 1);
  report.themes = [{
    id: 'g1', poi_id: 'poi-gym', rank: 1, title: 'Theme remembered', description: '', named_by: 'judge', trust: 'reported', severity: 3, score: 0, personas: 2, frictions: 2, heard_first: 0, remembered: 2,
    pages: [], elements: [], affected: [], evidence: [], seqs: [], suggestion: null, prevalence: { personas: 0, exposed: 2, share: 0, low: 0, high: 0.66, level: 'none' },
  }];
  const html = await reportFile(report, 'html', thumbnails());
  assert.ok(html.includes('None first-hand: every persona who reported it had read about it in the feed, or was repeating an earlier visit'));
});

test('with several POIs a set-aside theme names its POI, and a competitor\'s does not read as the team\'s own', async () => {
  const report = fixture(1, 1);
  report.pois.push({ id: 'rival', type: 'web', name: 'Rival', start_url: 'http://rival.test/', competitor: true });
  report.themes = [];
  const aside = { id: 'g1', poi_id: 'rival', rank: 0, title: 'Aside', description: '', named_by: 'judge' as const, trust: 'reported' as const, severity: 2, score: 0.1, personas: 1, frictions: 1, pages: [], elements: [], affected: [], evidence: [], seqs: [1], suggestion: null, check: { verdict: 'environment' as const, reason: 'Blocked.' } };
  report.set_aside = [aside];
  const theirs = await reportFile(report, 'html', thumbnails());
  assert.ok(theirs.includes('1 persona, 1 report · Rival (competitor, observed only)'));
  assert.ok(theirs.includes('No shared issues were reported in this run.'));
  assert.ok(!theirs.includes('No shared issues are left.'));
  report.set_aside = [{ ...aside, poi_id: 'poi-gym' }];
  const ours = await reportFile(report, 'html', thumbnails());
  assert.ok(ours.includes('1 persona, 1 report · Gym'));
  assert.ok(ours.includes('No shared issues are left.'));
});

test('the methods name the model behind the evidence check', async () => {
  const report = fixture(1, 1);
  report.methods.models = { judge: { provider: 'deepseek', model: 'deepseek-v4-pro' } };
  assert.ok(!(await reportFile(report, 'html', thumbnails())).includes('evidence check:'));
  report.methods.check_model = { provider: 'openai', model: 'gpt-6.1-sol' };
  assert.ok((await reportFile(report, 'html', thumbnails())).includes('evidence check: openai gpt-6.1-sol'));
});

test('comparison HTML leads with the scoped decision, compares every target and keeps valid denominators visible', async () => {
  const report = fixture(5, 1);
  report.comparison = comparisonFixture();
  const html = await reportFile(report, 'html', thumbnails());
  const sections = ['Decision and scope', 'Side-by-side comparison', 'Where each tool fits', 'Next checks before choosing', 'Coverage and limitations', 'Evidence behind the comparison'];
  for (let i = 1; i < sections.length; i++) assert.ok(html.indexOf(sections[i - 1]) < html.indexOf(sections[i]), `${sections[i - 1]} precedes ${sections[i]}`);
  for (const target of report.comparison.study.targets) assert.ok(html.includes(`<th scope="col">${target.name}</th>`));
  for (const text of ['Public-site evaluation', '3 / 4', '75% of valid attempts', '2 / 3', '67% of valid attempts', 'Environment blocked', 'Incomplete', 'Invalid task', 'Not attempted', '2 matched persona/task pairs', '3 / 5 eligible episodes assessed · 1 distinct source', 'Vendor claim', 'Unknown', 'Expected benefit (hypothesis)', 'Validate:', 'Evidence excluded from conclusions', 'Preference collection was not performed.']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /At a glance|What to fix first|How each persona did|persona reached the goal/);
  assert.doesNotMatch(html, /<(?:button|select|script)\b/);
  assert.match(html, /href="#comparison-evidence-2"/);
  assert.match(html, /id="comparison-evidence-2"/);
  assert.ok(html.includes('Applicable monthly plan is at most $400.'), 'the frozen assessment rule remains inspectable');
  assert.match(html, />Fit for this scope<\/th><td><span class="tone-chip" data-tone="warn">Conditional fit<\/span>/, 'each matrix ends with every tool\'s fit');
  assert.ok(html.includes('A candidate-profile quote does not support a pricing assessment.<span class="text-stone-500"> (1 assessment: #321)'), 'exclusions are grouped by reason');
  assert.ok(!html.includes('No supporting citation'), 'an empty citation list is left out, not announced in every cell');
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
  for (const target of report.comparison.study.targets) assert.equal(html.split(`<th scope="col">${target.name}</th>`).length - 1, 3);
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

test('themes the evidence check set aside fold into their own section, each with its reason, as a model\'s review', async () => {
  const report = fixture(2, 1);
  report.themes = [];
  report.set_aside = [{ id: 'g1', poi_id: 'poi-gym', rank: 0, title: 'The <hiring manager> field', description: 'Rejected.', named_by: 'judge', trust: 'reported', severity: 2, score: 0.1, personas: 1, frictions: 1, pages: [], elements: [], affected: [], evidence: [], seqs: [1], suggestion: null, check: { verdict: 'agent_mistake', reason: 'She typed her own name.' } }];
  const html = await reportFile(report, 'html', thumbnails());
  for (const text of ['Set aside by the evidence check (1)', 'The &lt;hiring manager&gt; field', 'The model’s review points to a persona&#x27;s mistake: She typed her own name.', 'A model reviewed the evidence behind these themes', 'No shared issues are left.']) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /disprov/i);
  assert.ok(!html.includes('1 report ·'), 'one POI needs no naming');
  assert.ok(!(await reportFile(fixture(2, 1), 'html', thumbnails())).includes('Set aside by the evidence check'));
});

test("the HTML export shows a team's study outcome beside its finding, whose it is, and the plan, with no way to change either", async () => {
  const report = fixture(2, 1);
  const prevalence = { personas: 2, exposed: 2, share: 1, low: 0.3, high: 1, level: 'strong' as const };
  const finding = { id: 'g1', poi_id: 'poi-gym', rank: 1, title: 'Save does nothing', description: 'Save fails.', named_by: 'judge' as const, trust: 'reported' as const, severity: 3, score: 0, personas: 2, frictions: 2, pages: [], elements: [], affected: [], evidence: [], seqs: [1], suggestion: null, prevalence, category: 'friction' as const };
  report.themes = [{ ...finding, validation: { status: 'supported', note: 'Five of <six> stalled.', study_date: '2026-10-12', title: 'An older name' } }];
  report.study_count = { of: 1, supported: 1, contradicted: 0, unresolved: 0, not_studied: 0 };
  report.unmatched_outcomes = [{ status: 'contradicted', note: null, study_date: '2026-10-02', title: 'Merged away', poi_id: 'poi-gym' }];
  report.study_plan = { screener: ['Do you hire?'], screener_dropped: 0, left_out: { objections: 0, competitors: 0, set_aside: 0, scan_only: 0, lower_ranked: 0 }, hypotheses: [{ title: 'Save does nothing', poi_id: 'poi-gym', tasks: ['Post a job.'], dropped: 0, observe: ['Watch the button.'] }] };
  const html = await reportFile(report, 'html', thumbnails());
  for (const text of ['Your team&#x27;s study, 12 Oct 2026: supported', 'Five of &lt;six&gt; stalled.', 'Recorded for &quot;An older name&quot;.', 'Of the top 1 finding, your team&#x27;s studies supported 1.', 'Merged away', 'Your team&#x27;s study, 2 Oct 2026: contradicted', 'Do not show them to participants', 'A model wrote this plan', 'Post a job.', 'Watch the button.', 'Kept apart from the simulated numbers above.']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(!html.includes('work, kept apart'), 'the section does not call a generated plan the team\'s work');
  assert.doesNotMatch(html, /<(?:button|select|textarea|input)\b/, 'nothing to record or plan with in a file');
  assert.ok(!(await reportFile(fixture(2, 1), 'html', thumbnails())).includes('Check with real people'), 'with none of it, no section');
});

test('the HTML export opens with the written summary and labels each finding, but no objection or competitor finding', async () => {
  const report = fixture(2, 1);
  report.pois.push({ id: 'poi-rival', type: 'web', name: 'Rival', start_url: 'http://rival.test/', competitor: true });
  const prevalence = { personas: 2, exposed: 2, share: 1, low: 0.3, high: 1, level: 'strong' as const };
  const finding = { id: 'g1', poi_id: 'poi-gym', rank: 1, title: 'Save does nothing', description: 'Save fails.', named_by: 'judge' as const, trust: 'reported' as const, severity: 3, score: 0, personas: 2, frictions: 2, pages: [], elements: [], affected: [], evidence: [], seqs: [1], suggestion: null, prevalence };
  report.themes = [finding, { ...finding, id: 'g2', rank: 2, title: 'Too dear', category: 'objection' }, { ...finding, id: 'g3', poi_id: 'poi-rival', title: 'Rival breaks' }];
  const html = await reportFile(report, 'html', thumbnails());
  const summary = html.indexOf('The biggest problem in this run is “Save does nothing”, met by 2 of 2 personas who tried it.');
  assert.ok(summary > 0 && summary < html.indexOf('aria-label="At a glance"'), 'the summary sits above the glance');
  assert.equal(html.split('>Fix now</span>').length - 1, 1, 'one label: the objection and the competitor have none');
  assert.ok(html.includes(PRIORITY_NOTE), 'the methods say what the labels mean');
});

test('the app comparison exposes transcript inspection while keeping the same decision and matrix as export', async () => {
  const report = fixture(1, 0);
  report.comparison = comparisonFixture();
  const { Report } = await vite.ssrLoadModule('/src/Report.tsx') as typeof import('./Report.tsx');
  const html = renderToStaticMarkup(createElement(Report, { report, onInspect: () => {}, interviews: createElement('section', { id: 'chat-slot' }) }));
  assert.ok(html.includes(report.comparison.decision.summary));
  assert.ok(html.indexOf('id="chat-slot"') > html.indexOf('Next checks before choosing'), 'the personas can be asked after the comparison, before its details');
  assert.match(html, /<button[^>]*>Inspect Persona 0’s evidence<\/button>/);
  assert.match(html, /aria-label="Comparison matrix:/);
  assert.match(html, /tabindex="0"/);
  assert.doesNotMatch(html, /At a glance|What to fix first/);
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

test('a what-if set shows its differences and their limits in the app and the exports, and each run says which side it is', async () => {
  const report = fixture(1, 0);
  const what_if = { pair: 2, post: false, text: 'Saving <is> broken', round: 3, poi_id: 'poi-gym' };
  report.repeat = { group: 'set-a', index: 3, of: 6, what_if };
  const number = (id: 'posted' | 'opinion', label: string, mean: number, lower: number | null, upper: number | null, note: string | null) => ({ id, label, n: 3, mean, lower, upper, note });
  const whatIf = { post: what_if.text, round: 3, pairs: 3, of: 3, note: WHAT_IF_NOTE, numbers: [number('posted', 'People who posted', 1.5, -0.25, 3.25, null), number('opinion', 'Mean opinion at the end, -2 to +2', 0, null, null, 'no variation')] };
  const repeats = { group: 'set-a', of: 3, compared: 3, running: false, incomplete: false, families: ['anthropic'], findings: [], what_if: whatIf };
  const { Report } = await vite.ssrLoadModule('/src/Report.tsx') as typeof import('./Report.tsx');
  const page = renderToStaticMarkup(createElement(Report, { report, repeats, onInspect: () => {} }));
  for (const text of ['Run 3 of 6 in a repeat set, pair 2, without the added post.', 'What-if post', WHAT_IF_NOTE, 'Saving &lt;is&gt; broken', 'Added by your team in round 3', '3 of 3 pairs finished', 'People who posted', '+1.50', '-0.25 to +3.25', 'no variation', 'The runs with the added post are in no count here.']) assert.ok(page.includes(text), text);
  assert.ok((await reportFile(report, 'html', thumbnails(), repeats)).includes(WHAT_IF_NOTE));
  const markdown = await reportFile(report, 'md', thumbnails(), repeats);
  assert.ok(markdown.includes(`> ${WHAT_IF_NOTE}`) && markdown.includes('| People who posted | +1.50 | -0.25 to +3.25 | 3 |'));
  assert.ok(!renderToStaticMarkup(createElement(Report, { report, onInspect: () => {} })).includes('What-if post'), 'no set read, no section');
  const added = { ...report, repeat: { ...report.repeat, index: 4, what_if: { ...what_if, post: true } } };
  assert.ok(renderToStaticMarkup(createElement(Report, { report: added, repeats, onInspect: () => {} })).includes('Run 4 of 6 in a repeat set, pair 2, with the post your team added.'));
});

test('a finding personas with no traits also hit says so in the app and the exports, and a trait-free run says what it is', async () => {
  const report = fixture(1, 0);
  report.repeat = { group: 'set-a', index: 1, of: 3, trait_free: 3 };
  const prevalence = { personas: 1, exposed: 2, share: 0.5, low: 0.1, high: 0.9, level: 'some' as const };
  report.themes = [{ id: 'g1', poi_id: 'poi-gym', rank: 1, title: 'Save does nothing', description: 'Save fails.', named_by: 'judge', trust: 'reported', severity: 2, score: 0, personas: 2, frictions: 2, prevalence, pages: [], elements: [], affected: [], evidence: [], seqs: [], suggestion: null }];
  const finding = { poi_id: 'poi-gym', seen_in: 2, of: 2, families: ['anthropic'], titles: ['Save does nothing'], themes: { 'r-0001': 'g1' } };
  const repeats = { group: 'set-a', of: 2, compared: 2, running: false, incomplete: false, families: ['anthropic'], trait_free: 'r-0003', findings: [{ ...finding, trait_free: true as const }] };
  const note = 'Personas with no traits hit this too, so it may say more about the model than this audience';
  const { Report } = await vite.ssrLoadModule('/src/Report.tsx') as typeof import('./Report.tsx');
  const html = renderToStaticMarkup(createElement(Report, { report, repeats, onInspect: () => {} }));
  for (const text of ['Run 1 of 3 in a repeat set.', '2 runs compared.', 'One more run, of personas with no traits, is in no count here.', 'Appeared in 2 of 2 runs', note]) assert.ok(html.includes(text), text);
  assert.ok((await reportFile(report, 'html', thumbnails(), repeats)).includes(note));
  assert.ok((await reportFile(report, 'md', thumbnails(), repeats)).includes(`- Repeats: Appeared in 2 of 2 runs. ${note}`));

  const plain = { ...repeats, trait_free: undefined, findings: [finding] };
  assert.ok(!renderToStaticMarkup(createElement(Report, { report, repeats: plain, onInspect: () => {} })).includes(note), 'no match, no note');
  const one = { ...repeats, of: 1, compared: 1, findings: [{ ...finding, seen_in: 1, of: 1, trait_free: true as const }] };
  const alone = renderToStaticMarkup(createElement(Report, { report, repeats: one, onInspect: () => {} }));
  assert.ok(alone.includes(note) && !alone.includes('Appeared in'), 'one run has no count to show, and still the note');
  const control = { ...report, repeat: { group: 'set-a', index: 3, of: 3, trait_free: 3 } };
  assert.ok(renderToStaticMarkup(createElement(Report, { report: control, repeats, onInspect: () => {} })).includes('Run 3 of 3 in a repeat set, of personas with no traits.'));
  assert.ok((await reportFile(control, 'md', thumbnails(), repeats)).includes('run 3 of 3 in set set-a, of personas with no traits'));
});

test('a run of a repeat set shows on each finding how many runs it appeared in, and exports say the same', async () => {
  const report = fixture(1, 0);
  report.repeat = { group: 'set-a', index: 1, of: 3 };
  const prevalence = { personas: 1, exposed: 2, share: 0.5, low: 0.1, high: 0.9, level: 'some' as const };
  report.themes = [{ id: 'g1', poi_id: 'poi-gym', rank: 1, title: 'Save does nothing', description: 'Save fails.', named_by: 'judge', trust: 'reported', severity: 2, score: 0, personas: 2, frictions: 2, prevalence, pages: [], elements: [], affected: [], evidence: [], seqs: [], suggestion: null }];
  const repeats = { group: 'set-a', of: 3, compared: 2, running: false, incomplete: true, families: ['anthropic', 'deepseek'], findings: [{ poi_id: 'poi-gym', seen_in: 2, of: 2, families: ['anthropic'], titles: ['Save does nothing', 'The form loses work'], themes: { 'r-0001': 'g1' } }] };
  const { Report } = await vite.ssrLoadModule('/src/Report.tsx') as typeof import('./Report.tsx');
  const html = renderToStaticMarkup(createElement(Report, { report, repeats, onInspect: () => {} }));
  for (const text of ['Run 1 of 3 in a repeat set.', 'Incomplete set: 2 of 3 runs finished.', 'Repeats test robustness inside the simulation', 'Appeared in 2 of 2 runs', 'Only anthropic runs produced this', 'Named in other runs: The form loses work']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /confidence/i);
  const alone = renderToStaticMarkup(createElement(Report, { report, onInspect: () => {} }));
  assert.ok(alone.includes('Run 1 of 3 in a repeat set.'));
  assert.doesNotMatch(alone, /Appeared in/);
  const going = renderToStaticMarkup(createElement(Report, { report, repeats: { ...repeats, running: true, incomplete: false }, onInspect: () => {} }));
  assert.ok(going.includes('2 of 3 runs finished so far.'), 'a set still going is not called incomplete');
  assert.doesNotMatch(going, /Incomplete set/);
  assert.ok((await reportFile(report, 'html', thumbnails(), repeats)).includes('Appeared in 2 of 2 runs'));
  assert.ok((await reportFile(report, 'md', thumbnails(), repeats)).includes('- Repeats: Appeared in 2 of 2 runs. Only anthropic runs produced this'));
  assert.doesNotMatch(await reportFile(report, 'json', thumbnails(), repeats), /Appeared in/, 'the JSON stays the run\'s own report');
});
