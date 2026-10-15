import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Persona } from '@gnomi/engine/types.ts';
import { addedSeed, GENERATION, personaId, slotSeed } from '../../../../engine/src/audience/sample.ts';
import { addedByHand, addSegment, audienceProblem, blankAudience, distribution, personaMinimum, rebalance, removeSegment, setShare } from './audience.ts';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
// A small seeded generator, so a failure can be reproduced.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('moving one share rescales the others in proportion and the total stays 100', () => {
  assert.deepEqual(rebalance([55, 25, 10, 5, 5], 0, 60), [60, 22, 9, 5, 4]);
  assert.deepEqual(rebalance([50, 50], 0, 70), [70, 30]);
  assert.deepEqual(rebalance([34, 33, 33], 1, 0), [51, 0, 49]);
  assert.deepEqual(rebalance([100], 0, 40), [100], 'a single segment is always everyone');
  assert.deepEqual(rebalance([100, 0, 0], 0, 40), [40, 30, 30], 'with nothing to scale, the others split what is left evenly');
  assert.deepEqual(rebalance([40, 60], 1, 100), [0, 100]);
});

test('whatever the slider does, shares are whole percents that add up to exactly 100', () => {
  const next = random(7);
  for (let round = 0; round < 500; round++) {
    const n = 2 + Math.floor(next() * 7);
    const shares = rebalance(Array.from({ length: n }, () => Math.floor(next() * 100)), 0, Math.floor(next() * 101));
    const index = Math.floor(next() * n);
    const value = Math.floor(next() * 101);
    const after = rebalance(shares, index, value);
    assert.equal(sum(after), 100, `${shares} -> ${after}`);
    assert.equal(after[index], value);
    assert.ok(after.every((share) => Number.isInteger(share) && share >= 0));
    // The others keep their order of size, within the rounding of whole percents.
    const before = shares.filter((_, i) => i !== index);
    const moved = after.filter((_, i) => i !== index);
    if (sum(before) > 0) before.forEach((share, i) => assert.ok(Math.abs(moved[i] - (share * (100 - value)) / sum(before)) < 1, `${shares} ${index}=${value} -> ${after}`));
  }
});

test('adding a segment takes an even slice, removing one hands its share back in proportion', () => {
  const base = { ...blankAudience('d'), segments: setShare(addSegment(blankAudience('d')), 'seg-1', 75).segments };
  assert.deepEqual(base.segments.map((s) => s.share), [75, 25]);
  const three = addSegment(base);
  assert.deepEqual(three.segments.map((s) => [s.id, s.share]), [['seg-1', 50], ['seg-2', 17], ['seg-3', 33]]);
  const two = removeSegment(three, 'seg-2');
  assert.deepEqual(two.segments.map((s) => [s.id, s.share]), [['seg-1', 60], ['seg-3', 40]]);
  assert.equal(removeSegment(blankAudience('d'), 'seg-1').segments.length, 1, 'the last segment stays');
});

test('the audience is checked before it is saved', () => {
  const audience = blankAudience('An ATS');
  assert.equal(audienceProblem(audience), null);
  assert.match(String(audienceProblem({ ...audience, persona_count: 2 })), /from 3 to 200/);
  assert.match(String(audienceProblem({ ...audience, persona_count: 201 })), /from 3 to 200/);
  assert.match(String(audienceProblem({ ...audience, persona_count: 12.5 })), /whole number/);
  assert.match(String(audienceProblem({ ...audience, segments: [{ ...audience.segments[0], name: ' ' }] })), /name/);
  assert.match(String(audienceProblem({ ...audience, segments: [{ ...audience.segments[0], patience: [4, 2] }] })), /patience/);
  assert.match(String(audienceProblem({ ...audience, segments: [] })), /at least one segment/);
  const two = addSegment(audience);
  assert.equal(personaMinimum(two), 6);
  assert.match(String(audienceProblem({ ...two, persona_count: 5 })), /from 6 to 200/);
  assert.equal(personaMinimum(setShare(two, 'seg-1', 100)), 3, 'a segment with no share needs no personas');
});

test('the population is counted per value, most common first or in the order asked for', () => {
  const people = ['desktop', 'mobile', 'desktop'].map((device) => ({ device }) as Persona);
  assert.deepEqual(distribution(people, (p) => p.device), [['desktop', 2], ['mobile', 1]]);
  assert.deepEqual(distribution(people, (p) => p.device, ['mobile', 'desktop', 'tablet']), [['mobile', 1], ['desktop', 2], ['tablet', 0]]);
});

test('a persona the user added is told apart from one the shares allot, by the engine\'s own seeds', () => {
  const person = (segment: string, index: number, seed: number) => ({ id: personaId(segment, index), segment_id: segment, seed }) as Persona;
  assert.equal(addedByHand(person('seg-2', 6, slotSeed(99, 'seg-2', 6)), 99), false, 'allotted by the share');
  assert.equal(addedByHand(person('seg-2', 9, addedSeed(99, 'seg-2', 9)), 99), true, 'added with Add persona');
  assert.equal(addedByHand(person('seg-2', 9, addedSeed(99, 'seg-2', 9) + 2 * GENERATION), 99), true, 'and still after regenerating it');
  assert.equal(addedByHand(person('seg-2', 6, slotSeed(99, 'seg-2', 6) + GENERATION), 99), false, 'a regenerated allotted persona is still allotted');
  assert.equal(addedByHand(person('seg-2', 9, addedSeed(99, 'seg-2', 9)), 100), false, 'seeded under another audience seed: not recognised, so it is treated as allotted');
  assert.equal(addedByHand({ ...person('seg-2', 9, addedSeed(99, 'seg-2', 9)), segment_id: null }, 99), false, 'the built-in persona has no segment');
  assert.equal(addedByHand(person('seg-2', 9, addedSeed(99, 'seg-2', 9)), null), false, 'no saved audience');
});
