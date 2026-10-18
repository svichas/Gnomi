import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PERSONA } from '../persona.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { Audience, DesignPoi, Poi, ProjectConfig, Segment, TextPoi, WebPoi } from '../types.ts';
import { poiBudget, preflight, RUNNERS } from './index.ts';
import { assetPlaces, isEligible, loginPoi, placeName, poisFor, withPois } from './pois.ts';

const web = (id: string, over: Partial<WebPoi> = {}): WebPoi => ({
  id, type: 'web', name: id, mode: 'full', segments: null, start_url: 'http://gym.test/', allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null, ...over,
});
const text: TextPoi = { id: 'copy', type: 'text', name: 'Pricing copy', segments: null, asset: '0123456789abcdef.md' };
const design: DesignPoi = { id: 'frames', type: 'design', name: 'Checkout frames', segments: null, frames: [{ asset: '0123456789abcdef.png', name: null }] };
const segment = (id: string, over: Partial<Segment> = {}): Segment => ({
  id, name: id, description: '', share: 50, role: null, usage_frequency: 'weekly', typical_goals: [], mobile_share: 0, patience: [3, 3], tech_skill: [3, 3],
  account_state: 'populated', entry: 'direct', goal_override: null, ...over,
});
const audience = (segments: Segment[]): Audience => ({
  seed: 1, persona_count: 20, segments, company_size: [50, 2000], languages: { en: 1 }, accessibility: { none: 1, low_vision: 0, colour_blind: 0, screen_reader: 0, motor: 0 },
});
const project = (pois: Poi[], over: Partial<ProjectConfig> = {}): ProjectConfig => ({
  name: 'Gym', description: '', pois, goal: 'Post a job', role: null, audience: null, settings: DEFAULT_SETTINGS, ...over,
});

test('a project or run saved with one poi reads as a list of that one POI, in full mode, for every segment', () => {
  const legacy = { name: 'Gym', poi: { id: 'poi-1', type: 'web' as const, name: 'Gym', start_url: 'http://gym.test/' } };
  assert.deepEqual(withPois(legacy), {
    name: 'Gym',
    pois: [{ ...legacy.poi, mode: 'full', segments: null, allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null }],
  });
  const current = { name: 'Gym', pois: [web('a'), text] };
  assert.deepEqual(withPois(current), current, 'a project with pois is left as it is');
  assert.deepEqual(withPois({ name: 'Empty', poi: undefined }), { name: 'Empty', pois: [] });
});

test('users see every POI by default and buyers only what they perceive; an explicit list wins either way', () => {
  const user = segment('seg-user');
  const unmarked = segment('seg-old'); // saved before segments had a kind
  const buyer = segment('seg-buyer', { kind: 'buyer' });
  for (const poi of [web('app'), text, design]) {
    assert.equal(isEligible(poi, user), true, `${poi.type} for users`);
    assert.equal(isEligible(poi, unmarked), true, `${poi.type} for segments without a kind`);
    assert.equal(isEligible(poi, buyer), poi.type !== 'web', `${poi.type} for buyers`);
    assert.equal(isEligible(poi, null), true, `${poi.type} for the built-in persona`);
  }
  assert.equal(isEligible(web('app', { segments: ['seg-buyer'] }), buyer), true);
  assert.equal(isEligible(web('app', { segments: ['seg-buyer'] }), user), false);
  assert.equal(isEligible({ ...text, segments: [] }, buyer), false);
});

test('a segment gets its POIs in the order the project lists them', () => {
  const pois = [text, web('first'), design, web('second', { segments: ['seg-a'] }), web('third')];
  assert.deepEqual(poisFor(pois, segment('seg-a')).map((p) => p.id), ['copy', 'first', 'frames', 'second', 'third']);
  assert.deepEqual(poisFor(pois, segment('seg-b')).map((p) => p.id), ['copy', 'first', 'frames', 'third']);
  assert.deepEqual(poisFor(pois, segment('seg-b', { kind: 'buyer' })).map((p) => p.id), ['copy', 'frames']);
  assert.equal(loginPoi([text, web('watch', { mode: 'observe_only' }), web('app')])?.id, 'app', 'logins are recorded on the first web POI in full mode');
});

test('the registry lets a text run and blocks a run with a reason, such as a segment without a POI', () => {
  assert.equal(preflight(project([web('app')])), null);
  assert.equal(preflight(project([web('app'), text])), null, 'a text with its text runs');
  assert.equal(preflight(project([])), 'Add a point of interest for the personas to try.');
  assert.match(preflight(project([web('app', { start_url: 'https://acme.com/' })])) ?? '', /does not look like a staging or test address/, 'the web runner keeps the production guard');
  const buyers = audience([segment('seg-a'), segment('seg-buyers', { name: 'Buyers', kind: 'buyer' })]);
  assert.equal(preflight(project([web('app')], { audience: buyers })), 'No point of interest is open to the "Buyers" segment. Choose one for it, or give the segment no share.');
  const idle = audience([segment('seg-a'), segment('seg-buyers', { kind: 'buyer', share: 0 })]);
  assert.equal(preflight(project([web('app')], { audience: idle })), null, 'a segment without a share runs no personas');
});

test('step budgets scale by POI type: web keeps the patience budget, text and designs take far fewer', () => {
  const patient = { ...BUILTIN_PERSONA, patience: 5 }; // 60 steps
  assert.equal(poiBudget(patient, web('app')), 60);
  assert.ok(poiBudget(patient, text) < 10);
  assert.ok(poiBudget(patient, design) < 10);
  assert.deepEqual(Object.keys(RUNNERS).sort(), ['design', 'text', 'web']);
});

test('a text POI is refused without its text: no asset, an asset that is not text, or a file that is not in assets/', () => {
  assert.equal(preflight(project([{ ...text, asset: '' }])), '"Pricing copy" has no text yet. Paste the text or choose a .md or .txt file for it.');
  assert.match(preflight(project([{ ...text, asset: '0123456789abcdef.png' }])) ?? '', /has no text yet/, 'an image is not a text');
  const check = RUNNERS.text.preflight as (poi: TextPoi, project: ProjectConfig, hasAsset: (id: string) => boolean) => string | null;
  assert.equal(check(text, project([text]), () => false), 'The text of "Pricing copy" is missing from the project\'s files. Paste it or choose the file again.');
  assert.equal(check(text, project([text]), (id) => id === text.asset), null);
});

test('a text or design is named by its POI, never by its stored file; a page keeps its URL', () => {
  const flow: DesignPoi = { ...design, frames: [{ asset: 'aaaaaaaaaaaaaaaa.png', name: 'Cart' }, { asset: 'bbbbbbbbbbbbbbbb.png', name: null }] };
  const places = assetPlaces([web('site'), text, design, flow]);
  assert.equal(placeName('asset:0123456789abcdef.md', places), 'Pricing copy');
  assert.equal(placeName('asset:0123456789abcdef.png', places), 'Checkout frames', 'a one-screen design is just its name');
  assert.equal(placeName('asset:aaaaaaaaaaaaaaaa.png', places), 'Checkout frames, screen 1 "Cart"');
  assert.equal(placeName('asset:bbbbbbbbbbbbbbbb.png', places), 'Checkout frames, screen 2');
  assert.equal(placeName('asset:ffffffffffffffff.md', places), 'a text', 'a file no POI names is still not shown');
  assert.equal(placeName('http://gym.test/jobs', places), 'http://gym.test/jobs');
});
