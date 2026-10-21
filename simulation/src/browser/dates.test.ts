import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickedValue } from './dates.ts';

test('a typed date reads in the locale order, unless a day over 12 settles it', () => {
  assert.equal(pickedValue('date', '05/04/2026', true), '2026-04-05');
  assert.equal(pickedValue('date', '05/04/2026', false), '2026-05-04');
  assert.equal(pickedValue('date', '10/25/2026', true), '2026-10-25');
  assert.equal(pickedValue('date', '25.10.26', false), '2026-10-25');
  assert.equal(pickedValue('date', '2026-10-25', false), '2026-10-25');
  for (const bad of ['31/02/2026', '25/10', 'tomorrow', '0/0/2026']) assert.equal(pickedValue('date', bad, true), null, bad);
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
  assert.equal(pickedValue('week', '2026-W43', true), null);
});
