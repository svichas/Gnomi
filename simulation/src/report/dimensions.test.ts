import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PERSONA } from '../persona.ts';
import { getPersonaSchema } from '../profile/schema.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { AttributeValue, GnomiEvent, NewEvent, Persona, PersonaSchema, ProfileAttribute, ProjectConfig, ReportDimension, ReportPersona, ReportTheme, RunConfig } from '../types.ts';
import { buildReport } from './build.ts';
import { attributeKey, buildDimensions, DRIVER_AFFECTED, DRIVER_GAP, DRIVER_HOLDERS, formatAttributeValue, themeDrivers } from './dimensions.ts';
import { DRIVER_NOTE, driverText, reportToMarkdown } from './markdown.ts';

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
    pois: [{ id: 'poi', type: 'web', name: 'Gym', start_url: 'http://localhost', allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null }],
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
    screenshot: null, snapshot_hash: 'hash', duration_ms: 1, heard_post_ids: [],
  } }, id);
  step('p1', -2);
  step('p1', 2);
  step('p3', 0);
  add({ type: 'persona.goal_done', payload: { step_no: 2, summary: 'Done' } }, 'p1');
  add({ type: 'persona.abandoned', payload: { step_no: 1, reason: 'Left' } }, 'p2');
  add({ type: 'persona.goal_done', payload: { step_no: 1, summary: 'Done' } }, 'p3');
  add({ type: 'persona.friction_reported', payload: { step_no: 2, severity: 2, what: 'Problem', expected: 'Clear wording', where: { url: 'http://localhost', ref: null }, heard_post_ids: [] } }, 'p1');
  add({ type: 'run.finished', payload: {} });
  return { config, events };
}

test('report dimensions use typed values, persona outcomes and only each persona’s latest feeling', () => {
  const { events } = fixture();
  const report = buildReport(events);
  assert.deepEqual(report.dimensions?.find((dimension) => dimension.id === 'region')?.values, [
    { value: 'Americas', personas: 1, completion: 1, with_friction: 0, sentiment: 0 },
    { value: 'EMEA', personas: 2, completion: 0.5, with_friction: 1, sentiment: 2 }, // p2 gave up: a friction theme counts it
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
  assert.match(markdown, /EMEA \| 2 \| 50% \| 100% \| 2\.00/);
  assert.match(markdown, /false \| 2/);
  assert.doesNotMatch(markdown, /PRIVATE|secret_note|Hidden title/);
  assert.equal(formatAttributeValue(0), '0');
  assert.equal(formatAttributeValue(false), 'false');
  assert.equal(formatAttributeValue(['A', 'B']), 'A, B');
  assert.notEqual(attributeKey(false), attributeKey('false'));
});

test('a persona the model gave no valid answer for counts in the row but not in its rates, like one that never started', () => {
  const people = ['p1', 'p2', 'p3'].map((id): Persona => ({ ...BUILTIN_PERSONA, id, attributes: { region: 'EMEA' } }));
  const outcomes = [['p1', 'done'], ['p2', 'model_failed'], ['p3', 'not_started']].map(([id, outcome]) => ({ id, outcome }) as ReportPersona);
  const [row] = buildDimensions(people, outcomes, new Map(), schema(), new Set()).find((d) => d.id === 'region')!.values;
  assert.deepEqual([row.personas, row.completion], [3, 1]);
  const [none] = buildDimensions(people.slice(1), outcomes.slice(1), new Map(), schema(), new Set()).find((d) => d.id === 'region')!.values;
  assert.deepEqual([none.personas, none.completion, none.with_friction], [2, null, null], 'no rate over nobody');
});

const PROBLEM = 'The Save button loses the draft';
const page = 'http://localhost/jobs/new';

/** Personas who reached one page, of whom those with `met` reported one problem there; with `survey`, a survey asks them instead and those with `asked: false` are not asked. */
function driverRun(people: { attributes: Record<string, AttributeValue>; met?: boolean; asked?: boolean; failed?: boolean }[], { survey = false, pois, onPoi = 'poi' }: { survey?: boolean; pois?: ProjectConfig['pois']; onPoi?: string } = {}) {
  const base = fixture().config;
  const personas = people.map(({ attributes }, i): Persona => ({ ...BUILTIN_PERSONA, id: `p${i + 1}`, name: `p${i + 1}`, attributes }));
  const config: RunConfig = { ...base, personas, project: { ...base.project, ...(pois ? { pois } : {}) } };
  const events: GnomiEvent[] = [];
  const add = (event: Pick<NewEvent, 'type' | 'payload'>, persona_id: string | null = null) => events.push({ ...event, seq: events.length + 1, ts: events.length * 100, run_id: 'r1', round: 1, poi_id: onPoi, persona_id } as GnomiEvent);
  add({ type: 'run.started', payload: { config } });
  for (const persona of personas) add({ type: 'persona.created', payload: { persona } }, persona.id);
  people.forEach(({ met, asked = true, failed }, i) => {
    const id = `p${i + 1}`;
    add({ type: 'persona.step', payload: { step_no: 1, thought: '', feeling: 0, action: { type: 'click', ref: null, text: null }, target: null, result: { ok: true, error: null, url_before: page, url_after: page, dom_changed: false }, screenshot: null, snapshot_hash: 'hash', duration_ms: 1, heard_post_ids: [] } }, id);
    if (met && !survey) add({ type: 'persona.friction_reported', payload: { step_no: 1, severity: 2, what: PROBLEM, expected: 'It works', where: { url: page, ref: null }, heard_post_ids: [] } }, id);
    if (survey && asked) add({ type: 'persona.survey', payload: { poi_id: onPoi, sentiment: 0, confidence: 1, likes: [], frictions: met ? [PROBLEM] : [], would_continue: true, reason: 'Asked.' } }, id);
    if (failed) add({ type: 'signal.repeated_failure', payload: { step_no: 1, action: 'click', error: 'invalid_output' } }, id);
  });
  add({ type: 'run.finished', payload: {} });
  return { events, report: buildReport(events) };
}

const group = (n: number, met: number, attributes: Record<string, AttributeValue>) => Array.from({ length: n }, (_, i) => ({ attributes, met: i < met }));
const driversOf = (report: ReturnType<typeof buildReport>) => report.themes?.[0].drivers;

test('a real gap shows as more common among, with the counts behind it', () => {
  const { report } = driverRun([...group(6, 4, { region: 'EMEA' }), ...group(9, 1, { region: 'Americas' })]);
  assert.deepEqual(driversOf(report), [{ id: 'region', name: 'region', value: 'EMEA', holders: { affected: 4, reached: 6 }, others: { affected: 1, reached: 9 }, gap: 0.5556 }], 'only the higher rate reads as a driver');
  assert.equal(driverText(driversOf(report)![0]), 'More common among personas with region EMEA: 4 of 6 with it, against 1 of 9 others');
  const markdown = reportToMarkdown(report);
  assert.match(markdown, /- More common among personas with region EMEA: 4 of 6 with it, against 1 of 9 others/);
  assert.ok(markdown.includes(DRIVER_NOTE), 'the limits are explained beside it');
});

test('driver wording says more common among, with no claim of cause and no p-value', () => {
  const { report } = driverRun([...group(6, 4, { region: 'EMEA' }), ...group(9, 1, { region: 'Americas' })]);
  const shown = [DRIVER_NOTE, ...driversOf(report)!.map(driverText), ...reportToMarkdown(report).split('\n').filter((text) => text.includes('More common among'))];
  assert.ok(shown.length >= 3);
  for (const text of shown) assert.doesNotMatch(text, /caus|because|due to|driven by|p-value|signific/i);
});

test(`a value held by under ${DRIVER_HOLDERS} personas, or met by under ${DRIVER_AFFECTED}, shows nothing, however wide the gap`, () => {
  assert.equal(driversOf(driverRun([...group(DRIVER_HOLDERS - 1, 4, { region: 'EMEA' }), ...group(8, 0, { region: 'Americas' })]).report), undefined);
  assert.equal(driversOf(driverRun([...group(DRIVER_HOLDERS, DRIVER_AFFECTED - 1, { region: 'EMEA' }), ...group(8, 0, { region: 'Americas' })]).report), undefined);
  assert.equal(driversOf(driverRun([...group(DRIVER_HOLDERS, DRIVER_AFFECTED, { region: 'EMEA' }), ...group(8, 0, { region: 'Americas' })]).report)?.length, 1);
});

test(`a gap under ${DRIVER_GAP} shows nothing, and one of exactly ${DRIVER_GAP} shows`, () => {
  assert.equal(driversOf(driverRun([...group(6, 3, { region: 'EMEA' }), ...group(9, 3, { region: 'Americas' })]).report), undefined);
  assert.equal(driversOf(driverRun([...group(5, 3, { region: 'EMEA' }), ...group(20, 7, { region: 'Americas' })]).report)?.[0].gap, DRIVER_GAP);
});

test('a number uses the exact-value groups of the report, with no new buckets', () => {
  const { report } = driverRun([...group(5, 4, { tenure: 3 }), ...group(4, 0, { tenure: 4 }), ...group(4, 0, { tenure: 5 })]);
  assert.deepEqual(driversOf(report)?.map(({ value, holders, others }) => [value, holders, others]), [[3, { affected: 4, reached: 5 }, { affected: 0, reached: 8 }]], 'tenure 4 and 5 stay apart, each too small alone');
});

test('a theme with no pages compares who answered a survey on the POI, as a comparison does', () => {
  const people = [...group(6, 4, { region: 'EMEA' }), ...group(4, 0, { region: 'Americas' }), ...group(5, 0, { region: 'Americas' }).map((person) => ({ ...person, asked: false }))];
  const { report } = driverRun(people, { survey: true });
  assert.deepEqual(report.themes?.[0].pages, []);
  assert.deepEqual(report.themes?.[0].drivers?.map(({ holders, others }) => [holders, others]), [[{ affected: 4, reached: 6 }, { affected: 0, reached: 4 }]], 'the five never asked are not counted as not having it');
});

test('an attribute everyone shares has nobody to compare with', () => {
  assert.equal(driversOf(driverRun(group(12, 6, { region: 'EMEA' })).report), undefined);
});

test('a log with no schema, and a theme with no first-hand personas on record, have no drivers', () => {
  const { events } = driverRun([...group(6, 4, { region: 'EMEA' }), ...group(9, 1, { region: 'Americas' })]);
  const start = events[0];
  if (start.type === 'run.started') delete start.payload.config.project.persona_schema;
  const report = buildReport(events);
  assert.ok(report.themes?.length);
  assert.equal(driversOf(report), undefined);
  const dimensions = [{ id: 'region', name: 'region', type: 'text', values: [{ value: 'EMEA', personas: 6, completion: null, with_friction: null, sentiment: null }] }] as ReportDimension[];
  assert.deepEqual(themeDrivers({ poi_id: 'poi', pages: [] } as unknown as ReportTheme, dimensions, [], [{ poi_id: 'poi', started: [], surveyed: [], pages: {} }]), []);
});

test('at most two show, the largest gap first, a persona the model never answered counts in no rate, and a rebuild is identical', () => {
  const people = [...group(6, 5, { region: 'EMEA', consent: true, tenure: 3 }), ...group(1, 0, { region: 'EMEA', consent: false, tenure: 3 }), ...group(6, 0, { region: 'Americas', consent: false, tenure: 4 })];
  const { report, events } = driverRun([...people, { attributes: { region: 'Americas', consent: true, tenure: 3 }, failed: true }]);
  assert.deepEqual(driversOf(report)?.map(({ id, gap }) => [id, gap]), [['consent', 0.8333], ['region', 0.7143]], 'three pass, and tenure is the one cut');
  assert.deepEqual(driversOf(report)?.[0].others, { affected: 0, reached: 7 });
  assert.deepEqual(buildReport(structuredClone(events)), report);
});

test('a competitor gets no drivers, and neither does an objection, which only buyers are asked', () => {
  const pois: ProjectConfig['pois'] = [
    { id: 'poi', type: 'web', name: 'Gym', start_url: 'http://localhost', allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null },
    { id: 'rival', type: 'web', name: 'Rival', start_url: 'http://rival.test', allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'observe_only', segments: null },
  ];
  const { report } = driverRun([...group(6, 4, { region: 'EMEA' }), ...group(9, 1, { region: 'Americas' })], { pois, onPoi: 'rival' });
  assert.equal(report.themes?.[0].poi_id, 'rival');
  assert.equal(report.themes?.[0].drivers, undefined);
  const mine = driverRun([...group(6, 4, { region: 'EMEA' }), ...group(9, 1, { region: 'Americas' })]).report;
  assert.deepEqual(themeDrivers({ ...mine.themes![0], category: 'objection' }, mine.dimensions!, mine.personas, mine.reach!), []);
});
