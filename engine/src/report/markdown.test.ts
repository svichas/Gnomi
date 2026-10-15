import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Report } from '../types.ts';
import { HYPOTHESIS_BANNER } from './build.ts';
import { reportToMarkdown } from './markdown.ts';

const report: Report = {
  run_id: 'r-0001',
  status: 'finished',
  stop_reason: null,
  goal: 'Post a job for a backend engineer',
  poi: { name: 'Gym', start_url: 'http://localhost:3001/' },
  persona: { id: 'p-001', name: 'Priya Natarajan', job_title: 'Recruiter', device: 'desktop' },
  outcome: 'done',
  outcome_text: 'Posted the job.',
  steps: 2,
  frictions: [
    {
      seq: 3,
      step_no: 1,
      severity: 2,
      what: 'The Save button is ambiguous.',
      expected: 'A button that says what it does.',
      url: 'http://localhost:3001/jobs/new',
      quote: 'Is this posting or saving?',
      screenshot: 'runs/r-0001/shots/p-001-0001.jpg',
    },
    {
      seq: 7,
      step_no: 2,
      severity: 3,
      what: 'The required field gives\nno error.',
      expected: 'An error under the field.',
      url: 'http://localhost:3001/jobs/new',
      quote: 'Nothing happened.',
      screenshot: null,
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
  methods: { role: null, allowed_hosts: ['localhost'], blocked_requests: [], blocked: [], tripwires: [], reset: null },
};

test('reportToMarkdown carries the banner, the goal, each friction and the totals', () => {
  const md = reportToMarkdown(report);
  assert.ok(md.startsWith('# Gnomi report: Post a job for a backend engineer\n'));
  for (const expected of [
    HYPOTHESIS_BANNER,
    '1. Step 1, severity 2: The Save button is ambiguous.',
    '   - Expected: A button that says what it does.',
    '   - Quote: "Is this posting or saving?"',
    '   - Screenshot: runs/r-0001/shots/p-001-0001.jpg',
    '2. Step 2, severity 3: The required field gives no error.',
    '   - Screenshot: none',
    '- Cost: $0.7500',
    '- Tokens: 2000 in, 400 out',
    '- LLM calls: 2',
    '- Duration: 8.0 s',
  ]) {
    assert.ok(md.includes(expected), expected);
  }
});

test('reportToMarkdown says so when a run reported no frictions', () => {
  assert.ok(reportToMarkdown({ ...report, frictions: [] }).includes('No frictions reported.'));
});

test('reportToMarkdown lists the methods appendix: role, hosts, blocks, tripwires and the reset hook', () => {
  const md = reportToMarkdown({
    ...report,
    methods: {
      role: 'recruiter',
      allowed_hosts: ['localhost', 'cdn.example.com'],
      blocked_requests: [{ host: 'ads.example.net', count: 3 }],
      blocked: [{ step_no: 4, reason: 'captcha', detail: 'reCAPTCHA on the sign-in page', resumed: true }],
      tripwires: [{ kind: 'live_payment_key', detail: 'pk_live_ on /checkout' }],
      reset: { url: 'https://staging.example/reset', status: 200, error: null },
    },
  });
  assert.ok(md.endsWith('\n'));
  assert.ok(md.indexOf('## Methods') > md.indexOf('## Cost and time'));
  for (const expected of [
    '- Role: recruiter',
    '- Allowed hosts: localhost, cdn.example.com',
    '- Blocked requests: ads.example.net (3)',
    '- Blocked at step 4 (captcha, resumed): reCAPTCHA on the sign-in page',
    '- Tripwire (live_payment_key): pk_live_ on /checkout',
    '- Reset hook: https://staging.example/reset, HTTP 200',
  ]) {
    assert.ok(md.includes(expected), expected);
  }
});

test('reportToMarkdown says what happened when nothing was blocked or reset', () => {
  const md = reportToMarkdown({
    ...report,
    methods: { ...report.methods, reset: { url: 'https://staging.example/reset', status: null, error: 'ECONNREFUSED' } },
  });
  for (const expected of [
    '- Role: none, browsing logged out',
    '- Blocked requests: none',
    '- Blocked personas: none',
    '- Tripwires: none',
    '- Reset hook: https://staging.example/reset, failed: ECONNREFUSED',
  ]) {
    assert.ok(md.includes(expected), expected);
  }
  assert.ok(reportToMarkdown(report).includes('- Reset hook: not called'));
});
