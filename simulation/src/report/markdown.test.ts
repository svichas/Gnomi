import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Report, ReportTheme } from '../types.ts';
import { HYPOTHESIS_BANNER } from './build.ts';
import { missingUsageText, reportToMarkdown } from './markdown.ts';

const url = 'http://localhost:3001/jobs/new';

const report: Report = {
  run_id: 'r-0001',
  status: 'finished',
  stop_reason: null,
  goal: 'Post a job for a backend engineer',
  pois: [{ id: 'poi-gym', type: 'web', name: 'Gym', start_url: 'http://localhost:3001/' }],
  personas: [
    { id: 'p-1-01', name: 'Ana Ruiz', job_title: 'Recruiter', segment_id: 'seg-a', device: 'desktop', outcome: 'done', outcome_text: 'Posted the job.', steps: 2, frictions: 2 },
    { id: 'p-1-02', name: 'Ben Okoro', job_title: 'Recruiter', segment_id: 'seg-a', device: 'desktop', outcome: 'abandoned', outcome_text: 'Gave up.', steps: 1, frictions: 1 },
    { id: 'p-2-01', name: 'Eli Marsh', job_title: 'Hiring manager', segment_id: 'seg-b', device: 'mobile', outcome: 'blocked', outcome_text: 'Sign-in page.', steps: 1, frictions: 1 },
  ],
  segments: [
    {
      id: 'seg-a',
      name: 'Recruiters',
      share: 60,
      personas: 2,
      outcomes: { done: 1, abandoned: 1, budget_exceeded: 0, repeated_failure: 0, model_failed: 0, blocked: 0, incomplete: 0, not_started: 0 },
      completion: 0.5,
      with_friction: 1,
      frictions: 3,
    },
    {
      id: 'seg-b',
      name: 'Hiring managers',
      share: 40,
      personas: 1,
      outcomes: { done: 0, abandoned: 0, budget_exceeded: 0, repeated_failure: 0, model_failed: 0, blocked: 1, incomplete: 0, not_started: 0 },
      completion: 0,
      with_friction: 1,
      frictions: 1,
    },
  ],
  weighted: { completion: 0.3, with_friction: 1 },
  steps: 4,
  frictions: [
    {
      seq: 4,
      persona_id: 'p-1-01',
      persona_name: 'Ana Ruiz',
      segment_id: 'seg-a',
      step_no: 1,
      severity: 2,
      what: 'The Save button is ambiguous.',
      expected: 'A button that says what it does.',
      url,
      quote: 'Is this posting or saving?',
      screenshot: 'runs/r-0001/shots/p-1-01-0001.jpg',
    },
    {
      seq: 6,
      persona_id: 'p-2-01',
      persona_name: 'Eli Marsh',
      segment_id: 'seg-b',
      step_no: 1,
      severity: 3,
      what: 'The sign-in page is confusing.',
      expected: 'A clear sign-in step.',
      url,
      quote: 'Where do I log in?',
      screenshot: null,
    },
    {
      seq: 9,
      persona_id: 'p-1-01',
      persona_name: 'Ana Ruiz',
      segment_id: 'seg-a',
      step_no: 2,
      severity: 2,
      what: 'The required field gives\nno error.',
      expected: 'An error under the field.',
      url,
      quote: 'Nothing happened.',
      screenshot: null,
    },
    {
      seq: 12,
      persona_id: 'p-1-02',
      persona_name: 'Ben Okoro',
      segment_id: 'seg-a',
      step_no: 1,
      severity: 4,
      what: 'The form is hidden.',
      expected: 'The form in plain view.',
      url,
      quote: 'I cannot see it.',
      screenshot: 'runs/r-0001/shots/p-1-02-0001.jpg',
    },
  ],
  cost_usd: 0.75,
  llm_calls: 2,
  input_tokens: 2000,
  output_tokens: 400,
  started_at: 1000,
  ended_at: 9000,
  duration_ms: 8000,
  banner: HYPOTHESIS_BANNER,
  methods: {
    seed: 99,
    roles: ['recruiter'],
    models: { navigator: { provider: 'anthropic', model: 'claude-haiku-5-5' } },
    budgets: { cost_usd: 5, wall_clock_min: 60, concurrency: 12 },
    allowed_hosts: ['localhost'],
    blocked_requests: [],
    blocked: [],
    tripwires: [],
    reset: null,
    concurrency_changes: [],
  },
};

test('reportToMarkdown carries the banner, the goal, the segment table and the totals', () => {
  const md = reportToMarkdown(report);
  assert.ok(md.startsWith('# Gnomi report: Post a job for a backend engineer\n'));
  for (const expected of [
    HYPOTHESIS_BANNER,
    '| Segment | Share | Personas | Completion | Ran into friction |',
    '| Recruiters | 60% | 2 | 50% | 100% |',
    '| Hiring managers | 40% | 1 | 0% | 100% |',
    '**Weighted by share:** completion 30%, with friction 100%. **Unweighted:** completion 33%.',
    '- Recorded cost: $0.7500. Writing the personas is recorded separately and is not included in this cost.',
    '- Tokens: 2000 in, 400 out',
    '- LLM calls: 2',
    '- Duration: 8.0 s',
  ]) {
    assert.ok(md.includes(expected), expected);
  }
});

test('report export distinguishes recorded spend from calls with missing provider usage', () => {
  const md = reportToMarkdown({ ...report, unreported_usage_calls: 2 });
  assert.match(md, /Recorded cost: \$0\.7500/);
  assert.match(md, /2 model calls did not report complete usage/);
  assert.match(md, /Canceled or failed requests may still incur provider charges/);
  assert.match(md, /Actual charges may exceed the recorded cost/);
  assert.doesNotMatch(reportToMarkdown(report), /did not report complete usage/);
  assert.doesNotMatch(reportToMarkdown({ ...report, unreported_usage_calls: 0 }), /did not report complete usage/);
  assert.match(reportToMarkdown({ ...report, unreported_usage_calls: 1 }), /1 model call did not report complete usage/);
});

test('frictions are grouped by segment, then persona, and numbered across the groups', () => {
  const md = reportToMarkdown(report);
  for (const expected of [
    '### Recruiters',
    '**Ana Ruiz** (done)',
    '1. Step 1, severity 2: The Save button is ambiguous.',
    '   - Expected: A button that says what it does.',
    '   - Quote: "Is this posting or saving?"',
    '   - Screenshot: runs/r-0001/shots/p-1-01-0001.jpg',
    '2. Step 2, severity 2: The required field gives no error.',
    '**Ben Okoro** (abandoned)',
    '3. Step 1, severity 4: The form is hidden.',
    '### Hiring managers',
    '**Eli Marsh** (blocked)',
    '4. Step 1, severity 3: The sign-in page is confusing.',
    '   - Screenshot: none',
  ]) {
    assert.ok(md.includes(expected), expected);
  }
  const at = (text: string) => md.indexOf(text);
  assert.ok(at('### Recruiters') < at('**Ana Ruiz**'));
  assert.ok(at('**Ana Ruiz**') < at('**Ben Okoro**'));
  assert.ok(at('**Ben Okoro**') < at('### Hiring managers'));
});

test('reportToMarkdown says so when a run reported no frictions', () => {
  assert.ok(reportToMarkdown({ ...report, frictions: [] }).includes('No frictions reported.'));
});

test('the methods appendix lists seed, models, budgets and concurrency changes, with blocks and resets', () => {
  const md = reportToMarkdown({
    ...report,
    methods: {
      seed: 99,
      roles: ['recruiter', 'admin'],
      models: {
        navigator: { provider: 'openai', model: 'gpt-6-luna' },
        judge: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      },
      budgets: { cost_usd: 2.5, wall_clock_min: 30, concurrency: 8 },
      allowed_hosts: ['localhost', 'cdn.example.com'],
      blocked_requests: [{ host: 'ads.example.net', count: 3 }],
      blocked: [{ persona_id: 'p-2-01', step_no: 4, reason: 'captcha', detail: 'reCAPTCHA on the sign-in page', resumed: true }],
      tripwires: [{ kind: 'live_payment_key', detail: 'pk_live_ on /checkout' }],
      reset: { url: 'https://staging.example/reset', status: 200, error: null },
      concurrency_changes: [{ concurrency: 4, reason: 'rate limited by anthropic' }],
    },
  });
  assert.ok(md.indexOf('## Methods') > md.indexOf('## Cost and time'));
  for (const expected of [
    '- Seed: 99',
    '- Roles: recruiter, admin',
    '- Models: navigator gpt-6-luna (openai); judge claude-sonnet-5-5 (anthropic)',
    '- Budgets: $2.50 cost, 30 min wall clock, concurrency 8',
    '- Concurrency changes: 4 (rate limited by anthropic)',
    '- Allowed hosts: localhost, cdn.example.com',
    '- Blocked requests: ads.example.net (3)',
    '- Blocked at step 4, persona p-2-01 (captcha, resumed): reCAPTCHA on the sign-in page',
    '- Tripwire (live_payment_key): pk_live_ on /checkout',
    '- Reset hook: https://staging.example/reset, HTTP 200',
  ]) {
    assert.ok(md.includes(expected), expected);
  }
});

test('the methods appendix says what did not happen', () => {
  const md = reportToMarkdown({
    ...report,
    methods: {
      ...report.methods,
      roles: [],
      models: {},
      concurrency_changes: [],
      reset: { url: 'https://staging.example/reset', status: null, error: 'ECONNREFUSED' },
    },
  });
  for (const expected of [
    '- Roles: none, browsing logged out',
    '- Models: none called',
    '- Concurrency changes: none',
    '- Blocked requests: none',
    '- Blocked personas: none',
    '- Tripwires: none',
    '- Reset hook: https://staging.example/reset, failed: ECONNREFUSED',
  ]) {
    assert.ok(md.includes(expected), expected);
  }
  assert.ok(reportToMarkdown(report).includes('- Reset hook: not called'));
});

const theme: ReportTheme = {
  id: 'g1+g3',
  poi_id: 'poi-gym',
  rank: 1,
  title: 'Saving a job\nfails',
  description: 'Save does nothing for most recruiters.',
  named_by: 'judge',
  trust: 'confirmed',
  severity: 3,
  score: 2.4,
  personas: 2,
  frictions: 3,
  pages: ['localhost:3001/jobs/new'],
  elements: ['button "Save"'],
  affected: [
    { segment_id: 'seg-a', name: 'Recruiters', affected: 2, reached: 2, rate: 1 },
    { segment_id: 'seg-b', name: 'Hiring managers', affected: 0, reached: 0, rate: 0 },
  ],
  evidence: [
    { seq: 4, step_seq: 3, persona_id: 'p-1-01', persona_name: 'Ana Ruiz', segment_id: 'seg-a', step_no: 1, url, severity: 3, trust: 'confirmed', what: 'Save does nothing', quote: 'Is this posting or saving?', screenshot: 'runs/r-0001/shots/p-1-01-0001.jpg', signals: ['failed_action'] },
    { seq: 20, step_seq: null, persona_id: 'p-1-02', persona_name: 'Ben Okoro', segment_id: 'seg-a', step_no: null, url: null, severity: 2, trust: 'reported', what: 'Saving felt broken', quote: '', screenshot: null, signals: [] },
  ],
  seqs: [4, 5, 20],
  suggestion: { change: 'Make Save submit the job.', solution: 'Submit the form and show the saved job.' },
};

test('themes carry rank, trust, affected share, evidence with event links and labelled suggestions', () => {
  const md = reportToMarkdown({ ...report, themes: [theme], sentiment: [], went_well: [] });
  for (const expected of [
    '## Themes',
    '### 1. Saving a job fails',
    '- Trust: confirmed (a self-report backed by an objective signal)',
    '- Severity 3 of 4, score 2.40, 2 personas, 3 frictions',
    '- Affected first-hand by segment: Recruiters 2 of 2 (100%)',
    '- Elements: button "Save"',
    '- Events: #4, #5, #20',
    '1. Ana Ruiz (step 1, severity 3, confirmed; signals: failed_action): Save does nothing',
    '   - Event: #4',
    '2. Ben Okoro (survey, severity 2, reported): Saving felt broken\n   - Screenshot: none',
    '**Suggested change (generated suggestion):** Make Save submit the job.',
    '**Possible solution (generated suggestion):** Submit the form and show the saved job.',
  ]) {
    assert.ok(md.includes(expected), expected);
  }
  assert.ok(md.indexOf('## Themes') < md.indexOf('## Frictions'));
  assert.ok(reportToMarkdown({ ...report, themes: [] }).includes('No themes. Small-target and backtrack signals do not make one alone'));  const shared = { personas: 1, exposed: 2, share: 0.5, low: 0.09, high: 0.91, level: 'single' as const };
  const echoed = (heard_first: number) => reportToMarkdown({ ...report, themes: [{ ...theme, prevalence: shared, heard_first }], sentiment: [], went_well: [] });
  assert.ok(echoed(1).includes('95% range 9%–91%); 1 more reported it only after reading about it in the feed'), 'heard-first personas sit beside the share');
  assert.ok(!echoed(0).includes('reading about it in the feed'));
  const mixed = reportToMarkdown({ ...report, themes: [{ ...theme, trust_counts: { confirmed: 1, observed: 0, reported: 3 } }] });
  assert.ok(mixed.includes('- Trust: 1 confirmed, 3 reported\n'), 'the trust mix, not the best member');
  assert.ok(mixed.includes("among this run's simulated personas, assuming independent personas; not an estimate of real users"));
});

test("a competitor's section with no themes does not point at the undersized-target audit, which covers only the team's product", () => {
  const pois = [...report.pois, { id: 'poi-new', type: 'web', name: 'New site', start_url: null }, { id: 'poi-rival', type: 'web', name: 'Rival', start_url: null, competitor: true }] as Report['pois'];
  const md = reportToMarkdown({ ...report, pois, themes: [theme] });
  const section = (from: string, to: string) => md.slice(md.indexOf(from), md.indexOf(to, md.indexOf(from)));
  assert.ok(section('### New site', '### Rival').includes('any undersized targets on your product are listed under Methods.'));
  const rival = section('### Rival (competitor, observed only)', '\n## ');
  assert.ok(rival.includes('No themes. Small-target and backtrack signals do not make one alone.'));
  assert.ok(!rival.includes('Methods'));
});

test('sentiment, what went well and the analysis appendix appear when the report has them, and legacy reports skip them', () => {
  const md = reportToMarkdown({
    ...report,
    sentiment: [{ segment_id: 'seg-a', name: 'Recruiters', surveyed: 2, sentiment: 0.5, would_continue: 0.5 }, { segment_id: 'seg-b', name: 'Hiring managers', surveyed: 0, sentiment: null, would_continue: 0 }],
    went_well: [{ text: 'Clear pricing', count: 2, personas: 2, seqs: [7, 9] }],
    methods: { ...report.methods, signal_thresholds: { loop_visits: 3 }, limitations: ['Suggested changes cover 1 of 2 themes.'] },
  });
  for (const expected of [
    '| Segment | Answers | Mean sentiment | Would continue |',
    '| Recruiters | 2 | 0.50 | 50% |',
    '| Hiring managers | 0 | no answers | - |',
    '## What went well',
    '1. Clear pricing (2 mentions by 2 personas)',
    '- Signal thresholds: loop_visits 3',
    '- Limitation: Suggested changes cover 1 of 2 themes.',
  ]) {
    assert.ok(md.includes(expected), expected);
  }
  const legacy = reportToMarkdown(report);
  for (const absent of ['## Themes', '## Sentiment', '## What went well', 'Signal thresholds', 'Undersized', 'Limitation']) assert.ok(!legacy.includes(absent), absent);
});

test('page and model text cannot add HTML, images or links to the export, and evidence pages lose their query strings', () => {
  const hostile = '<img src="https://t.example/p.gif"> ![x](https://t.example/i.png) [Verify your account](https://phish) `x` \\[';
  const page = 'http://localhost:3001/reset?token=s3cret#t';
  const md = reportToMarkdown({
    ...report,
    themes: [{ ...theme, description: hostile, pages: ['localhost:3001/[a](b)'], evidence: [{ ...theme.evidence[0], quote: hostile, url: page }] }],
    frictions: [{ ...report.frictions[0], what: hostile, url: page }],
  });
  assert.ok(md.includes('&lt;img src="https://t.example/p.gif"&gt; !\\[x\\](https://t.example/i.png) \\[Verify your account\\](https://phish) \\`x\\` \\\\\\['), 'shown as text');
  assert.doesNotMatch(md, /<img|(?<!\\)\]\(|(?<!\\)`x/);
  const audit = reportToMarkdown({ ...report, methods: { ...report.methods, undersized_targets: [{ page: 'localhost:3001/[a](b)', element: hostile, width: 20, height: 20, personas: 1 }] } });
  assert.doesNotMatch(audit, /<img|(?<!\\)\]\(|(?<!\\)`x/, 'an element name in the audit is the page\'s text too');
  assert.ok(md.includes('   - Page: http://localhost:3001/reset\n') && !md.includes('s3cret'), 'no token in the export');
});

test('an evidence page keeps its hash route without the route\'s query, and a text\'s name that parses as a URL stays whole', () => {
  const md = reportToMarkdown({
    ...report,
    themes: [{ ...theme, evidence: [{ ...theme.evidence[0], url: 'https://app.test/?ref=a#/settings?tab=s3cret' }] }],
    frictions: [{ ...report.frictions[0], url: 'Pricing: is it clear?' }],
  });
  assert.ok(md.includes('Page: https://app.test/#/settings\n') && !md.includes('s3cret'), 'the route names the page; its query may carry a token');
  assert.ok(md.includes('Pricing: is it clear?'));
});

test('missing-usage copy names the count and preserves uncertainty about provider billing', () => {
  assert.equal(missingUsageText(undefined), null);
  assert.equal(missingUsageText(0), null);
  assert.match(missingUsageText(1)!, /^1 model call did not report complete usage/);
  assert.match(missingUsageText(2)!, /^2 model calls did not report complete usage/);
  assert.match(missingUsageText(2)!, /Canceled or failed requests may still incur provider charges/);
  assert.match(missingUsageText(2)!, /Actual charges may exceed the recorded cost/);
});
