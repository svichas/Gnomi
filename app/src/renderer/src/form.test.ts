import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import type { ProjectConfig, RunSettings, SessionInfo, WebPoi } from '@gnomi/simulation/types.ts';
import { getPersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import { draftComparison } from '@gnomi/simulation/comparison/config.ts';
import { blankAudience } from './audience.ts';
import { hostOf, initialDraft, offeredHosts, problemFor, rolesInUse, startHost, toConfig } from './form.ts';
import type { Draft, Form } from './form.ts';
import { nextPoiId, POI_KINDS, type PoiDraft } from './poi/index.ts';
import type { WebDraft } from './poi/web.ts';

/** A project with one web app; `changes` may set the project's fields and that web app's. */
const form = (changes: Partial<Omit<Form, 'pois'> & Omit<WebDraft, 'id' | 'type'>> = {}, rest: Partial<Omit<Draft, 'form'>> = {}): Draft => {
  const { url = 'http://localhost:3000', production, reset, allowed, mode, segments, ...project } = changes;
  const web = { ...POI_KINDS.web.blank('poi-1'), url, ...(production !== undefined && { production }), ...(reset !== undefined && { reset }), ...(allowed && { allowed }), ...(mode && { mode }), ...(segments !== undefined && { segments }) };
  return { form: { ...initialDraft(null).form, name: 'Gym', goal: 'Post a job', ...project, pois: [web] }, settings: DEFAULT_SETTINGS, audience: null, ...rest };
};
const only = (config: ProjectConfig | string) => {
  assert.ok(typeof config !== 'string', String(config));
  return config.pois[0] as WebPoi;
};

test('comparison setup survives form round trips and rejects removed target references', () => {
  const config = toConfig(form());
  assert.ok(typeof config !== 'string');
  config.pois.push({ ...config.pois[0]!, id: 'poi-2', name: 'Alternative' });
  config.comparison = draftComparison(config);
  const draft = initialDraft(config);
  assert.deepEqual(toConfig(draft), config);
  draft.form.comparison!.question = 'A changed decision';
  assert.notEqual(config.comparison.question, draft.form.comparison!.question, 'draft does not mutate saved inputs');
  draft.form.pois.pop();
  assert.match(String(toConfig(draft)), /comparison/i);
});

test('comparison uses only target-bound sessions, independently of audience roles', () => {
  const config = toConfig(form({ role: 'legacy-role' }));
  assert.ok(typeof config !== 'string');
  config.pois.push({ ...config.pois[0]!, id: 'poi-2', name: 'Alternative' });
  config.comparison = draftComparison(config);
  assert.deepEqual(rolesInUse(config), []);
  config.comparison.targets[1]!.access_scope = 'authenticated_workflow';
  config.comparison.targets[1]!.session_role = 'alternative-admin';
  assert.deepEqual(rolesInUse(config), ['alternative-admin']);
});

test('hostOf takes a bare host, a host with a port, or a whole address, and refuses anything else', () => {
  assert.equal(hostOf('cdn.example.com'), 'cdn.example.com');
  assert.equal(hostOf('  CDN.Example.com:8443 '), 'cdn.example.com');
  assert.equal(hostOf('https://api.example.com/v1/x?y=1#z'), 'api.example.com');
  assert.equal(hostOf('127.0.0.1:3000'), '127.0.0.1');
  assert.equal(hostOf('not a host'), null);
  assert.equal(hostOf(''), null);
});

test('startHost is only for http(s) addresses', () => {
  assert.equal(startHost('http://localhost:3000/x'), 'localhost');
  assert.equal(startHost('localhost:3000'), null); // parses as a URL with the scheme "localhost:"
  assert.equal(startHost('ftp://example.com'), null);
});

test('a public host needs no staging marker or confirmation', () => {
  const config = toConfig(form({ url: 'https://app.acme.com' }));
  assert.ok(typeof config !== 'string', String(config));
  assert.equal(only(config).start_url, 'https://app.acme.com');
});

test('toConfig builds the POI with its safety settings and names what is missing', () => {
  assert.equal(toConfig(form({ name: ' ' })), 'Give the project a name.');
  assert.match(String(toConfig(form({ url: 'staging.example.com' }))), /full web address/);
  assert.equal(toConfig(form({ goal: '' })), 'Say what the persona should try to do.');
  assert.match(String(toConfig(form({ production: 'acme.com, not a domain' }))), /"not a domain" is not a domain name/);
  assert.match(String(toConfig(form({ reset: 'nope' }))), /reset hook/);

  const config = toConfig(
    form({ production: 'Acme.com, https://app.acme.com/x, acme.com', reset: ' http://localhost:3000/reset ', allowed: ['cdn.example.com', 'localhost', 'cdn.example.com'], role: 'recruiter' }),
  );
  assert.ok(typeof config !== 'string');
  assert.deepEqual(only(config), {
    id: 'poi-1',
    type: 'web',
    name: 'localhost',
    mode: 'full',
    segments: null,
    start_url: 'http://localhost:3000',
    allowed_hosts: ['cdn.example.com'], // the start page's own host is always allowed, so it is not listed
    production_domains: ['acme.com', 'app.acme.com'],
    reset_hook_url: 'http://localhost:3000/reset',
  });
  assert.equal(config.role, 'recruiter');
});

test('a project saved before M1 or M5 opens with its one web app, empty safety settings and logged out', () => {
  const before = { name: 'Gym', description: 'd', goal: 'g', poi: { id: 'poi-1', type: 'web', name: 'localhost', start_url: 'http://localhost:3000' } };
  const draft = initialDraft(before as unknown as ProjectConfig);
  assert.deepEqual(draft, {
    form: {
      name: 'Gym',
      description: 'd',
      goal: 'g',
      role: null,
      pois: [{ id: 'poi-1', type: 'web', name: '', segments: null, mode: 'full', url: 'http://localhost:3000', production: '', reset: '', allowed: [] }],
    },
    settings: DEFAULT_SETTINGS,
    audience: null,
  });
  assert.equal(only(toConfig(draft)).name, 'localhost', 'a web app named after its host keeps following it');
});

test('a competitor, observed only, drops its reset hook while our own product keeps it', () => {
  const rival = only(toConfig(form({ url: 'https://rival.com/pricing', mode: 'observe_only', reset: 'https://rival.com/reset' })));
  assert.deepEqual([rival.mode, rival.reset_hook_url], ['observe_only', null]);
  assert.equal(only(toConfig(form({ url: 'https://rival.com/pricing', mode: 'full' }))).mode, 'full');
});

test('POIs keep their order, names, modes and segments, and a problem says which POI has it', () => {
  const web = (id: string, url: string, over: Partial<WebPoi> = {}): WebPoi => ({ id, type: 'web', name: id, mode: 'full', segments: null, start_url: url, allowed_hosts: [], production_domains: [], reset_hook_url: null, ...over });
  const pois = [
    web('poi-2', 'http://localhost:3000/locale', { name: 'Locale', segments: ['seg-a'] }),
    { id: 'poi-3', type: 'text' as const, name: 'Pricing copy', segments: null, asset: '0123456789abcdef.md' },
    web('poi-1', 'http://localhost:3000/', { name: 'Competitor', mode: 'observe_only' }),
  ];
  const draft = initialDraft({ name: 'Gym', description: '', goal: 'g', role: null, audience: null, settings: DEFAULT_SETTINGS, pois });
  const saved = toConfig(draft);
  assert.ok(typeof saved !== 'string');
  assert.deepEqual(saved.pois, pois);
  const broken: PoiDraft[] = draft.form.pois.map((poi) => (poi.id === 'poi-1' ? { ...poi, url: 'nope' } : poi));
  assert.equal(toConfig({ ...draft, form: { ...draft.form, pois: broken } }), 'Competitor: The start page needs a full web address, such as https://staging.example.com.');
  assert.equal(toConfig({ ...draft, form: { ...draft.form, pois: [] } }), 'Add a point of interest for the personas to try.');
  assert.deepEqual(initialDraft(null).form.pois, [POI_KINDS.web.blank('poi-1')], 'a new project starts with one web app');
  assert.equal(nextPoiId(draft.form.pois), 'poi-4');
});

test('offeredHosts lists recorded, allowed and added hosts once each, never the start page', () => {
  const session = (hosts: string[]): SessionInfo => ({ role: 'r', start_url: 'http://localhost/', hosts, recorded_at: 1, verified_at: null, expires_at: null });
  assert.deepEqual(
    offeredHosts([session(['localhost', 'cdn.example.com', 'API.example.com']), session(['cdn.example.com'])], ['api.example.com', 'old.example.com'], ['new.example.com'], 'localhost'),
    ['api.example.com', 'cdn.example.com', 'new.example.com', 'old.example.com'],
  );
});

test('social rounds need a whole number of rounds from 1 to 10 only while they are on', () => {
  const settings = (changes: Partial<RunSettings>) => form({}, { settings: { ...DEFAULT_SETTINGS, ...changes } });
  assert.equal(typeof toConfig(settings({ social: true, rounds: 5 })), 'object');
  assert.equal(typeof toConfig(settings({ social: true, rounds: undefined })), 'object', 'an older project gets the default');
  for (const rounds of [0, 11, 2.5]) assert.match(String(toConfig(settings({ social: true, rounds }))), /^Settings: social rounds must be a whole number from 1 to 10/);
  assert.equal(typeof toConfig(settings({ social: false, rounds: 0 })), 'object');
});

test('the run settings are checked, and a problem is worded for the tab that shows it', () => {
  const settings = (changes: Partial<RunSettings>) => form({}, { settings: { ...DEFAULT_SETTINGS, ...changes } });
  assert.equal(typeof toConfig(settings({})), 'object');
  assert.match(String(toConfig(settings({ concurrency: 33 }))), /^Settings: concurrency must be a whole number from 1 to 32/);
  assert.match(String(toConfig(settings({ concurrency: 0 }))), /concurrency/);
  for (const persona_concurrency of [0, 33, 1.5]) assert.match(String(toConfig(settings({ persona_concurrency }))), /writer concurrency/);
  assert.equal(typeof toConfig(settings({ persona_concurrency: undefined })), 'object', 'older projects use the writer default');
  assert.match(String(toConfig(settings({ cost_budget_usd: 0 }))), /cost budget/);
  assert.match(String(toConfig(settings({ wall_clock_budget_min: -1 }))), /time budget/);
  assert.match(String(toConfig(settings({ local_base_url: 'localhost:11434' }))), /local endpoint/);
  const local = { ...DEFAULT_SETTINGS.routing, navigator: { provider: 'openai_compatible' as const, model: 'gemma4:e4b' } };
  assert.match(String(toConfig(settings({ routing: local }))), /navigator uses the local endpoint/);
  assert.equal(typeof toConfig(settings({ routing: local, local_base_url: ' http://localhost:11434/v1 ' })), 'object');
  assert.match(String(toConfig(settings({ routing: { ...DEFAULT_SETTINGS.routing, judge: { provider: 'anthropic', model: ' ' } } }))), /model for the judge/);

  assert.equal(problemFor('Settings: concurrency must be a whole number from 1 to 32.', 'settings'), 'concurrency must be a whole number from 1 to 32.');
  assert.equal(problemFor('Settings: concurrency must be a whole number from 1 to 32.', 'project'), 'Settings: concurrency must be a whole number from 1 to 32.');
  assert.equal(problemFor('Give the project a name.', 'audience'), 'On the Project tab: Give the project a name.');
  assert.equal(problemFor('Give the project a name.', 'project'), 'Give the project a name.');
});

test('the audience goes into the project cleaned up, or stops the save with a sentence', () => {
  const audience = blankAudience('An ATS');
  audience.segments[0] = { ...audience.segments[0], name: ' Recruiters ', typical_goals: ['post jobs', '  ', ' screen '], goal_override: '  ' };
  const config = toConfig(form({}, { audience }));
  assert.ok(typeof config !== 'string');
  assert.deepEqual(config.audience?.segments[0].typical_goals, ['post jobs', 'screen']);
  assert.equal(config.audience?.segments[0].name, 'Recruiters');
  assert.equal(config.audience?.segments[0].goal_override, null);
  const single = toConfig(form({}, { audience: { ...audience, persona_count: 1 } }));
  assert.ok(typeof single !== 'string');
  assert.equal(single.audience?.persona_count, 1);
  assert.match(String(toConfig(form({}, { audience: { ...audience, persona_count: 0 } }))), /^Audience: the persona count/);
});

test('profile schemas round-trip only when configured and invalid schemas stop project save', () => {
  assert.equal(Object.hasOwn(initialDraft(null), 'persona_schema'), false);
  const original = toConfig(form());
  assert.ok(typeof original !== 'string');
  assert.equal(Object.hasOwn(original, 'persona_schema'), false);
  const persona_schema = getPersonaSchema();
  persona_schema.attributes.find((attribute) => attribute.id === 'employer')!.enabled = false;
  const configured = toConfig(form({}, { persona_schema }));
  assert.ok(typeof configured !== 'string');
  assert.deepEqual(initialDraft(configured).persona_schema, persona_schema);
  persona_schema.attributes.find((attribute) => attribute.id === 'name')!.enabled = false;
  assert.match(String(toConfig(form({}, { persona_schema }))), /^Audience:.*Core/);
});
