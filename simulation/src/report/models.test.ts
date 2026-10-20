import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE } from '../llm/scripted.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import type { LlmGateway, Recorder, Responder } from '../seams.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { GnomiEvent, LlmRole, NewEvent, RunConfig } from '../types.ts';
import { buildReport } from './build.ts';
import { runReportModels } from './models.ts';

const JOBS = 'http://gym.test/jobs/new';
const config: RunConfig = {
  run_id: 'r-1',
  seed: 1,
  project: {
    name: 'Gym', description: 'A demo ATS.', goal: 'Post a job', role: null, audience: null, settings: DEFAULT_SETTINGS,
    pois: [{ id: 'poi', type: 'web', name: 'Gym', start_url: 'http://gym.test/', allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null }],
  },
  personas: [BUILTIN_PERSONA],
  sessions: [],
  reset: false,
  pause_timeout_ms: 0,
  app_version: '0.0.0',
};
const who = { run_id: 'r-1', round: 1, persona_id: BUILTIN_PERSONA.id, poi_id: 'poi' } as const;
const where = (url: string) => ({ url, ref: null });

/** A finished episode with frictions on two pages, then the report models with the given responders. */
async function analyse(responders: Partial<Record<LlmRole, Responder>>, extra: NewEvent[] = [], round = 1) {
  const events: GnomiEvent[] = [];
  const record: Recorder = (event: NewEvent) => {
    const stored = { ...event, seq: events.length + 1, ts: events.length } as GnomiEvent;
    events.push(stored);
    return stored;
  };
  record({ ...who, persona_id: null, poi_id: null, type: 'run.started', payload: { config } });
  record({ ...who, type: 'persona.created', payload: { persona: BUILTIN_PERSONA } });
  record({ ...who, type: 'persona.friction_reported', payload: { step_no: 1, severity: 3, what: 'Save does nothing', expected: 'Saved', where: where(JOBS), heard_post_ids: [] } });
  record({ ...who, type: 'persona.friction_reported', payload: { step_no: 4, severity: 2, what: 'Home is empty', expected: 'Jobs', where: where('http://gym.test/'), heard_post_ids: [] } });
  for (const event of extra) record(event);
  const requests: { role: LlmRole; user: string }[] = [];
  const llm = createScriptedGateway(
    Object.fromEntries(Object.entries(responders).map(([role, respond]) => [role, (req: Parameters<Responder>[0]) => {
      requests.push({ role: req.role, user: req.user.map((p) => (p.type === 'text' ? p.text : '')).join('') });
      return respond!(req);
    }])),
    record,
  );
  await runReportModels({ config, round, llm, record, events: () => events });
  return { events, requests, types: events.slice(4 + extra.length).map((e) => e.type), report: buildReport(events) };
}

const FEW = 'Only 1 persona tried Gym, so every share has a wide range and the order of the problems is rough.';
const judged = { themes: [{ title: 'Saving a job fails', description: 'Save does nothing.', group_ids: ['g1'] }] };
const suggested = { suggestions: [{ theme_id: 'g1', change: 'Make Save save the job.', solution: 'Submit the form and show the saved job.' }] };

test('the judge names themes and the author suggests changes; both answers are logged and folded into the report', async () => {
  const { types, requests, report } = await analyse({ judge: () => judged, author: () => suggested });
  assert.deepEqual(types, ['report.started', 'llm.call', 'report.themes', 'llm.call', 'report.suggestions']);
  assert.deepEqual(JSON.parse(requests[0].user).groups.map((g: { id: string }) => g.id), ['g1', 'g2']);
  assert.deepEqual(JSON.parse(requests[1].user).themes.map((t: { id: string }) => t.id), ['g1', 'g2'], 'the author sees the themes the judge left');
  assert.deepEqual(report.themes?.map((t) => [t.id, t.title, t.named_by, t.suggestion?.change ?? null]), [
    ['g1', 'Saving a job fails', 'judge', 'Make Save save the job.'],
    ['g2', 'Reported friction on /', 'rules', null],
  ]);
  assert.deepEqual(report.methods.limitations, ['Suggested changes cover 1 of 2 themes.', FEW]);
  assert.ok(report.themes?.every((t) => t.seqs.length > 0));
});

test('a malformed judge answer is retried once, then the themes stay deterministic and the author still runs', async () => {
  const { types, report } = await analyse({ judge: () => ({ themes: 'nope' }), author: () => suggested });
  assert.deepEqual(types, ['report.started', 'llm.call', 'llm.call', 'llm.call', 'report.suggestions']);
  assert.deepEqual(report.themes?.map((t) => [t.title, t.named_by]), [['Reported friction on /jobs/new', 'rules'], ['Reported friction on /', 'rules']]);
  assert.match(report.methods.limitations?.[0] ?? '', /^The judge model did not name the themes/);
});

test('without a model (no key, no responder) only the start is logged and the report falls back to rules', async () => {
  const { types, report } = await analyse({});
  assert.deepEqual(types, ['report.started']);
  assert.equal(report.themes?.length, 2);
  assert.ok(report.themes?.every((t) => t.named_by === 'rules' && t.suggestion === null));
  assert.equal(report.methods.limitations?.length, 3);
});

test('the scripted demo judge and author give every group a labelled theme and suggestion, so key-free runs show themes', async () => {
  const { types, report } = await analyse({ judge: DEMO_JUDGE, author: DEMO_AUTHOR });
  assert.deepEqual(types, ['report.started', 'llm.call', 'report.themes', 'llm.call', 'report.suggestions']);
  assert.deepEqual(report.themes?.map((t) => [t.title, t.named_by]), [
    ['Scripted demo theme 1: no model named it', 'judge'],
    ['Scripted demo theme 2: no model named it', 'judge'],
  ]);
  assert.ok(report.themes?.every((t) => t.suggestion?.change.startsWith('Scripted demo suggestion')));
  assert.deepEqual(report.methods.limitations, [FEW]);
});

test('every POI is judged at once, and the author writes in parallel batches of three; a failed batch loses only its own themes', async () => {
  const two: RunConfig = { ...config, project: { ...config.project, pois: [config.project.pois[0], { ...config.project.pois[0], id: 'poi-b', name: 'Other' }] } };
  const events: GnomiEvent[] = [];
  const record: Recorder = (event: NewEvent) => {
    const stored = { ...event, seq: events.length + 1, ts: events.length } as GnomiEvent;
    events.push(stored);
    return stored;
  };
  record({ ...who, persona_id: null, poi_id: null, type: 'run.started', payload: { config: two } });
  record({ ...who, type: 'persona.created', payload: { persona: BUILTIN_PERSONA } });
  for (const [i, page] of ['jobs', 'candidates', 'settings', 'reviews'].entries())
    record({ ...who, type: 'persona.friction_reported', payload: { step_no: i + 1, severity: 2, what: `Trouble on ${page}`, expected: 'It works', where: where(`http://gym.test/${page}`), heard_post_ids: [] } });
  record({ ...who, poi_id: 'poi-b', type: 'persona.friction_reported', payload: { step_no: 9, severity: 2, what: 'Pricing is unclear', expected: 'Clear tiers', where: where('http://other.test/pricing'), heard_post_ids: [] } });

  let inFlight = 0;
  let peakJudges = 0;
  const batches: string[][] = [];
  const llm: LlmGateway = {
    async call(req) {
      const judging = req.purpose === 'report_themes';
      inFlight += judging ? 1 : 0;
      peakJudges = Math.max(peakJudges, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (judging) {
        inFlight--;
        return { object: { themes: [] }, cost_usd: 0 } as never; // the judge leaves every group as its own theme
      }
      const ids = JSON.parse(req.user.map((p) => (p.type === 'text' ? p.text : '')).join('')).themes.map((t: { id: string }) => t.id);
      batches.push(ids);
      if (batches.length === 2) throw new Error('provider error'); // one batch fails
      return { object: { suggestions: ids.map((theme_id: string) => ({ theme_id, change: `Fix ${theme_id}.`, solution: 'Make it work.' })) }, cost_usd: 0 } as never;
    },
  };
  await runReportModels({ config: two, round: 1, llm, record, events: () => events });

  assert.deepEqual(events.find((e) => e.type === 'report.started')?.payload, { pois: ['poi', 'poi-b'] });
  assert.equal(peakJudges, 2, 'both POIs were judged at the same time');
  assert.deepEqual(batches.map((b) => b.length).sort(), [1, 1, 3], 'four themes on the first POI in batches of three and one, one on the other');
  const kept = events.flatMap((e) => (e.type === 'report.suggestions' ? e.payload.suggestions.map((s) => s.theme_id) : []));
  assert.equal(kept.length, 5 - batches[1].length, 'only the failed batch has no suggestions');
  assert.ok(!kept.some((id) => batches[1].includes(id)));
});


test('survey likes go to the same judge call, which merges and names them for what went well', async () => {
  const items = [
    { kind: 'like' as const, where: 'job form', what: 'The form is short', severity: null },
    { kind: 'objection' as const, where: 'pricing', what: 'No price for a team', severity: 3 },
  ];
  const surveyed: NewEvent = { ...who, type: 'persona.survey', payload: { poi_id: 'poi', sentiment: 1, confidence: 0.5, likes: ['The form is short'], frictions: ['No price for a team'], items, would_continue: true, reason: 'Fine.' } };
  const { types, requests, report, events } = await analyse({ judge: DEMO_JUDGE, author: DEMO_AUTHOR }, [surveyed]);
  assert.deepEqual(types, ['report.started', 'llm.call', 'report.themes', 'llm.call', 'report.suggestions'], 'one judge call, as before');
  const shown = JSON.parse(requests[0].user);
  assert.deepEqual(shown.likes, [{ id: 'l1', where: 'job form', personas: 1, texts: ['The form is short'] }]);
  assert.deepEqual(shown.groups.map((g: { id: string; category: string }) => [g.id, g.category]), [['g1', 'friction'], ['g2', 'friction'], ['g3', 'objection']]);
  assert.ok(events.some((e) => e.type === 'report.themes' && e.payload.likes?.length === 1));
  assert.deepEqual(report.went_well?.map((l) => [l.text, l.personas]), [['Scripted demo like 1: no model named it', 1]]);
  assert.equal(report.themes?.find((t) => t.id === 'g3')?.category, 'objection');
});

test('judge and author calls record the round the run reached and the POI they are about', async () => {
  const { events } = await analyse({ judge: DEMO_JUDGE, author: DEMO_AUTHOR }, [], 3);
  const calls = events.filter((e) => e.type === 'llm.call');
  assert.deepEqual(calls.map((e) => [e.payload.purpose, e.round, e.poi_id]).sort(), [['report_suggestions', 3, 'poi'], ['report_themes', 3, 'poi']]);
});
