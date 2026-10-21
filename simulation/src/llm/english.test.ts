import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { english, latin } from './english.ts';

test('English text allows any Latin letters and double-quoted or guillemet-quoted screen text, never another script', () => {
  const text = english(z.string());
  for (const ok of ['Lucía Gutiérrez — naïve façade, 50% off', 'Straße, Ørsted, µ', 'The "Σύνδεση" button', 'Clicked “登录”', 'I tap «Φτιάξε μια εκδήλωση» in the footer']) assert.equal(text.safeParse(ok).success, true, ok);
  for (const bad of ['比较菜单已经打开', 'Привет', "Clicked 'Σύνδεση'", 'मूल्य', 'Tapped «Σύνδεση», τώρα περιμένω']) assert.equal(text.safeParse(bad).success, false, bad);
});

test('a name or profile field is Latin letters only, quotes or not', () => {
  const name = latin(z.string());
  assert.equal(name.safeParse('Chen Jing').success, true);
  assert.equal(name.safeParse('陈静').success, false);
  assert.equal(name.safeParse('"陈静"').success, false);
});
