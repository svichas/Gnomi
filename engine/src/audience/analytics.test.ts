import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleTraits } from '@gnomi/simulation/audience/sample.ts';
import { getPersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import type { Audience, Segment } from '@gnomi/simulation/types.ts';
import { applyAnalytics } from './analytics.ts';
import { defaultAudience } from './defaults.ts';
import { checkSavedAudience } from './file.ts';

const segment = (id: string, name: string, share: number): Segment => ({ ...defaultAudience({ name: 'Gym', role: null, goal: 'Post a job' }).segments[0], id, name, share });
const audience: Audience = { ...defaultAudience({ name: 'Gym', role: null, goal: 'Post a job' }), segments: [segment('seg-1', 'Recruiters', 50), segment('seg-2', 'Hiring managers', 30), segment('seg-3', 'Admins', 20)] };
const source = { name: 'export.csv', sha256: 'abc' };

const GA4 = `﻿# ----------------------------------------
# Tech details: Country and device, Acme "main", property
# Start date: 20260901
# End date: 20260930
# ----------------------------------------

Country,Device category,Active users,New users,Sessions
United States,mobile,"1,200",900,4000
United States,desktop,1800,700,6000
Germany,desktop,800,100,1500
Germany,mobile,200,50,400
Atlantis,desktop,500,50,700
(not set),tablet,100,10,120
Grand total,,4600,1810,12720

# ----------------------------------------
# Second table
# ----------------------------------------

Browser,Sessions
Chrome,100
`;

test('a GA4 export sets the named segment, from its active users, reads past the comment block and leaves shares alone', () => {
  const { audience: after, changes, skipped } = applyAnalytics(GA4, audience, { segment: 'seg-2' });
  const [one, two, three] = after.segments;
  assert.equal(one, audience.segments[0], 'other segments are the same objects');
  assert.equal(three, audience.segments[2]);
  assert.deepEqual(two.countries, { US: 75, DE: 25 }, 'Atlantis and (not set) are not in the mix');
  assert.equal(two.mobile_share, 0.31, '1,400 phones of 4,500 phones and desktops; a tablet is neither');
  assert.equal(two.share, 30);
  assert.equal(two.languages, undefined);
  assert.deepEqual(changes, ['Hiring managers: on a phone 25% → 31%', 'Hiring managers: countries US 75%, DE 25%']);
  assert.deepEqual(skipped, [
    'Skipped country "Atlantis": 500 active users.',
    'Skipped country "(not set)": 100 active users.',
    'Skipped device "tablet": 100 active users.',
    'Skipped country "Grand total": 4,600 active users.',
    'Skipped device "(empty)": 4,600 active users.',
    'Only the first table in the file was read.',
  ]);
  assert.deepEqual(audience.segments[1].countries, undefined, 'the input is not changed');
});

test('quoted fields keep their commas, quotes and line breaks, and the header is read in any case', () => {
  const csv = 'SEGMENT,"Total Users",Note\n"Hiring managers",2,"said ""hi"", twice\non two lines"\nRecruiters,"1,000",x\n';
  const { audience: after } = applyAnalytics(csv, audience);
  assert.deepEqual(after.segments.map((s) => s.share), [79, 1, 20], 'shares follow the counts; Admins keeps its 20%');
  assert.throws(() => applyAnalytics('country,users\n"Germany,12\n', audience, { segment: 'seg-1' }), /quoted value that never ends/);
});

test('a file with no count column or nothing to map is refused, naming what it needs', () => {
  assert.throws(() => applyAnalytics('Country,Views\nGermany,12\n', audience, { segment: 'seg-1' }), /needs a count column \(users, total users, active users, sessions\)\. It has: country, views/);
  assert.throws(() => applyAnalytics('Browser,Users\nChrome,12\n', audience, { segment: 'seg-1' }), /at least one of these columns/);
  assert.throws(() => applyAnalytics('', audience), /no rows/);
  assert.throws(() => applyAnalytics('Country,Users\nGermany,12\n', audience), /no segment column, so name the segment/);
  assert.throws(() => applyAnalytics('Country,Users\nGermany,12\n', audience, { segment: 'seg-9' }), /no segment "seg-9"/);
});

test('an unknown country is skipped and never guessed, and a row that cannot be counted is reported', () => {
  const csv = 'Country,Users\nDeutschland,10\nUK,5\ngr,1\nUnited Kingdom,3\nGreece,many\n';
  const { audience: after, skipped } = applyAnalytics(csv, audience, { segment: 'seg-1' });
  assert.deepEqual(after.segments[0].countries, { GB: 75, GR: 25 });
  assert.deepEqual(skipped, ['Skipped country "Deutschland": 10 users.', 'Skipped country "UK": 5 users.', 'Skipped users "many".']);
});

test('counts are whole numbers, so a dotted value is reported and never read as a fraction', () => {
  const { audience: after, skipped } = applyAnalytics('Country,Users\nGermany,1.234\nGreece,567\n', audience, { segment: 'seg-1' });
  assert.deepEqual(after.segments[0].countries, { GR: 100 });
  assert.deepEqual(skipped, ['Skipped users "1.234".']);
});

test('a mix whose counts are all zero is left alone and reported, so it cannot break the audience', () => {
  for (const csv of ['Country,Users\nGermany,0\n', 'Country,Users\nGermany,0\nAtlantis,5\n', 'Language,Users\nGerman,0\n']) {
    const { audience: after, changes, skipped } = applyAnalytics(csv, audience, { segment: 'seg-1', source });
    assert.deepEqual(after, audience, csv);
    assert.deepEqual(changes, [], csv);
    assert.match(skipped.at(-1)!, /Recruiters: every (country|language) row counts 0 users, so its (country|language) mix stays as it was\./, csv);
  }
  const { audience: after, skipped } = applyAnalytics('Segment,Country,Users\nRecruiters,Germany,0\nAdmins,Greece,5\n', audience);
  assert.equal(after.segments[0].countries, undefined);
  assert.deepEqual(after.segments[2].countries, { GR: 100 });
  assert.ok(skipped.includes('Recruiters: every country row counts 0 users, so its country mix stays as it was.'));
  checkSavedAudience(after, getPersonaSchema(), 'no segments');
});

test('shares that need rounding still sum to 100, each named segment keeps at least 1, and an unknown segment is reported', () => {
  const csv = 'Segment,Users\nRecruiters,1\nHiring managers,1\nAdmins,1\nEveryone else,9\n';
  const { audience: after, skipped } = applyAnalytics(csv, audience);
  assert.deepEqual(after.segments.map((s) => s.share), [34, 33, 33]);
  assert.deepEqual(skipped, ['Skipped segment "Everyone else": 9 users.']);
  const tiny = applyAnalytics('Segment,Users\nRecruiters,10000\nHiring managers,1\nAdmins,1\n', audience);
  assert.deepEqual(tiny.audience.segments.map((s) => s.share), [98, 1, 1]);
  const partial = applyAnalytics('Segment,Users\nRecruiters,3\nHiring managers,1\n', audience);
  assert.deepEqual(partial.audience.segments.map((s) => s.share), [60, 20, 20], 'the two named share what Admins leaves');
  assert.deepEqual(partial.skipped, ['Admins is not in the file, so it keeps its 20% share.']);
});

test('languages become shares that sum to 1, by code or English name, and a segment column wins over a chosen segment', () => {
  const csv = 'Segment,Language,Sessions\nAdmins,en-US,30\nAdmins,English,30\nAdmins,German,30\nAdmins,el,10\nAdmins,Klingon,5\n';
  const { audience: after, skipped } = applyAnalytics(csv, audience, { segment: 'seg-1' });
  assert.deepEqual(after.segments[2].languages, { en: 0.6, de: 0.3, el: 0.1 });
  assert.deepEqual(skipped.slice(0, 2), ['Skipped language "Klingon": 5 sessions.', 'The file has a segment column, so it covers the segments it names, not only the one chosen.']);
  assert.equal(sampleTraits({ ...after.segments[2], languages: { de: 1 } }, after, 1).language, 'de', 'sampling reads the segment');
  const withCountries = applyAnalytics('Language,Users\nGerman,5\n', { ...audience, countries: { DE: 1 } }, { segment: 'seg-1' });
  assert.match(withCountries.skipped[0], /Recruiters: the languages are kept but do nothing while a country mix applies/);
});

test('analytics on an old audience, with no countries or digest, passes the audience checks and samples from the new numbers', () => {
  const { countries: _, ...old } = { ...audience, countries: undefined };
  const csv = 'Segment,Country,Language,Device,Users\nRecruiters,Germany,German,mobile,70\nRecruiters,Greece,Greek,desktop,30\nHiring managers,Germany,German,desktop,10\n';
  const { audience: after } = applyAnalytics(csv, old as Audience, { source });
  checkSavedAudience(after, getPersonaSchema(), 'no segments');
  assert.equal(after.segments.reduce((sum, s) => sum + s.share, 0), 100);
  assert.deepEqual(after.segments[0].countries, { DE: 70, GR: 30 });
  assert.equal(after.countries, undefined, 'the audience-wide mix is untouched');
  assert.deepEqual(after.segments[0].grounding, { facts: [], remarks: [], sources: [source] }, 'only the file name and hash are kept');
  assert.equal(after.segments[2].grounding, undefined, 'a segment the file did not change names no source');
  const people = Array.from({ length: 40 }, (_, seed) => sampleTraits(after.segments[0], after, seed));
  assert.ok(people.every((p) => ['DE', 'GR'].includes(p.country!)), 'sampling stays in code and reads the segment');
  assert.ok(Array.from({ length: 40 }, (_, seed) => sampleTraits(audience.segments[0], audience, seed)).every((p) => p.country === undefined), 'a segment without a mix samples as before');
  const withMix = (countries: Record<string, number>) => ({ ...after, segments: [{ ...after.segments[0], countries }, ...after.segments.slice(1)] });
  assert.throws(() => checkSavedAudience(withMix({}), getPersonaSchema(), 'no segments'), /Recruiters: At least one country must have a positive share/);
  assert.throws(() => checkSavedAudience(withMix({ ZZ: 1 }), getPersonaSchema(), 'no segments'), /Recruiters: Unsupported country code: ZZ/);
});

test('importing the same file again changes nothing and records its source once', () => {
  const once = applyAnalytics(GA4, audience, { segment: 'seg-1', source }).audience;
  const again = applyAnalytics(GA4, once, { segment: 'seg-1', source });
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.audience, once);
});
