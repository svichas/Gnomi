import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gymAssets } from '../../../demo/GymSite/assets.ts';
import { importLocalFile, importText } from '../assets.ts';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, DEMO_NAVIGATOR, DEMO_SURVEY } from '../llm/scripted.ts';
import { createFsBlobStore } from '../log/blobs.ts';
import { openProject } from '../log/sqlite.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import { reportToMarkdown } from '../report/markdown.ts';
import { createRecorder, newRunConfig, startRun } from '../run.ts';
import type { BrowserPool, LlmRequest, Responder } from '../seams.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { influenceEdges } from '../social/influence.ts';
import type { Audience, EventOf, EventType, GnomiEvent, Persona, ProjectConfig, RunSettings, Segment } from '../types.ts';
import { locatePassage, PART_CHARS, textParts } from './text.ts';

test('a long text is read in parts that end at a paragraph break and cover it exactly', () => {
  assert.deepEqual(textParts('A short pricing page.'), [{ start: 0, end: 21 }]);
  const paragraph = `${'word '.repeat(199)}word`; // 999 characters
  const long = Array.from({ length: 120 }, () => paragraph).join('\n\n'); // about 120k characters
  const parts = textParts(long);
  assert.equal(parts.length, 3);
  assert.equal(parts[0].start, 0);
  assert.equal(parts.at(-1)!.end, long.length);
  for (const [i, part] of parts.entries()) {
    assert.ok(part.end - part.start <= PART_CHARS, `part ${i} fits`);
    if (i > 0) assert.equal(part.start, parts[i - 1].end, 'no gap and no overlap');
    if (i < parts.length - 1) assert.equal(long.slice(part.end - 2, part.end), '\n\n', 'cut at a paragraph break');
  }
  assert.deepEqual(textParts('x'.repeat(100), 40), [{ start: 0, end: 40 }, { start: 40, end: 80 }, { start: 80, end: 100 }], 'no break: a hard cut');
});

test('a quoted passage keeps offsets that hold it, is repaired to the nearest occurrence, and is dropped when the text has no such span', () => {
  const text = 'Team: the plan includes SSO.\nBusiness: the plan includes SSO.\nThe FAQ says:   single sign-on is Business only.';
  const q = 'the plan includes SSO';
  const second = text.indexOf(q, 20);
  assert.deepEqual(locatePassage(text, q, second, second + q.length), { start: second, end: second + q.length, text: q });
  assert.deepEqual(locatePassage(text, ` ${q} `, 0, 0), { start: 6, end: 6 + q.length, text: q }, 'trimmed, then the occurrence nearest the given start');
  assert.deepEqual(locatePassage(text, q, 40, 99), { start: second, end: second + q.length, text: q });
  const faq = text.indexOf('The FAQ');
  assert.deepEqual(locatePassage(text, 'The FAQ says: Single sign-on', 0, 0), { start: faq, end: faq + 30, text: 'The FAQ says:   single sign-on' }, 'case and runs of white space differ');
  assert.equal(locatePassage(text, 'SSO is free on every plan', 0, 10), null);
  assert.equal(locatePassage(text, '   ', 0, 3), null);
  assert.equal(locatePassage(text, 'includes SSO', 0, 0), null, 'under three words and 15 characters links nothing');
  assert.ok(locatePassage(text, 'single sign-on', 0, 0) === null && locatePassage(text, 'Business only.', 0, 0) === null, 'two words under 15 characters');
  assert.ok(locatePassage(text, 'single sign-on is', 0, 0), 'three words');
});

// —— Runs on Gym v3's pricing copy (demo/GymSite/design.ts, defect D28: the Team card lists SSO, the table and the FAQ give it to Business) ——

const segment = (id: string, name: string, over: Partial<Segment> = {}): Segment => ({
  id, name, description: '', share: 50, role: null, usage_frequency: 'weekly', typical_goals: [], mobile_share: 0, patience: [3, 3], tech_skill: [3, 3],
  account_state: 'empty', entry: 'direct', goal_override: null, ...over,
});
const audience: Audience = {
  seed: 5, persona_count: 5, segments: [segment('seg-buyers', 'Team leads buying', { kind: 'buyer', share: 60 }), segment('seg-users', 'Planners', { share: 40 })],
  company_size: [20, 500], languages: { en: 1 }, accessibility: { none: 1, low_vision: 0, colour_blind: 0, screen_reader: 0, motor: 0 },
};
const persona = (id: string, segment_id: string | null, over: Partial<Persona> = {}): Persona => ({ ...BUILTIN_PERSONA, id, name: `Persona ${id}`, segment_id, ...over });
const buyers = [persona('b1', 'seg-buyers'), persona('b2', 'seg-buyers'), persona('b3', 'seg-buyers')];
const users = [persona('u1', 'seg-users'), persona('u2', 'seg-users')];

const said = (req: LlmRequest<unknown>) => req.user.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
const of = <K extends EventType>(events: GnomiEvent[], type: K) => events.filter((e): e is EventOf<K> => e.type === type);

/** One scripted run of a project whose only POI is a text; the browser pool refuses, because no text POI may open a page. */
async function runText(opts: { file?: string; text?: string; personas: Persona[]; audience: Audience | null; navigator: Responder; socialiser?: Responder; settings?: Partial<RunSettings> }) {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-text-'));
  const store = openProject(dir);
  try {
    const blobs = createFsBlobStore(dir);
    const asset = opts.file ? await importLocalFile(blobs, opts.file) : await importText(blobs, opts.text!);
    const text = new TextDecoder().decode(await blobs.get(`assets/${asset.id}`));
    const project: ProjectConfig = {
      name: 'Plotline', description: 'Project planning for teams', goal: 'Choose a plan for a team of 20 that needs single sign-on', role: null, audience: opts.audience,
      settings: { ...DEFAULT_SETTINGS, social: false, ...opts.settings }, // social rounds have a test of their own below
      pois: [{ id: 'pricing', type: 'text', name: 'Pricing page', segments: null, asset: asset.id }],
    };
    store.saveProject(project);
    const record = createRecorder(store, () => {});
    const llm = createScriptedGateway({ navigator: opts.navigator, judge: DEMO_JUDGE, author: DEMO_AUTHOR, ...(opts.socialiser && { socialiser: opts.socialiser }) }, record);
    const browsers = { newPage: () => Promise.reject(new Error('a text POI opened a browser page')) } as unknown as BrowserPool;
    const config = store.createRun(newRunConfig(project, { personas: opts.personas, sessions: [], reset: false }));
    const report = await startRun(config, { store, blobs, browsers, llm, record, sessions: null }).done;
    return { report, text, events: store.events(config.run_id) };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a run with a buyer segment over the pricing copy yields sentiment by segment, the buying survey, and ranked confusions whose passages point into the text', async () => {
  const pricing = readFileSync(gymAssets({ defects: 'D28' }).copy.pricing, 'utf8');
  const team = pricing.indexOf('Single sign-on (SAML SSO)'); // D28: the first one is in the Team card
  assert.ok(team < pricing.indexOf('### Business'), 'the seeded defect is in the copy');
  const answer = 'No. Single sign-on (SAML SSO) is part of Business.';
  const faq = pricing.indexOf(answer);
  const asked: string[] = [];
  const navigator: Responder = (req) => {
    asked.push(`${req.persona_id}:${req.purpose}`);
    if (req.purpose === 'survey') return DEMO_SURVEY;
    if (req.purpose === 'buyer_survey') {
      const yes = req.persona_id === 'b1';
      return { objections: ['Not sure single sign-on comes with Team'], unclear: ['Whether SSO is in Team or only in Business'], likes: yes ? ['Clear per-person price'] : [], price: yes ? 'fair' : 'unclear', sentiment: yes ? 1 : -1, confidence: 0.6, would_buy: yes, reason: yes ? 'Team looks right if SSO is in it.' : 'The page contradicts itself on SSO.' };
    }
    assert.equal(req.purpose, 'read_text');
    assert.match(said(req), /^Part 1 of 1\. This is the end of the text\./);
    assert.match(req.shared ?? '', /^A text people are reading: "Pricing page"\. Part 1 of 1\.[\s\S]*<text start="0">\n# Plotline pricing/, 'the whole copy in one part, ahead of the persona');
    assert.doesNotMatch(req.shared ?? '', /Persona/, 'nothing about the persona in the shared part, so every reader reuses one cached copy');
    assert.doesNotMatch(said(req), /<text/);
    assert.match(req.system, req.persona_id!.startsWith('b') ? /weighing whether to buy Plotline/ : /^(?![\s\S]*weighing whether to buy)/);
    assert.doesNotMatch(req.system, /parts read|one look/, 'the engine-enforced budget does not show through');
    return {
      thought: 'Team says SSO, but the FAQ says Business. Which is it?',
      feeling: -1,
      confusions: [
        // Offsets off, as models' often are: repaired to the nearest occurrence of the quote.
        { quote: 'Single sign-on (SAML SSO)', start: 0, end: 4, what: 'The Team plan lists single sign-on', expected: 'SSO in one plan only', severity: 3 },
        { quote: answer, start: faq, end: faq + answer.length, what: 'The FAQ says SSO is Business only', expected: 'The same answer as the Team card', severity: 3 },
        { quote: 'SSO is free on every plan', start: 10, end: 35, what: 'Something the copy does not say', expected: 'Nothing', severity: 1 },
      ],
      opinion: { sentiment: -1, confidence: 0.6, likes: ['Clear prices'], frictions: ['SSO is contradictory'] },
      action: { type: 'done', text: 'Ask sales whether Team includes SSO' },
    };
  };
  const { report, text, events } = await runText({ file: gymAssets({ defects: 'D28' }).copy.pricing, personas: [...buyers, ...users], audience, navigator });
  assert.equal(text, pricing);
  assert.equal(report.status, 'finished', report.stop_reason ?? '');

  // Buyers answer the buying survey, users the usage one; one read each.
  assert.deepEqual(asked.filter((a) => a.endsWith('survey')).sort(), ['b1:buyer_survey', 'b2:buyer_survey', 'b3:buyer_survey', 'u1:survey', 'u2:survey']);
  assert.equal(asked.filter((a) => a.endsWith('read_text')).length, 5);
  assert.deepEqual(report.personas.map((p) => [p.id, p.outcome, p.outcome_text]), [...buyers, ...users].map((p) => [p.id, 'done', 'Ask sales whether Team includes SSO']));
  assert.ok(of(events, 'persona.episode_started').every((e) => e.payload.start_url.startsWith('asset:')));

  // Per-segment sentiment from the users' surveys, and the buyers' own results.
  assert.deepEqual(report.sentiment?.map((s) => [s.name, s.surveyed, s.sentiment]), [['Team leads buying', 0, null], ['Planners', 2, -1]]);
  assert.equal(report.buyers?.length, 1);
  const bought = report.buyers![0];
  assert.deepEqual([bought.poi_id, bought.name, bought.surveyed, bought.would_buy, bought.price], ['pricing', 'Team leads buying', 3, 1 / 3, { low: 0, fair: 1, high: 0, unclear: 2 }]);
  assert.deepEqual(bought.objections.map((o) => [o.text, o.personas]), [['Not sure single sign-on comes with Team', 3]]);
  assert.deepEqual(bought.unclear.map((o) => [o.text, o.personas]), [['Whether SSO is in Team or only in Business', 3]]);

  // Every quoted passage is a span of the text; a quote the text does not hold keeps its friction, at the part that was read.
  const quoted = report.frictions.filter((f) => f.passage?.text);
  assert.equal(report.frictions.length, 15);
  assert.equal(quoted.length, 10);
  for (const f of quoted) assert.equal(text.slice(f.passage!.start, f.passage!.end), f.passage!.text);
  assert.deepEqual([...new Set(quoted.map((f) => f.passage!.start))].sort((a, b) => a - b), [team, faq]);
  for (const f of report.frictions.filter((f) => !f.passage?.text)) assert.deepEqual([f.what, f.passage], ['Something the copy does not say', { start: 0, end: text.length }]);
  assert.ok(of(events, 'persona.friction_reported').every((e) => (e.payload.quote_unverified === true) === !e.payload.passage), 'an unfound quote is flagged');

  // Ranked confusions grouped by passage, with quotes: each theme is one passage, reached by every persona.
  const themes = report.themes!.filter((t) => t.poi_id === 'pricing');
  // Two passages, the unanchored confusion, and the buyers' and the users' survey frictions.
  assert.deepEqual(themes.map((t) => t.rank), [1, 2, 3, 4, 5]);
  const sso = themes.find((t) => t.evidence[0].passage?.start === team)!;
  assert.equal(sso.personas, 5);
  assert.deepEqual(sso.affected.map((a) => [a.name, a.affected, a.reached]), [['Team leads buying', 3, 3], ['Planners', 2, 2]]);
  assert.equal(sso.evidence[0].quote, 'Team says SSO, but the FAQ says Business. Which is it?');

  // The text is named as its POI everywhere a person reads it, never by its stored file.
  const stored = of(events, 'persona.episode_started')[0].payload.start_url.slice('asset:'.length);
  assert.ok(report.frictions.every((f) => f.url === 'Pricing page'));
  assert.ok(themes.every((t) => t.pages.every((page) => page === 'Pricing page') && t.evidence.every((e) => e.url === null || e.url === 'Pricing page')));
  const markdown = reportToMarkdown(report);
  assert.ok(!markdown.includes(stored) && !JSON.stringify(report.themes).includes(stored), 'no stored file name in the report');
  assert.match(markdown, /## Buying survey[\s\S]*\| Team leads buying \| 3 \| -0\.33 \| 33% \| 0 \/ 1 \/ 0 \/ 2 \|/);
  assert.match(markdown, new RegExp(`Passage: characters ${team}–${team + 25}, "Single sign-on \\(SAML SSO\\)"`));
});

test('scripted demo runs read a text too: the demo confusion quotes its first line, and demo buyers answer the buying survey', async () => {
  const { report, text } = await runText({ file: gymAssets({ defects: 'none' }).copy.pricing, personas: [buyers[0], users[0]], audience, navigator: DEMO_NAVIGATOR });
  assert.equal(report.status, 'finished', report.stop_reason ?? '');
  assert.deepEqual(report.frictions.map((f) => f.passage), [{ start: 0, end: 18, text: '# Plotline pricing' }, { start: 0, end: 18, text: '# Plotline pricing' }]);
  assert.equal(text.slice(0, 18), '# Plotline pricing');
  assert.deepEqual(report.buyers?.map((b) => [b.name, b.surveyed, b.price.unclear]), [['Team leads buying', 1, 1]]);
});

test('failed text model calls stop with a technical error, without inventing impatience or survey feedback', async () => {
  const purposes: string[] = [];
  const { report, events } = await runText({
    text: 'A short product pitch.', personas: [users[0]], audience,
    navigator: (req) => { purposes.push(req.purpose!); return {}; },
  });
  assert.equal(report.status, 'stopped');
  assert.match(report.stop_reason ?? '', /error: .*Invalid output twice/);
  assert.deepEqual(purposes, ['read_text', 'read_text'], 'only the bounded gateway retry runs');
  assert.equal(of(events, 'persona.step').length, 0, 'a failed model call is not a persona action');
  assert.equal(of(events, 'signal.budget_exceeded').length, 0, 'model failure did not exhaust persona patience');
  assert.equal(of(events, 'persona.survey').length, 0);
  assert.equal(report.personas[0].outcome, 'incomplete');
});

test('a long text takes one step per part: an impatient reader runs out before the end, a patient one reads on and remembers', async () => {
  const paragraph = `${'Plans and prices. '.repeat(55)}`.trim(); // about 1k characters
  const long = Array.from({ length: 110 }, (_, i) => `## Section ${i + 1}\n\n${paragraph}`).join('\n\n');
  assert.equal(textParts(long).length, 3);
  const reads: Record<string, string[]> = {};
  const navigator: Responder = (req) => {
    if (req.purpose !== 'read_text') return DEMO_SURVEY;
    (reads[req.persona_id!] ??= []).push(said(req));
    const last = /This is the end of the text\./.test(said(req));
    return { thought: `Read part ${reads[req.persona_id!].length}.`, feeling: 0, confusions: [], opinion: { sentiment: 0, confidence: 0.5, likes: [], frictions: [] }, action: { type: last ? 'done' : 'read_on', text: last ? 'Pick Team' : null } };
  };
  const { report, events } = await runText({ text: long, personas: [persona('quick', null, { patience: 1 }), persona('slow', null, { patience: 5 })], audience: null, navigator });
  assert.deepEqual(report.personas.map((p) => [p.id, p.outcome, p.steps]), [['quick', 'budget_exceeded', 1], ['slow', 'done', 3]]);
  assert.match(reads.slow[1], /^Part 2 of 3, characters \d+–\d+ of \d+\. The part is the text quoted above\.\n\nWhat Persona took from the earlier parts:\n1\. Persona thought: "Read part 1\."/);
  assert.match(reads.slow[2], /^Part 3 of 3, [^\n]*This is the end of the text\./);
  const steps = of(events, 'persona.step').filter((e) => e.persona_id === 'slow');
  assert.deepEqual(steps.map((e) => e.payload.action.type), ['read', 'read', 'done']);
  assert.deepEqual(steps.map((e) => e.payload.passage), textParts(long));
});

test('a text read in one sitting is still discussed: the swarm talks while there is something new, about the passages it quotes', async () => {
  const pricing = readFileSync(gymAssets({ defects: 'D28' }).copy.pricing, 'utf8');
  const team = pricing.indexOf('Single sign-on (SAML SSO)');
  const soured = { sentiment: -2, confidence: 0.7, likes: [], frictions: ['SSO may not be in Team after all'] };
  const shared = new Set<string>();
  const navigator: Responder = (req) => {
    if (req.purpose === 'survey') return DEMO_SURVEY;
    if (req.purpose === 'buyer_survey') return { objections: [], unclear: [], likes: [], price: 'fair', sentiment: 0, confidence: 0.5, would_buy: true, reason: 'Fine.' };
    shared.add(req.shared ?? '');
    return {
      thought: 'Team lists SSO.', feeling: 0,
      confusions: req.persona_id === 'b1' ? [{ quote: 'Single sign-on (SAML SSO)', start: team, end: team + 25, what: 'SSO is listed twice', expected: 'One plan with SSO', severity: 3 }] : [],
      opinion: { sentiment: 1, confidence: 0.5, likes: ['Clear prices'], frictions: [] },
      action: { type: 'done', text: 'Pick Team' },
    };
  };
  const prompts: LlmRequest<unknown>[] = [];
  const quiet = { thought: 'Nothing to add.', action: 'nothing', post_id: null, text: null, reaction: null, about_poi_id: null, opinion_updates: [] };
  const socialiser: Responder = (req) => {
    prompts.push(req);
    const feed = [...said(req).matchAll(/^\[post (\S+)\]/gm)].map((m) => m[1]);
    if (req.persona_id === 'b1' && req.round === 1) return { ...quiet, action: 'post', text: 'Team says SSO, the FAQ says Business only.', about_poi_id: 'pricing' };
    if (req.persona_id === 'u1' && feed.includes('r1-b1')) return { ...quiet, action: 'react', post_id: 'r1-b1', reaction: 'agree', opinion_updates: [{ poi_id: 'pricing', ...soured, post_ids: ['r1-b1'] }] };
    return quiet;
  };
  const { report, events } = await runText({ file: gymAssets({ defects: 'D28' }).copy.pricing, personas: [...buyers, ...users], audience, navigator, socialiser, settings: { social: true, rounds: 5 } });
  assert.equal(report.status, 'finished', report.stop_reason ?? '');
  assert.equal(shared.size, 1, 'every reader sent the same shared part');

  // Everyone read in round 1; the swarm then talked in round 1 and, about b1's post, in round 2; round 3 had nothing new.
  assert.deepEqual(of(events, 'run.round_started').map((e) => e.round), [1, 2]);
  assert.deepEqual(prompts.map((r) => r.round), [1, 1, 1, 1, 1, 2, 2, 2, 2], 'each persona once in round 1, then only the four who had a new post to read');
  assert.ok(!prompts.some((r) => r.round === 2 && r.persona_id === 'b1'), 'nothing new for the author');
  assert.deepEqual(influenceEdges(events).map((e) => [e.from, e.to, e.poi_id, e.delta]), [['b1', 'u1', 'pricing', -3]]);

  // The prompts say how each persona met the text, which passage its confusion was about, and what each post is about.
  const b1 = prompts.find((r) => r.persona_id === 'b1')!;
  assert.match(b1.system, /^This is Persona b1\. Persona is weighing whether to buy Plotline at work: reading "Pricing page"\./);
  assert.match(said(b1), /- "SSO is listed twice", about the passage "Single sign-on \(SAML SSO\)"/);
  assert.match(said(b1), /What Persona was thinking most recently:\n- "Team lists SSO\."/);
  const u1 = prompts.find((r) => r.persona_id === 'u1' && r.round === 2)!;
  assert.match(u1.system, /^This is Persona u1\. Persona is trying Plotline at work: reading "Pricing page"\./);
  assert.match(said(u1), /\[post r1-b1\] Persona b1 \(about Pricing page\): "Team says SSO, the FAQ says Business only\."/);
});
