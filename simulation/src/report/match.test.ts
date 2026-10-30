import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchThemes, TITLE_MATCH } from './match.ts';
import { similarity } from './similarity.ts';
import type { ReportTheme } from './types.ts';

const theme = (id: string, title: string, keys?: string[], over: Partial<ReportTheme> = {}): ReportTheme => ({
  id, poi_id: 'web', rank: 1, title, description: '', named_by: 'judge', trust: 'reported', severity: 2, score: 0, personas: 1, frictions: 1,
  pages: [], elements: [], affected: [], evidence: [], seqs: [], suggestion: null, ...(keys && { keys }), ...over,
});
const ids = (themes: ReportTheme[]) => themes.map((t) => t.id);
const paired = ({ pairs }: ReturnType<typeof matchThemes>) => pairs.map((p) => [p.a.id, p.b.id, p.by]);

// Real titles from the M3 seed reports: the same problem as two runs' judges named it.
const SAME = ['Hiring manager field requires username without suggestions', 'Hiring manager field lacks user suggestions and loses draft'];

test('the same key sets match whatever the titles, ids and order', () => {
  const before = [theme('g1', 'Save does nothing', ['save'], { rank: 1 }), theme('g2', 'Prices are hidden', ['price'], { rank: 2 })];
  const after = [theme('g7', 'Plans have no price', ['price'], { rank: 1 }), theme('g3+g9', 'The job form loses work', ['save'], { rank: 2 })];
  const matched = matchThemes(before, after);
  assert.deepEqual(paired(matched), [['g1', 'g3+g9', 'keys'], ['g2', 'g7', 'keys']]);
  assert.deepEqual([matched.only_a, matched.only_b], [[], []]);
});

test('a theme one run split in two pairs with one part, the closer or else the higher ranked; the other is left over', () => {
  const merged = theme('g1+g2', 'Forms lose work', ['x', 'y']);
  const parts = [theme('g5', 'Part y', ['y'], { rank: 1 }), theme('g6', 'Part x', ['x'], { rank: 2 })];
  const tied = matchThemes([merged], parts);
  assert.deepEqual(paired(tied), [['g1+g2', 'g5', 'keys']]);
  assert.deepEqual(ids(tied.only_b), ['g6']);

  const closer = matchThemes([theme('g1+g2+g3', 'Forms lose work', ['x', 'y', 'z'])], [theme('g5', 'Part x', ['x'], { rank: 1 }), theme('g6', 'Parts y and z', ['y', 'z'], { rank: 2 })]);
  assert.deepEqual(paired(closer), [['g1+g2+g3', 'g6', 'keys']]);
  assert.deepEqual(ids(closer.only_b), ['g5']);
});

test('the same problem under another title and with no shared keys matches by title; different problems do not', () => {
  assert.ok(similarity(SAME).max > TITLE_MATCH, 'the seed pair clears the threshold');
  const matched = matchThemes(
    [theme('g1', SAME[0], ['field']), theme('g2', 'Jobs navigation link leads to 404 page', ['nav'])],
    [theme('g4', SAME[1], ['draft']), theme('g5', 'Candidates page is only a placeholder', ['list'])],
  );
  assert.deepEqual(paired(matched), [['g1', 'g4', 'title']]);
  assert.deepEqual([ids(matched.only_a), ids(matched.only_b)], [['g2'], ['g5']]);
});

test('a shared key beats a closer title, and a theme paired by keys is not paired again by title', () => {
  const matched = matchThemes([theme('g1', 'Save does nothing', ['save'])], [theme('g2', 'The form loses work', ['save'], { rank: 2 }), theme('g3', 'Save does nothing', ['other'], { rank: 1 })]);
  assert.deepEqual(paired(matched), [['g1', 'g2', 'keys']]);
  assert.deepEqual(ids(matched.only_b), ['g3']);
});

test('themes on different POIs never match, even with the same keys and title', () => {
  const matched = matchThemes([theme('g1', 'Save does nothing', ['save'])], [theme('g1', 'Save does nothing', ['save'], { poi_id: 'other' })]);
  assert.deepEqual(matched.pairs, []);
  assert.equal(matched.only_a.length + matched.only_b.length, 2);
});

test('empty inputs match nothing and keep the other side whole', () => {
  const one = [theme('g1', 'Save does nothing', ['save'])];
  assert.deepEqual(matchThemes([], []), { pairs: [], only_a: [], only_b: [] });
  assert.deepEqual(matchThemes(one, []), { pairs: [], only_a: one, only_b: [] });
  assert.deepEqual(matchThemes([], one), { pairs: [], only_a: [], only_b: one });
});

test('a report from before keys still matches, by title', () => {
  const matched = matchThemes([theme('g1', SAME[0]), theme('g2', 'Reported friction on /jobs', undefined, { named_by: 'rules' })], [theme('g1', SAME[1], ['draft']), theme('g2', 'Reported friction on /jobs', undefined, { named_by: 'rules' })]);
  assert.deepEqual(paired(matched), [['g2', 'g2', 'title'], ['g1', 'g1', 'title']], 'closest first');
});

test('rules titles with keys are not compared: the template makes two different pages look alike', () => {
  const rules = { named_by: 'rules' } as const;
  assert.ok(similarity(['Reported friction on /jobs/new', 'Reported friction on /jobs/edit']).max > TITLE_MATCH);
  assert.deepEqual(matchThemes([theme('g1', 'Reported friction on /jobs/new', ['a'], rules)], [theme('g1', 'Reported friction on /jobs/edit', ['b'], rules)]).pairs, []);
});
