import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Report, ReportPersona, ReportTheme } from '../types.ts';
import { HYPOTHESIS_BANNER } from './build.ts';
import { prevalence } from './themes.ts';
import { writtenSummary } from './summary.ts';

const person = (i: number, outcome: ReportPersona['outcome'] = 'done'): ReportPersona => ({ id: `p-${i}`, name: `Persona ${i}`, segment_id: 'rec', device: 'desktop', outcome, outcome_text: null, steps: 1, frictions: 0 });

const theme = (over: Partial<ReportTheme> = {}): ReportTheme => ({
  id: 'g1',
  poi_id: 'poi-app',
  rank: 1,
  title: 'Save does nothing',
  description: 'Every recruiter pressed Save and nothing changed on the page.',
  named_by: 'judge',
  category: 'friction',
  prevalence: prevalence(3, 12),
  trust: 'confirmed',
  severity: 3,
  score: 0.3,
  personas: 3,
  frictions: 4,
  pages: ['gym.test/jobs/new'],
  elements: [],
  affected: [
    { segment_id: 'hm', name: 'Hiring managers', affected: 1, reached: 4, rate: 0.25 },
    { segment_id: 'rec', name: 'Recruiters', affected: 2, reached: 5, rate: 0.4 },
    { segment_id: 'admins', name: 'Admins', affected: 0, reached: 3, rate: 0 },
  ],
  evidence: [],
  seqs: [1],
  suggestion: null,
  ...over,
});

const report = (over: Partial<Report> = {}): Report => ({
  run_id: 'r-0001',
  status: 'finished',
  stop_reason: null,
  goal: 'Post a job',
  pois: [{ id: 'poi-app', type: 'web', name: 'Gym', start_url: 'http://gym.test/' }],
  personas: Array.from({ length: 12 }, (_, i) => person(i)),
  segments: [],
  weighted: { completion: 1, with_friction: 0 },
  steps: 12,
  frictions: [],
  themes: [theme()],
  cost_usd: 0,
  llm_calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  started_at: 0,
  ended_at: 1,
  duration_ms: 1,
  banner: HYPOTHESIS_BANNER,
  methods: {} as Report['methods'],
  ...over,
});

const say = (over: Partial<Report> = {}) => writtenSummary(report(over)) ?? '';

test('a normal run names the biggest problem, who it affects and what to look at next', () => {
  const second = theme({ id: 'g2', rank: 2, title: 'Salary is hard to find', prevalence: prevalence(2, 12), personas: 2, score: 0.1 });
  assert.equal(
    say({ themes: [theme(), second] }),
    'The biggest problem in this run is “Save does nothing”, met by 3 of 12 personas who reached the page. It came up among Recruiters (2 of 5 personas) and Hiring managers (1 of 4 personas). Next, look at “Salary is hard to find”.',
  );
});

test('with nothing else to look at, it points at the evidence and at real people', () => {
  assert.match(say(), /Next, open its evidence, then check it with real people\.$/);
});

test('a theme on several pages counts who reached those pages, and a long list of segments is cut', () => {
  const affected = ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ segment_id: name, name, affected: 1, reached: i + 1, rate: 1 / (i + 1) }));
  const text = say({ themes: [theme({ pages: ['gym.test/a', 'gym.test/b'], affected })] });
  assert.match(text, /who reached its pages/);
  assert.match(text, /A \(1 of 1 persona\), B \(1 of 2 personas\), C \(1 of 3 personas\), and 2 more segments\./);
});

test('no themes says so, without reading the silence as a working product', () => {
  assert.equal(say({ themes: [] }), 'No friction theme came up on your product, which does not show that it works for real people. Next, look at how far each persona got.');
});

test('every theme set aside by the evidence check is a model\'s review, and the reader is sent to its reasons', () => {
  const aside = theme({ rank: 0, check: { verdict: 'agent_mistake', reason: 'She typed her own name.' } });
  const text = say({ themes: [], set_aside: [aside, { ...aside, id: 'g2' }] });
  assert.match(text, /^The evidence check set aside all 2 friction themes as a persona's mistake or the test setup\. That is one model's review, so a real problem can be among them\. Next, read the reason given for each\.$/);
  assert.match(say({ themes: [], set_aside: [aside] }), /set aside the one friction theme as/);
  assert.doesNotMatch(say({ themes: [], set_aside: [aside] }), /No friction theme/);
});

test('a run that stopped early says how much it covers, with or without themes', () => {
  const personas = [...Array.from({ length: 3 }, (_, i) => person(i, 'incomplete')), ...Array.from({ length: 9 }, (_, i) => person(i + 3, 'not_started'))];
  const opening = 'The run did not finish: 3 of 12 personas started, so this covers only what they got to.';
  assert.ok(say({ status: 'stopped', stop_reason: 'cost_budget: the $1.67 recorded-cost budget was reached', personas }).startsWith(`${opening} The biggest problem`));
  assert.ok(say({ status: 'stopped', stop_reason: 'user', personas, themes: [] }).startsWith(`${opening} No friction theme`));
});

test('one persona is shown as one persona, not as a pattern', () => {
  const text = say({
    personas: [person(0)],
    themes: [theme({ prevalence: prevalence(1, 1), personas: 1, frictions: 1, affected: [{ segment_id: 'rec', name: 'Recruiters', affected: 1, reached: 1, rate: 1 }] })],
  });
  assert.match(text, /met by 1 of 1 persona who reached the page\. That is one persona, so it is worth a look but not yet a pattern\. It came up among Recruiters \(1 of 1 persona\)\./);
});

test('the top theme comes from the team\'s own products by evidence, never from a competitor', () => {
  const pois: Report['pois'] = [
    { id: 'poi-app', type: 'web', name: 'Gym', start_url: 'http://gym.test/' },
    { id: 'poi-pricing', type: 'text', name: 'Pricing', start_url: null },
    { id: 'poi-rival', type: 'web', name: 'Rival', start_url: 'http://rival.test/', competitor: true },
  ];
  const single = theme({ title: 'One persona on the first POI', prevalence: prevalence(1, 12), personas: 1 });
  const strong = theme({ id: 'g2', poi_id: 'poi-pricing', title: 'The plans read alike', severity: 2 });
  const rival = theme({ id: 'g3', poi_id: 'poi-rival', title: 'Rival checkout breaks', prevalence: prevalence(12, 12), severity: 4, personas: 12 });
  const text = say({ pois, themes: [rival, single, strong] });
  assert.match(text, /The biggest problem in this run is “The plans read alike” on Pricing, met by 3 of 12 personas who read the text\./);
  assert.match(text, /Next, look at “One persona on the first POI” on Gym\.$/);
  assert.doesNotMatch(text, /Rival/);
  assert.equal(say({ pois, themes: [rival] }), say({ pois, themes: [] }), 'a run whose only themes are a competitor\'s has none of the team\'s');
});

test('one product beside a competitor needs no naming', () => {
  const pois: Report['pois'] = [...report().pois, { id: 'poi-rival', type: 'web', name: 'Rival', start_url: 'http://rival.test/', competitor: true }];
  assert.match(say({ pois }), /“Save does nothing”, met by/);
});

test('only objections leads with the top one, as a reason to hesitate and not a problem', () => {
  const objection = (over: Partial<ReportTheme>) => theme({ category: 'objection', pages: [], ...over });
  const text = say({ themes: [objection({ title: 'It costs too much' }), objection({ id: 'g2', title: 'No annual plan', prevalence: prevalence(2, 12), personas: 2 })] });
  assert.match(text, /^No friction theme came up on your product, which does not show that it works for real people\. The top objection is “It costs too much”, raised by 3 of 12 personas who tried it\./);
  assert.match(text, /Next, look at “No annual plan”\.$/);
  assert.doesNotMatch(text, /biggest problem/);
});

test('a text or a design has no page to reach', () => {
  const on = (type: 'text' | 'design') => say({ pois: [{ id: 'poi-app', type, name: 'Pricing', start_url: null }], themes: [theme({ pages: [] })] });
  assert.match(on('text'), /3 of 12 personas who read the text\./);
  assert.match(on('design'), /3 of 12 personas who saw the design\./);
});

test('a web theme of survey answers alone has no page either', () => {
  assert.match(say({ themes: [theme({ pages: [] })] }), /3 of 12 personas who tried it\./);
});

test('a report from before prevalence gives the persona count alone', () => {
  const old = theme({ prevalence: undefined, category: undefined, personas: 4 });
  assert.match(say({ themes: [old] }), /“Save does nothing”, met by 4 personas\./);
  assert.match(say({ themes: [{ ...old, personas: 1 }] }), /met by 1 persona\. That is one persona/);
  assert.equal(writtenSummary({ ...report(), themes: undefined }), null, 'a report older than themes has nothing to summarise');
});

test('a theme nobody met first-hand says so', () => {
  const heard = theme({ prevalence: prevalence(0, 12), personas: 2, heard_first: 2, affected: [{ segment_id: 'rec', name: 'Recruiters', affected: 0, reached: 5, rate: 0 }] });
  assert.match(say({ themes: [heard] }), /“Save does nothing”, which no persona met first-hand: 2 personas reported it only after reading about it in the feed\. Next,/);
});

test('a theme with no affected segment skips who it affects', () => {
  const built = [{ segment_id: null, name: 'Built-in persona', affected: 3, reached: 12, rate: 0.25 }];
  for (const affected of [[], built]) {
    assert.equal(say({ themes: [theme({ affected })] }), 'The biggest problem in this run is “Save does nothing”, met by 3 of 12 personas who reached the page. Next, open its evidence, then check it with real people.');
  }
});

test('it never claims more than a simulation can, and never repeats a theme\'s description', () => {
  const aside = theme({ rank: 0, check: { verdict: 'environment', reason: 'The fixture was empty.' } });
  const texts = [say(), say({ themes: [] }), say({ themes: [], set_aside: [aside] }), say({ status: 'stopped', themes: [] }), say({ themes: [theme({ category: 'objection' })] }), say({ themes: [theme({ prevalence: undefined })] })];
  for (const text of texts) {
    assert.doesNotMatch(text, /validated|confidence|proven|users? said/i);
    assert.ok(!text.includes(theme().description), text);
  }
});
