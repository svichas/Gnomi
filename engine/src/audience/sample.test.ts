import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Audience, Segment } from '../types.ts';
import { apportion, fnv1a, mulberry32, personaId, sampleTraits, slotIndex, slotSeed, type Traits } from './sample.ts';

const segment: Segment = {
  id: 'seg-2',
  name: 'Hiring managers',
  description: 'Managers who review candidates for their own jobs.',
  share: 100,
  role: 'hiring_manager',
  usage_frequency: 'weekly',
  typical_goals: ['review candidates'],
  mobile_share: 0.3,
  patience: [2, 4],
  tech_skill: [1, 3],
  account_state: 'populated',
  entry: 'email_link',
  goal_override: null,
};
const audience: Audience = {
  seed: 7,
  persona_count: 50,
  segments: [segment],
  company_size: [50, 2000],
  languages: { en: 0.85, es: 0.04, de: 0.02, fr: 0.02, pt: 0.02, hi: 0.02, zh: 0.02, ar: 0.01 },
  accessibility: { none: 0.86, low_vision: 0.05, colour_blind: 0.04, motor: 0.03, screen_reader: 0.02 },
};
const slots = (a: Audience, n: number) => Array.from({ length: n }, (_, i) => sampleTraits(a.segments[0], a, slotSeed(a.seed, a.segments[0].id, i)));

test('the hash and the generator match their reference vectors, so seeds mean the same thing forever', () => {
  assert.deepEqual([fnv1a(''), fnv1a('a'), fnv1a('foobar')], [0x811c9dc5, 0xe40c292c, 0xbf9cf968]);
  const next = mulberry32(1);
  assert.deepEqual([next(), next(), next()], [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  // Changing the sampling changes every stored population: update this only on purpose.
  assert.deepEqual(sampleTraits(segment, audience, slotSeed(7, 'seg-2', 0)), {
    segment_id: 'seg-2',
    device: 'desktop',
    patience: 2,
    tech_skill: 3,
    familiarity_with_category: 'medium',
    language: 'en',
    accessibility_needs: 'none',
    pronouns: 'he',
    company_size: 53,
    seniority: 'mid',
    motivation: 3,
  } satisfies Traits);
});

test('the same seed gives identical slot seeds and traits; another seed gives others', () => {
  assert.deepEqual(slots(audience, 30), slots(structuredClone(audience), 30));
  assert.equal(slotSeed(7, 'seg-2', 3), slotSeed(7, 'seg-2', 3));
  assert.notEqual(slotSeed(7, 'seg-2', 3), slotSeed(8, 'seg-2', 3));
  assert.notEqual(slotSeed(7, 'seg-2', 3), slotSeed(7, 'seg-3', 3));
  assert.notEqual(slotSeed(7, 'seg-2', 3), slotSeed(7, 'seg-2', 4));
  assert.notDeepEqual(slots(audience, 30), slots({ ...audience, seed: 8 }, 30));
});

test('ids are short, URL-safe and stable per segment and slot', () => {
  assert.equal(personaId('seg-2', 6), 'p-seg2-07');
  assert.equal(personaId('seg-12', 119), 'p-seg12-120');
  assert.equal(slotIndex('p-seg2-07'), 6);
  assert.equal(slotIndex('p-seg12-120'), 119);
  assert.match(personaId('Seg 3/ä', 0), /^p-[a-z0-9]+-01$/);
});

test('largest remainder splits by share, ties to the earlier segment, at least 3 per segment with a share', () => {
  assert.deepEqual(apportion([60, 30, 10], 50, 0), [30, 15, 5]);
  assert.deepEqual(apportion([1, 1, 1], 10, 0), [4, 3, 3]);
  assert.deepEqual(apportion([50, 30, 30], 100, 1), [46, 27, 27]);
  // The idea.md §8.3 example: the 5% segments are lifted to 3 and the rest is split again by share.
  assert.deepEqual(apportion([55, 25, 10, 5, 5], 50, 3), [27, 12, 5, 3, 3]);
  assert.deepEqual(apportion([97, 1, 1, 1], 20, 3), [11, 3, 3, 3]);
  assert.deepEqual(apportion([100, 0], 20, 3), [20, 0], 'a segment without a share gets nobody');
  assert.deepEqual(apportion(Array(8).fill(1), 20, 3), Array(8).fill(3), 'the minimum wins over the total when both cannot hold');

  const next = mulberry32(42);
  for (let k = 0; k < 500; k++) {
    const weights = Array.from({ length: 1 + Math.floor(next() * 6) }, () => Math.floor(next() * 100));
    const total = 20 + Math.floor(next() * 181);
    const out = apportion(weights, total, 3);
    const positive = weights.filter((w) => w > 0).length;
    assert.equal(out.reduce((s, n) => s + n, 0), positive ? Math.max(total, 3 * positive) : 0);
    weights.forEach((w, i) => assert.ok(w > 0 ? out[i] >= 3 : out[i] === 0));
  }
});

test('over 2,000 personas the traits follow the segment ranges and the population shares', () => {
  const sample = slots(audience, 2000);
  const share = (pred: (t: Traits) => boolean) => sample.filter(pred).length / sample.length;
  const near = (actual: number, expected: number, tolerance: number, what: string) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual.toFixed(3)} vs ${expected}`);

  near(share((t) => t.device === 'mobile'), 0.3, 0.03, 'mobile');
  for (const p of [2, 3, 4]) near(share((t) => t.patience === p), 1 / 3, 0.04, `patience ${p}`);
  for (const s of [1, 2, 3]) near(share((t) => t.tech_skill === s), 1 / 3, 0.04, `tech skill ${s}`);
  assert.ok(sample.every((t) => t.patience >= 2 && t.patience <= 4 && t.tech_skill >= 1 && t.tech_skill <= 3));
  assert.ok(sample.every((t) => t.familiarity_with_category === 'medium'), 'weekly use reads as medium familiarity');
  for (const [lang, p] of Object.entries(audience.languages)) near(share((t) => t.language === lang), p, 0.025, lang);
  for (const [need, p] of Object.entries(audience.accessibility)) near(share((t) => t.accessibility_needs === need), p, 0.02, need);
  near(share((t) => t.pronouns === 'she'), 0.48, 0.035, 'she');
  near(share((t) => t.pronouns === 'he'), 0.48, 0.035, 'he');
  near(share((t) => t.pronouns === 'they'), 0.04, 0.015, 'they');
  for (const [s, p] of [['junior', 0.25], ['mid', 0.4], ['senior', 0.25], ['lead', 0.1]] as const) near(share((t) => t.seniority === s), p, 0.035, s);
  for (const [m, p] of [[1, 0.1], [2, 0.25], [3, 0.35], [4, 0.2], [5, 0.1]] as const) near(share((t) => t.motivation === m), p, 0.035, `motivation ${m}`);
  // Log-uniform: half the companies sit below the range's geometric mean, a quarter below the point a quarter of the way up on a log scale.
  assert.ok(sample.every((t) => t.company_size >= 50 && t.company_size <= 2000));
  near(share((t) => t.company_size < Math.sqrt(50 * 2000)), 0.5, 0.04, 'below the geometric mean');
  near(share((t) => t.company_size < Math.sqrt(50 * Math.sqrt(50 * 2000))), 0.25, 0.04, 'bottom quarter');
});

test('editing one distribution re-samples only that trait, and key order does not matter', () => {
  const before = slots(audience, 300);
  const after = slots({ ...audience, segments: [{ ...segment, mobile_share: 0.5 }] }, 300);
  const changed = before.filter((t, i) => t.device !== after[i].device).length;
  assert.ok(changed > 30 && changed < 90, `about a fifth flip to mobile, got ${changed}`);
  before.forEach((t, i) => assert.deepEqual({ ...t, device: null }, { ...after[i], device: null }));

  const reordered = { ...audience, languages: Object.fromEntries(Object.entries(audience.languages).reverse()) };
  assert.deepEqual(slots(reordered, 300), before);
});
