import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PERSONA } from '../persona.ts';
import { getPersonaSchema } from '../profile/schema.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { AttributeValue, GnomiEvent, NewEvent, Persona, PersonaSchema, ProfileAttribute, ProjectConfig, RunConfig } from '../types.ts';
import { buildReport } from './build.ts';
import { attributeKey, formatAttributeValue } from './dimensions.ts';
import { reportToMarkdown } from './markdown.ts';

const custom = (id: string, type: ProfileAttribute['type'], enabled = true): ProfileAttribute => ({
  id, name: id, type, group: 'work', description: 'A test attribute.', core: false, enabled, show_on_card: true, use_in_prompt: true, report_dimension: true,
  sampling: { default: { kind: 'fixed', value: type === 'number' ? 0 : type === 'boolean' ? false : type === 'list' ? [] : 'EMEA' }, by_segment: {} },
});
const schema = (): PersonaSchema => ({
  ...getPersonaSchema(),
  attributes: [
    ...getPersonaSchema().attributes.map((attribute) => ({ ...attribute, report_dimension: false, ...(attribute.id === 'job_title' ? { enabled: false } : {}) })),
    custom('region', 'text'), custom('consent', 'boolean'), custom('tenure', 'number'), custom('tools', 'list'), custom('secret_note', 'text', false),
  ],
});

function fixture(personaSchema: PersonaSchema | undefined = schema()) {
  const person = (id: string, attributes: Record<string, AttributeValue>): Persona => ({ ...BUILTIN_PERSONA, id, name: id, attributes, job_title: 'Hidden title' });
  const personas = [
    person('p1', { region: 'EMEA', consent: false, tenure: 0, tools: ['A', 'B'], secret_note: 'PRIVATE' }),
    person('p2', { region: 'EMEA', consent: false, tenure: 1, tools: ['A'] }),
    person('p3', { region: 'Americas', consent: true, tenure: 0, tools: ['A', 'B'] }),
  ];
  const project: ProjectConfig = {
    name: 'Gym', description: 'A demo', goal: 'Post a job', audience: null, role: null, settings: DEFAULT_SETTINGS,
    pois: [{ id: 'poi', type: 'web', name: 'Gym', start_url: 'http://localhost', allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null, mode: 'full', segments: null }],
    ...(personaSchema ? { persona_schema: personaSchema } : {}),
  };
  const config: RunConfig = { run_id: 'r1', seed: 1, project, personas, sessions: [], reset: false, pause_timeout_ms: 0, app_version: 'test' };
  const events: GnomiEvent[] = [];
  const add = (event: Pick<NewEvent, 'type' | 'payload'>, persona_id: string | null = null) => events.push({ ...event, seq: events.length + 1, ts: events.length * 100, run_id: 'r1', round: 1, poi_id: 'poi', persona_id } as GnomiEvent);
  add({ type: 'run.started', payload: { config: structuredClone(config) } });
  for (const persona of personas) add({ type: 'persona.created', payload: { persona: structuredClone(persona) } }, persona.id);
  const step = (id: string, feeling: number) => add({ type: 'persona.step', payload: {
    step_no: events.length, thought: 'Thought', feeling, action: { type: 'done', ref: null, text: null }, target: null,
    result: { ok: true, error: null, url_before: 'http://localhost', url_after: 'http://localhost', dom_changed: false },
    screenshot: null, snapshot_hash: 'hash', duration_ms: 1,
  } }, id);
  step('p1', -2);
  step('p1', 2);
  step('p3', 0);
  add({ type: 'persona.goal_done', payload: { step_no: 2, summary: 'Done' } }, 'p1');
  add({ type: 'persona.abandoned', payload: { step_no: 1, reason: 'Left' } }, 'p2');
  add({ type: 'persona.goal_done', payload: { step_no: 1, summary: 'Done' } }, 'p3');
  add({ type: 'persona.friction_reported', payload: { step_no: 2, severity: 2, what: 'Problem', expected: 'Clear wording', where: { url: 'http://localhost', ref: null } } }, 'p1');
  add({ type: 'run.finished', payload: {} });
  return { config, events };
}

test('report dimensions use typed values, persona outcomes and only each persona’s latest feeling', () => {
  const { events } = fixture();
  const report = buildReport(events);
  assert.deepEqual(report.dimensions?.find((dimension) => dimension.id === 'region')?.values, [
    { value: 'Americas', personas: 1, completion: 1, with_friction: 0, sentiment: 0 },
    { value: 'EMEA', personas: 2, completion: 0.5, with_friction: 0.5, sentiment: 2 },
  ]);
  assert.deepEqual(report.dimensions?.find((dimension) => dimension.id === 'consent')?.values.map((group) => group.value), [false, true]);
  assert.deepEqual(report.dimensions?.find((dimension) => dimension.id === 'tenure')?.values.map((group) => group.value), [0, 1]);
  assert.equal(report.dimensions?.find((dimension) => dimension.id === 'tools')?.values.find((group) => attributeKey(group.value) === attributeKey(['A', 'B']))?.personas, 2);
  assert.deepEqual(report.personas[0].attributes, { region: 'EMEA', consent: false, tenure: 0, tools: ['A', 'B'] });
  assert.ok(report.personas.every((persona) => !Object.hasOwn(persona, 'job_title')));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|secret_note|Hidden title/);
  assert.deepEqual(buildReport(structuredClone(events)), report, 'folding the persisted log is deterministic');
});

test('a historical report keeps its frozen dimensions after the editable schema changes', () => {
  const { config, events } = fixture();
  const expected = buildReport(events);
  for (const attribute of config.project.persona_schema!.attributes) attribute.report_dimension = false;
  config.personas[0].attributes!.region = 'Changed later';
  assert.deepEqual(buildReport(events), expected);
  const older = fixture();
  const start = older.events[0];
  if (start.type === 'run.started') delete start.payload.config.project.persona_schema;
  const legacy = buildReport(older.events);
  assert.equal(legacy.dimensions, undefined);
  assert.equal(legacy.personas[0].attributes, undefined);
  assert.equal(legacy.personas[0].job_title, 'Hidden title');
});

test('synthetic neutral feelings from invalid model output do not change group sentiment', () => {
  const { events } = fixture();
  for (const id of ['p1', 'p3']) {
    const latest = events.findLast((event) => event.type === 'persona.step' && event.persona_id === id);
    assert.ok(latest && latest.type === 'persona.step');
    latest.payload.feeling = 0;
    latest.payload.result = { ...latest.payload.result, ok: false, error: 'invalid_output' };
  }
  const groups = buildReport(events).dimensions?.find((dimension) => dimension.id === 'region')?.values;
  assert.equal(groups?.find((group) => group.value === 'EMEA')?.sentiment, -2, 'retains the latest valid feeling');
  assert.equal(groups?.find((group) => group.value === 'Americas')?.sentiment, null, 'has no valid feeling');
});

test('Markdown includes dimension denominators and typed labels without exposing disabled attributes', () => {
  const markdown = reportToMarkdown(buildReport(fixture().events));
  assert.match(markdown, /Results by profile/);
  assert.match(markdown, /EMEA \| 2 \| 50% \| 50% \| 2\.00/);
  assert.match(markdown, /false \| 2/);
  assert.doesNotMatch(markdown, /PRIVATE|secret_note|Hidden title/);
  assert.equal(formatAttributeValue(0), '0');
  assert.equal(formatAttributeValue(false), 'false');
  assert.equal(formatAttributeValue(['A', 'B']), 'A, B');
  assert.notEqual(attributeKey(false), attributeKey('false'));
});
