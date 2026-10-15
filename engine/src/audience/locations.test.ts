import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countryName, personaEnvironment, validateCountries } from './locations.ts';

test('a saved persona uses ordered canonical language preferences and retains its timezone', () => {
  assert.deepEqual(personaEnvironment({ language: 'en', languages: ['de-de', 'en-gb', 'de-DE'], timezone: 'Europe/Berlin' }), {
    locale: 'de-DE', languages: ['de-DE', 'en-GB'], timezone: 'Europe/Berlin',
  });
});

test('legacy or malformed optional locale values fall back to a usable language and UTC', () => {
  assert.deepEqual(personaEnvironment({ language: 'el' }), { locale: 'el', languages: ['el'], timezone: 'UTC' });
  assert.deepEqual(personaEnvironment({ language: 'de', languages: ['bad_tag'], timezone: 'not/a-zone' }), { locale: 'de', languages: ['de'], timezone: 'UTC' });
  assert.deepEqual(personaEnvironment({ language: 'bad_tag', languages: [] }), { locale: 'en-US', languages: ['en-US'], timezone: 'UTC' });
  assert.equal(countryName('DE'), 'Germany');
  assert.equal(countryName('ZZ'), 'ZZ');
  assert.doesNotThrow(() => validateCountries(undefined));
});
