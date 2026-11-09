import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReportBox, ReportPicture, ReportReach, ReportTheme } from '../types.ts';
import { ACROSS_SCREENS, screenName, screensOf } from './screens.ts';

const theme = (id: string, pages: string[], pictures?: ReportPicture[], poi_id = 'app') => ({ id, poi_id, pages, ...(pictures && { pictures }) }) as unknown as ReportTheme;
const box = (left: number, element = 'button "Save"'): ReportBox => ({ left, top: 10, width: 10, height: 10, element });
const pic = (page: string, screenshot: string, marked?: ReportBox): ReportPicture => ({ page, screenshot, ...(marked && { box: marked }), persona_id: 'p-1', step_seq: 1 });
const ids = (themes: { theme: ReportTheme }[]) => themes.map((f) => f.theme.id);
const reach = (pages: Record<string, string[]>, poi_id = 'app'): ReportReach => ({ poi_id, started: [], surveyed: [], pages });

test('a theme is listed under each of its pages up to ACROSS_SCREENS - 1; from ACROSS_SCREENS on it is one site-wide group', () => {
  assert.equal(ACROSS_SCREENS, 4);
  const three = theme('t3', ['a', 'b', 'c']);
  const four = theme('t4', ['a', 'b', 'c', 'd']);
  const screens = screensOf([three, four]);
  assert.deepEqual(screens.map((s) => [s.kind, s.page, ids(s.findings)]), [
    ['page', 'a', ['t3']],
    ['page', 'b', ['t3']],
    ['page', 'c', ['t3']],
    ['across', null, ['t4']],
  ]);
});

test('a theme with no page goes to its POI\'s none group, after the across group; empty groups are left out', () => {
  const screens = screensOf([theme('survey', []), theme('page', ['a']), theme('wide', ['w', 'x', 'y', 'z'])]);
  assert.deepEqual(screens.map((s) => [s.kind, s.page, s.reached, s.picture, ids(s.findings)]), [
    ['page', 'a', null, null, ['page']],
    ['across', null, null, null, ['wide']],
    ['none', null, null, null, ['survey']],
  ]);
});

test('POIs come in the order they first appear, each with its own screens and numbering', () => {
  const screens = screensOf([theme('w1', ['a'], undefined, 'web'), theme('d1', ['Checkout'], undefined, 'design'), theme('w2', ['a'], undefined, 'web')]);
  assert.deepEqual(screens.map((s) => [s.poi_id, s.page, s.findings.map((f) => [f.theme.id, f.number])]), [
    ['web', 'a', [['w1', 1], ['w2', 2]]],
    ['design', 'Checkout', [['d1', 1]]],
  ]);
});

test('pages by personas who reached them, ties in first-reached order, pages reach does not name last in order of appearance', () => {
  const themes = [theme('t1', ['gone', 'late', 'early']), theme('t2', ['busy', 'other'])];
  const screens = screensOf(themes, [reach({ early: ['p1'], busy: ['p1', 'p2', 'p3'], late: ['p2'] }), reach({ x: ['p1'] }, 'elsewhere')]);
  assert.deepEqual(screens.map((s) => [s.page, s.reached]), [['busy', 3], ['early', 1], ['late', 1], ['gone', null], ['other', null]]);
  assert.deepEqual(screensOf(themes).map((s) => s.page), ['gone', 'late', 'early', 'busy', 'other'], 'without reach, the order of first appearance');
});

test('the lead is the picture on that page of the first finding that has one; findings are numbered per screen in the order given', () => {
  const screens = screensOf([theme('none', ['a', 'b']), theme('first', ['b', 'a'], [pic('b', 'shots/b1.jpg'), pic('a', 'shots/a1.jpg')]), theme('second', ['a'], [pic('a', 'shots/a2.jpg')])]);
  const [a, b] = screens;
  assert.deepEqual([a.page, a.picture?.screenshot, a.findings.map((f) => [f.theme.id, f.number, f.picture?.screenshot])], ['a', 'shots/a1.jpg', [['none', 1, undefined], ['first', 2, 'shots/a1.jpg'], ['second', 3, 'shots/a2.jpg']]]);
  assert.deepEqual([b.page, b.picture?.screenshot, b.findings.map((f) => f.number)], ['b', 'shots/b1.jpg', [1, 2]]);
  assert.ok(!('picture' in a.findings[0]), 'a finding with no picture on this page has none');
});

test('pins only for findings whose picture is the lead\'s own file and has a box; an identical box is one pin', () => {
  const lead = 'shots/p-1-0003.jpg';
  const screens = screensOf([
    theme('lead', ['a'], [pic('a', lead, box(10))]),
    theme('other-file', ['a'], [pic('a', 'shots/p-2-0001.jpg', box(50))]),
    theme('no-box', ['a'], [pic('a', lead)]),
    theme('same-box', ['a'], [pic('a', lead, box(10))]),
    theme('own-box', ['a'], [pic('a', lead, box(70, 'link "Help"'))]),
  ]);
  const [a] = screens;
  assert.equal(a.picture?.screenshot, lead);
  assert.deepEqual(a.findings.map((f) => [f.number, f.pinned]), [[1, true], [2, false], [3, false], [4, true], [5, true]]);
  assert.deepEqual(a.pins, [{ box: box(10), numbers: [1, 4] }, { box: box(70, 'link "Help"'), numbers: [5] }]);
});

test('the across group has no lead and no pins, and each finding there keeps its first picture', () => {
  const wide = theme('wide', ['a', 'b', 'c', 'd'], [pic('b', 'shots/b.jpg', box(10)), pic('c', 'shots/c.jpg')]);
  const [across] = screensOf([wide]);
  assert.deepEqual([across.kind, across.picture, across.pins, across.findings[0].picture?.screenshot, across.findings[0].pinned], ['across', null, [], 'shots/b.jpg', false]);
});

test('a screen reads as a path for a web page and by its name for a text or design', () => {
  assert.equal(screenName('gym.test/jobs/:id'), '/jobs/:id');
  assert.equal(screenName('Checkout, screen 2'), 'Checkout, screen 2');
  assert.equal(screenName('localhost:3001/jobs/new'), '/jobs/new');
  assert.equal(screenName('gym.test/'), '/');
  assert.equal(screenName('Checkout, screen 2 "Desktop / Payment"'), 'Checkout, screen 2 "Desktop / Payment"', 'a frame name keeps its slash');
});

test('the lead is the screenshot most findings are marked on, so pins of several personas share it; ties go to the first finding\'s', () => {
  const lead = 'shots/p-3-0002.jpg';
  const [a] = screensOf([
    theme('own', ['a'], [pic('a', 'shots/p-1-0001.jpg', box(10))]),
    theme('no-element', ['a'], [pic('a', 'shots/p-2-0001.jpg')]),
    theme('on-lead', ['a'], [pic('a', lead, box(30, 'link "Jobs"'))]),
    theme('on-lead-too', ['a'], [pic('a', lead, box(50, 'link "Help"'))]),
  ]);
  assert.equal(a.picture?.screenshot, lead);
  assert.deepEqual(a.findings.map((f) => f.pinned), [false, false, true, true]);
  assert.deepEqual(a.pins.map((p) => p.numbers), [[3], [4]]);
  const [tie] = screensOf([theme('first', ['a'], [pic('a', 'shots/1.jpg', box(10))]), theme('second', ['a'], [pic('a', 'shots/2.jpg', box(10))])]);
  assert.equal(tie.picture?.screenshot, 'shots/1.jpg');
});
