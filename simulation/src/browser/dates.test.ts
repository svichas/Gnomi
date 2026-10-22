import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickedValue } from './dates.ts';

test('a typed date reads in the locale order, unless a day over 12 settles it', () => {
  assert.equal(pickedValue('date', '05/04/2026', true), '2026-04-05');
  assert.equal(pickedValue('date', '05/04/2026', false), '2026-05-04');
  assert.equal(pickedValue('date', '10/25/2026', true), '2026-10-25');
  assert.equal(pickedValue('date', '25.10.26', false), '2026-10-25');
  assert.equal(pickedValue('date', '2026-10-25', false), '2026-10-25');
  assert.equal(pickedValue('date', '10/25/2026', false), '2026-10-25');
  assert.equal(pickedValue('date', '25/10/2026', true), '2026-10-25');
  for (const bad of ['31/02/2026', '25/10', 'tomorrow', '0/0/2026']) assert.equal(pickedValue('date', bad, true), null, bad);
});

test('a typed date reads with its month in words, English or the persona\'s own, or as one run of eight digits', () => {
  assert.equal(pickedValue('date', 'October 25, 2026', false), '2026-10-25');
  assert.equal(pickedValue('date', '25 Oct 2026', true), '2026-10-25');
  assert.equal(pickedValue('date', '25 Οκτωβρίου 2026', true, 'el-GR'), '2026-10-25');
  assert.equal(pickedValue('date', '25 οκτωβριου 2026', true, 'el-GR'), '2026-10-25');
  assert.equal(pickedValue('date', '07072026', true), '2026-07-07');
  assert.equal(pickedValue('date', '10252026', false), '2026-10-25');
  assert.equal(pickedValue('date', '20261025', true), '2026-10-25');
  assert.equal(pickedValue('date', '20102026', true), '2026-10-20', 'starts like a year but reads as no date that way');
  assert.equal(pickedValue('datetime-local', '25 October 2026, 9:30 PM', true), '2026-10-25T21:30');
  assert.equal(pickedValue('month', 'October 2026', true), '2026-10');
  // No year, or a weekday that reads as a month too (mardi): no date rather than a wrong one.
  for (const bad of ['25 October', 'mar. 25 oct. 2026']) assert.equal(pickedValue('date', bad, true, 'fr-FR'), null, bad);
});

test('a typed time reads 12- or 24-hour, English or Greek', () => {
  assert.equal(pickedValue('time', '09:00', true), '09:00');
  assert.equal(pickedValue('time', '9:05 PM', true), '21:05');
  assert.equal(pickedValue('time', '12:30 a.m.', true), '00:30');
  assert.equal(pickedValue('time', '7 μ.μ.', true), '19:00');
  assert.equal(pickedValue('time', '21:30', false), '21:30');
  assert.equal(pickedValue('time', '25:00', true), null);
});

test('a typed date and time, a month, and what reads as neither', () => {
  assert.equal(pickedValue('datetime-local', '25/10/2026 09:00', true), '2026-10-25T09:00');
  assert.equal(pickedValue('datetime-local', '10/25/2026, 9:00 PM', false), '2026-10-25T21:00');
  assert.equal(pickedValue('datetime-local', '25/10/2026', true), null);
  assert.equal(pickedValue('month', '10/2026', true), '2026-10');
  assert.equal(pickedValue('month', '2026-03', true), '2026-03');
  assert.equal(pickedValue('week', '2026-W43', true), '2026-W43');
  assert.equal(pickedValue('week', 'week 43 2026', true), '2026-W43');
  assert.equal(pickedValue('week', 'week 54 2026', true), null);
});
