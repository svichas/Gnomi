import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftComparison } from '@gnomi/simulation/comparison/config.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import { sampleTraits } from '@gnomi/simulation/audience/sample.ts';
import type { ProjectConfig } from '@gnomi/simulation/types.ts';
import { defaultAudience, proposeAudience } from './index.ts';
import { DEMO_PERSONA_WRITER } from './demo.ts';
import { proposeUser, proposalSystem } from './propose.ts';
import { writerUser } from './write.ts';

function buyerProject(): ProjectConfig {
  const project: ProjectConfig = { name: 'ATS choice', description: 'Hiring tools', goal: 'Choose an ATS', study_intent: 'choose_tool', role: null, audience: null, settings: DEFAULT_SETTINGS, pois: ['One', 'Two'].map((name) => ({ id: name, name, type: 'web', mode: 'observe_only', segments: null, start_url: `https://${name.toLowerCase()}.example/`, allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null })) };
  project.comparison = draftComparison(project, { company_size: '120 employees and 4 recruiters', hiring_volume: '30 hires annually', budget: 'EUR 500/month', requirements: ['Interview scorecards'], required_integrations: ['Slack'], switching_constraints: '' });
  return project;
}

test('comparison audience receives one company brief and forbids invented workflows', () => {
  const project = buyerProject();
  assert.match(proposalSystem(project), /stakeholders of the same company/);
  assert.match(proposalSystem(project), /goal_override must be null/);
  const prompt = proposeUser(project, []);
  assert.match(prompt, /120 employees and 4 recruiters/);
  assert.match(prompt, /Interview scorecards/);
  assert.match(prompt, /no candidate inbox/i);
  const audience = defaultAudience(project);
  assert.equal(audience.segments[0].kind, 'buyer');
  assert.equal(audience.segments[0].account_state, 'empty');
  assert.equal(audience.persona_count, 3);
});

test('comparison proposal removes task overrides and account assumptions even when a model invents them', async () => {
  const project = buyerProject();
  const result = await proposeAudience({ project, model: DEFAULT_SETTINGS.routing.persona_writer, llm: { async call(req) {
    const proposed = DEMO_PERSONA_WRITER(req) as { segments: Record<string, unknown>[] };
    return { object: req.schema.parse({ segments: proposed.segments.map((segment) => ({ ...segment, entry: 'email_link', account_state: 'populated', goal_override: 'Open a candidate from my inbox' })) }), cost_usd: 0 };
  } } });
  assert.ok(result.audience.segments.every((segment) => segment.goal_override === null && segment.entry === 'direct' && segment.account_state === 'empty' && segment.kind === 'buyer'));
});

test('comparison writer ignores sampled company facts and segment tasks while preserving legacy prompts', () => {
  const project = buyerProject();
  const audience = defaultAudience(project);
  const segment = { ...audience.segments[0], goal_override: 'Review a candidate inbox', entry: 'email_link' as const };
  const traits = { ...sampleTraits(segment, audience, 1), company_size: 1900 };
  const prompt = writerUser(project, segment, traits, null);
  assert.match(prompt, /120 employees and 4 recruiters/);
  assert.doesNotMatch(prompt, /1900|Review a candidate inbox|usually arriving from a link/);
  assert.match(prompt, /fixed company/);
  const legacy = { ...project, comparison: null, study_intent: undefined };
  assert.match(writerUser(legacy, segment, traits, null), /Review a candidate inbox/);
  assert.match(proposalSystem(legacy), /usability problems/);
});
