import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GnomiEvent } from '@gnomi/simulation/types.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { newRunConfig } from '@gnomi/simulation/run.ts';
import { SessionRuns } from './session-runs.ts';
import type { SessionRun } from './protocol.ts';

const config = { run_id: 'r-0001', ...newRunConfig({ name: 'Pricing study', description: '', goal: 'Understand pricing', role: null, audience: null,
  pois: [{ id: 'pricing', type: 'text', name: 'Pricing', segments: null, asset: 'pricing.md' }], settings: DEFAULT_SETTINGS,
}, { personas: [BUILTIN_PERSONA], sessions: [], reset: false }) };
const event = (fields: Pick<GnomiEvent, 'type' | 'payload'>): GnomiEvent => ({ run_id: 'r-0001', seq: 1, ts: 100, round: 0, persona_id: null, poi_id: null, ...fields } as GnomiEvent);

test('session completion waits for saved results and historical events do not add old runs', () => {
  const emitted: SessionRun[] = [];
  const runs = new SessionRuns((run) => emitted.push(run));
  runs.record('/old', event({ type: 'report.generated', payload: { path: 'report.json', friction_count: 0 } }));
  assert.deepEqual(runs.list(), []);
  runs.record('/pricing', event({ type: 'run.started', payload: { config } }), 'pricing.gnomi');
  runs.record('/pricing', event({ type: 'run.finished', payload: {} }));
  assert.equal(runs.list()[0].status, 'running');
  assert.equal(runs.list()[0].phase, 'saving');
  runs.record('/pricing', event({ type: 'report.generated', payload: { path: 'report.json', friction_count: 0 } }));
  assert.equal(runs.list()[0].status, 'finished');
  assert.equal(runs.list()[0].project_id, 'pricing.gnomi');
  assert.equal(emitted[0].status, 'running', 'previously emitted snapshots do not change underneath clients');
});

test('a blocked persona needs the user until she resumes, but never in a comparison, whose blocked tasks end at once', () => {
  const blocked = { ...event({ type: 'persona.blocked', payload: { step_no: 2, reason: 'captcha', detail: '' } }), persona_id: 'p-1' } as GnomiEvent;
  const runs = new SessionRuns(() => {});
  runs.record('/pricing', event({ type: 'run.started', payload: { config } }));
  runs.record('/pricing', blocked);
  assert.equal(runs.list()[0].waiting, 1);
  const comparison = { ...config, project: { ...config.project, comparison: { targets: [], tasks: [] } } } as unknown as typeof config;
  runs.record('/compare', event({ type: 'run.started', payload: { config: comparison } }));
  runs.record('/compare', blocked);
  assert.equal(runs.list().find((run) => run.project_dir === '/compare')?.waiting, 0);
});

test('report persistence failures end the affected run without contaminating another project', () => {
  const runs = new SessionRuns(() => {});
  for (const dir of ['/one', '/two']) runs.record(dir, event({ type: 'run.started', payload: { config } }));
  runs.fail('/one', 'r-0001');
  assert.equal(runs.list().find((run) => run.project_dir === '/one')?.status, 'interrupted');
  assert.equal(runs.list().find((run) => run.project_dir === '/two')?.status, 'running');
});
