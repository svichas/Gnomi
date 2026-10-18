import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Persona } from '@gnomi/simulation/types.ts';
import { diversityReport } from './diversity.ts';

// Written the way the persona writer is asked to write: first person, different people in the same product domain.
const VARIED = [
  'I run two backend teams at a payments company. Hiring is maybe five percent of my week and I want it to stay that way: the recruiter does the legwork, I say yes or no. I open these tools from my phone, usually from an email, usually late in the evening. Our last applicant tracker made me log in every single time, which I resented. If something takes more than a couple of taps I close it and message the recruiter instead.',
  "I've been recruiting for nine years, the last three at a logistics software firm of about two hundred and fifty people. I usually have twelve to fifteen roles open, mostly warehouse supervisors and developers. My mornings are screening calls; afternoons are chasing hiring managers for feedback. I keep a spreadsheet alongside our tracker because I don't trust its reminders. What I can't stand is retyping the same job description into three different boards.",
  "I look after HR systems for a furniture manufacturer with around nine hundred staff across two plants. Most of my week goes into payroll exports, access requests and fixing whatever broke after the last update. I'm comfortable in admin panels and I read release notes. Our previous vendor hid permissions three menus deep, so I spent a lot of time on support calls. I want settings to be where I expect them, and audit logs I can actually search.",
  "I joined a sixty-person climate startup straight out of university, and somehow I'm the person who schedules every interview. I juggle calendars for eight interviewers who are never free at the same time. I'm quick with apps, but I've never set up a hiring tool myself, so the vocabulary is still new to me. I'd rather click around than read a manual. Losing work because a page refreshed would genuinely ruin my afternoon.",
  "I'm the finance director at a regional supermarket chain. Requisitions and offers land on my desk because every hire touches the budget. I approve things between other meetings, almost always on my phone. I don't want to learn a system for something I do twice a month; I want the number, the reason, and a button. Anything that asks me to create an account or reset a password gets forwarded to my assistant.",
  "I work at a staffing agency in Madrid that places nurses and care workers across Spain and Portugal. Our clients send urgent requests, so speed matters more than polish. I think in Spanish and switch to English for some international clients. Over a typical week I talk to maybe forty candidates by phone. I've used four different trackers in my career; the best one let me move people between stages without opening each profile.",
  "I manage the customer support team at an insurance company of around fifteen hundred people. I use a screen reader for everything at work. When I review candidates I listen to their CVs at high speed and leave notes by keyboard. Plenty of web apps put buttons in places my screen reader announces in a strange order, or label them only with icons. I'm patient, but I won't fight a tool every week.",
  "I'm the only HR person at a family-owned engineering consultancy with seventy employees, and I work four days a week. Recruiting is one hat among many: contracts, onboarding, the summer party. I keep the browser zoomed in and sometimes things fall off the edge of the screen. We hire maybe ten people a year, so I forget how the system works between rounds and need it to be obvious.",
];
const NAMES = ['Dana Okafor', 'Priya Natarajan', 'Tomasz Wróbel', 'Grace Mensah', 'Kenji Watanabe', 'Lucía Ferrer', 'Samuel Adeyemi', 'Ingrid Holm'];

const BASE: Persona = {
  id: '',
  segment_id: 'seg-1',
  name: '',
  pronouns: 'they',
  job_title: 'Recruiter',
  seniority: 'mid',
  company_size: 240,
  industry: 'logistics software',
  tech_skill: 3,
  patience: 3,
  familiarity_with_category: 'medium',
  device: 'desktop',
  language: 'en',
  accessibility_needs: 'none',
  context_of_use: 'At a desk mid-morning',
  background: '',
  goal_interpretation: 'Post the job quickly.',
  motivation: 3,
  voice: 'Plain and brisk.',
  seed: 1,
};
const persona = (background: string, i: number, name = NAMES[i % NAMES.length]): Persona => ({
  ...BASE,
  id: `p-seg1-${String(i + 1).padStart(2, '0')}`,
  name,
  background,
});

test('a varied population passes with low similarity', () => {
  const report = diversityReport(VARIED.map((b, i) => persona(b, i)));
  assert.equal(report.warning, null);
  assert.deepEqual(report.duplicate_names, []);
  assert.ok(report.max_similarity < 0.3, `max ${report.max_similarity}`);
  assert.ok(report.mean_similarity < 0.1, `mean ${report.mean_similarity}`);
  assert.equal(report.most_similar?.length, 2);
});

test('a near-copy is flagged by name, and the pair is reported', () => {
  const copy = VARIED[1].replace('nine years', 'eight years').replace('logistics', 'freight').replace('spreadsheet', 'notebook');
  const report = diversityReport([...VARIED, copy].map((b, i) => persona(b, i, i === 8 ? 'Mia Laine' : undefined)));
  assert.ok(report.max_similarity >= 0.85, `max ${report.max_similarity}`);
  assert.deepEqual(report.most_similar, ['p-seg1-02', 'p-seg1-09']);
  assert.match(report.warning ?? '', /^Priya Natarajan and Mia Laine have near-identical backgrounds \(similarity 0\.\d\d\)/);
});

test('a population written from one template reads alike on average', () => {
  const titles = ['recruiter', 'talent partner', 'HR coordinator', 'hiring manager', 'people lead', 'sourcer', 'HR generalist', 'talent lead'];
  const industries = ['logistics', 'retail', 'banking', 'software', 'healthcare', 'construction', 'education', 'insurance'];
  const templated = titles.map(
    (t, i) =>
      `I am a ${t} at a ${100 * (i + 1)}-person ${industries[i]} company. I use our hiring tool every week to post jobs, review candidates and chase feedback from managers. I like tools that are quick and simple, and I get frustrated when a tool is slow or confusing.`,
  );
  const report = diversityReport(templated.map((b, i) => persona(b, i)));
  assert.ok(report.mean_similarity >= 0.3, `mean ${report.mean_similarity}`);
  assert.ok(report.max_similarity < 0.85, 'no single pair is a copy: the warning is about the whole population');
  assert.match(report.warning ?? '', /read alike across the population \(mean similarity 0\.\d\d\)/);
});

test('duplicate names are found whatever their case and spacing', () => {
  const people = VARIED.map((b, i) => persona(b, i));
  people[5] = { ...people[5], name: ' dana  okafor ' };
  const report = diversityReport(people);
  assert.deepEqual(report.duplicate_names, ['Dana Okafor']);
  assert.match(report.warning ?? '', /^One name is used more than once \(Dana Okafor\)\. Regenerate/);
});

test('fewer than two personas have nothing to compare', () => {
  for (const people of [[], [persona(VARIED[0], 0)]]) {
    assert.deepEqual(diversityReport(people), { mean_similarity: 0, max_similarity: 0, most_similar: null, duplicate_names: [], warning: null });
  }
});
