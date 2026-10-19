import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftComparison } from '@gnomi/simulation/comparison/config.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import type { ProjectConfig, SessionInfo } from '@gnomi/simulation/types.ts';
import { comparisonSessionPois, comparisonSessionTarget } from './comparison-sessions.ts';

test('recording and verification only use the explicitly bound tool, not the first full-mode site', () => {
  const config: ProjectConfig = { name: 'Comparison', description: '', goal: 'Try the workflow', role: null, audience: null, settings: DEFAULT_SETTINGS,
    pois: ['one', 'two'].map((id) => ({ id, name: id, type: 'web', mode: 'full', start_url: `https://staging.${id}.example/`, segments: null, allowed_hosts: [], production_domains: [], reset_hook_url: null })) };
  config.comparison = draftComparison(config);
  const target = config.comparison.targets[1]!;
  target.access_scope = 'authenticated_workflow';
  target.session_role = 'two-admin';
  assert.deepEqual(comparisonSessionPois(config, target.id, 'two-admin').map((poi) => poi.id), ['two']);
  assert.throws(() => comparisonSessionPois(config, target.id, 'one-admin'), /login name/);
  assert.throws(() => comparisonSessionPois(config, config.comparison!.targets[0]!.id), /not configured/);
  assert.throws(() => comparisonSessionPois(config, 'unknown'), /configured comparison/);
  const session: SessionInfo = { role: 'two-admin', start_url: 'https://staging.two.example/', hosts: [], recorded_at: 1, verified_at: 1, expires_at: null };
  assert.throws(() => comparisonSessionTarget(config, session), /not bound/);
  assert.throws(() => comparisonSessionTarget(config, { ...session, target_id: config.comparison!.targets[0]!.id }), /not bound/);
  assert.equal(comparisonSessionTarget(config, { ...session, target_id: target.id }), target.id);
});
