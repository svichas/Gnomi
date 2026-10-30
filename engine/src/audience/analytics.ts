// An analytics export mapped onto the audience, with no model: real counts become the numbers sampling already reads.
// Pure. What the file says that Gnomi cannot map is skipped and reported, never guessed.
import { COUNTRY_PROFILES } from '@gnomi/simulation/audience/locations.ts';
import { apportion } from '@gnomi/simulation/audience/sample.ts';
import type { Audience, GroundingSource, Segment } from '@gnomi/simulation/types.ts';

export interface AnalyticsResult {
  audience: Audience;
  changes: string[]; // what the import changes, one line each
  skipped: string[]; // what it could not use, and what it left alone
}

const COUNT_COLUMNS = ['users', 'total users', 'active users', 'sessions']; // the first the file has is the one read
const DEVICE: Record<string, 'mobile' | 'desktop'> = { mobile: 'mobile', phone: 'mobile', desktop: 'desktop', computer: 'desktop' }; // a tablet is neither: mobile_share is the share on a phone
const COUNT = /^\d{1,3}(?:,\d{3})+$|^\d+(?:\.\d+)?$/; // GA4 quotes "1,234" when it groups thousands
const LANGUAGE_TAG = /^([a-z]{2,3})(?:[-_][a-z0-9]{2,8})*$/i;
const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

/**
 * RFC 4180 rows. A line starting with # (GA4's header block) or a blank line comes back as an empty row, because both end a table.
 */
function csvRows(csv: string): string[][] {
  const text = csv.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row.length === 1 && !row[0].trim() ? [] : row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && !field) quoted = true;
    else if (c === '#' && !field && !row.length) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      rows.push([]);
    } else if (c === ',') endField();
    else if (c === '\n') endRow();
    else if (c !== '\r') field += c;
  }
  if (quoted) throw new Error('The analytics file has a quoted value that never ends.');
  if (field || row.length) endRow();
  return rows;
}

const countryCode = (value: string) => COUNTRY_PROFILES.find((p) => p.code === value.toUpperCase() || p.name.toLowerCase() === value.toLowerCase())?.code ?? null;

/** A language code, or the English name of a language the audience or a supported country uses. */
function languageCode(value: string, known: string[]): string | null {
  const code = LANGUAGE_TAG.exec(value)?.[1].toLowerCase();
  if (code && LANGUAGE_NAMES.of(code)) return code;
  return known.find((tag) => LANGUAGE_NAMES.of(tag)?.toLowerCase() === value.toLowerCase()) ?? null;
}

/** Whole percents summing to 100, without the ones that round to nothing. */
function percents(counts: Map<string, number>): Record<string, number> {
  const entries = [...counts].sort(([, a], [, b]) => b - a);
  const shares = apportion(entries.map(([, users]) => users), 100, 0);
  return Object.fromEntries(entries.flatMap(([key], i) => (shares[i] > 0 ? [[key, shares[i]]] : [])));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mixText = (mix: Record<string, number>) => Object.entries(mix).map(([key, share]) => `${key} ${share}%`).join(', ');

interface Tally { users: number; countries: Map<string, number>; languages: Map<string, number>; mobile: number; desktop: number }

const withSource = (segment: Segment, source: GroundingSource): Segment => {
  const { facts = [], remarks = [], sources = [] } = segment.grounding ?? {};
  return { ...segment, grounding: { facts, remarks, sources: sources.some((s) => s.sha256 === source.sha256) ? sources : [...sources, source] } };
};

/**
 * What a CSV export changes in an audience. With a segment column, whose values name segments, each named segment gets its share, phone
 * share, countries and languages; a segment the file does not name keeps its share and the others divide the rest. Without one, `segment`
 * (an id) says which segment the file describes, and shares stay. `source`, the file's name and hash, joins each segment it changed.
 */
export function applyAnalytics(csv: string, audience: Audience, options: { segment?: string; source?: GroundingSource } = {}): AnalyticsResult {
  const rows = csvRows(csv);
  const first = rows.findIndex((row) => row.length > 0);
  if (first < 0) throw new Error('The analytics file has no rows.');
  const header = rows[first].map((name) => name.trim().toLowerCase());
  const counted = COUNT_COLUMNS.find((name) => header.includes(name));
  if (!counted) throw new Error(`The analytics file needs a count column (${COUNT_COLUMNS.join(', ')}). It has: ${header.join(', ')}.`);
  const column = (...names: string[]) => names.map((name) => header.indexOf(name)).find((at) => at >= 0) ?? -1;
  const [count, segmentAt, countryAt, languageAt, deviceAt] = [column(counted), column('segment'), column('country'), column('language'), column('device', 'device category')];
  if (Math.max(segmentAt, countryAt, languageAt, deviceAt) < 0) throw new Error('The analytics file needs at least one of these columns: country, language, device, device category, segment.');

  const named = audience.segments.find((segment) => segment.id === options.segment);
  if (segmentAt < 0 && !options.segment) throw new Error('The analytics file has no segment column, so name the segment it describes.');
  if (segmentAt < 0 && !named) throw new Error(`The audience has no segment ${JSON.stringify(options.segment)}.`);

  const tallies = new Map<string, Tally>();
  const missed = new Map<string, number>();
  const miss = (what: string, value: string, users: number) => {
    const key = `${what} ${JSON.stringify(value || '(empty)')}`;
    missed.set(key, (missed.get(key) ?? 0) + users);
  };
  const languages = [...new Set([...COUNTRY_PROFILES.flatMap((p) => p.languages), ...Object.keys(audience.languages)].map((tag) => tag.split('-')[0]))];
  const add = (mix: Map<string, number>, key: string, users: number) => mix.set(key, (mix.get(key) ?? 0) + users);

  const blank = rows.slice(first + 1).findIndex((row) => row.length === 0);
  const body = blank < 0 ? rows.slice(first + 1) : rows.slice(first + 1, first + 1 + blank);
  for (const row of body) {
    const cell = (at: number) => (row[at] ?? '').trim();
    if (!COUNT.test(cell(count))) { miss(counted, cell(count), 0); continue; }
    const users = Number(cell(count).replaceAll(',', ''));
    const matches = segmentAt < 0 ? [named!] : audience.segments.filter((segment) => segment.name.trim().toLowerCase() === cell(segmentAt).toLowerCase());
    if (matches.length !== 1) { miss('segment', cell(segmentAt), users); continue; }
    const tally = tallies.get(matches[0].id) ?? { users: 0, countries: new Map(), languages: new Map(), mobile: 0, desktop: 0 };
    tallies.set(matches[0].id, tally);
    tally.users += users;
    if (countryAt >= 0) {
      const code = countryCode(cell(countryAt));
      if (code) add(tally.countries, code, users); else miss('country', cell(countryAt), users);
    }
    if (languageAt >= 0) {
      const code = languageCode(cell(languageAt), languages);
      if (code) add(tally.languages, code, users); else miss('language', cell(languageAt), users);
    }
    if (deviceAt >= 0) {
      const device = DEVICE[cell(deviceAt).toLowerCase()];
      if (device) tally[device] += users; else miss('device', cell(deviceAt), users);
    }
  }

  const listed = audience.segments.filter((segment) => (tallies.get(segment.id)?.users ?? 0) > 0);
  const kept = audience.segments.reduce((sum, segment) => sum + (listed.includes(segment) ? 0 : segment.share), 0);
  const left = Math.max(0, 100 - kept);
  const shares = segmentAt < 0 ? [] : apportion(listed.map((segment) => tallies.get(segment.id)!.users), left, Math.min(1, Math.floor(left / Math.max(1, listed.length))));

  const changes: string[] = [];
  const skipped = [...missed].map(([key, users]) => `Skipped ${key}${users ? `: ${users.toLocaleString('en-US')} ${users === 1 ? counted.slice(0, -1) : counted}` : ''}.`);
  if (segmentAt >= 0 && options.segment) skipped.push('The file has a segment column, so it covers the segments it names, not only the one chosen.');
  if (rows.slice(first + 1).some((row, i) => blank >= 0 && i > blank && row.length > 0)) skipped.push('Only the first table in the file was read.');

  const segments = audience.segments.map((segment) => {
    const tally = tallies.get(segment.id);
    const at = listed.indexOf(segment);
    if (segmentAt >= 0 && at < 0 && audience.segments.length > 1) skipped.push(`${segment.name} is not in the file, so it keeps its ${segment.share}% share.`);
    if (!tally) return segment;
    const next = { ...segment };
    const note = (text: string) => changes.push(`${segment.name}: ${text}`);
    if (segmentAt >= 0 && at >= 0 && shares[at] !== segment.share) { next.share = shares[at]; note(`share ${segment.share}% → ${shares[at]}%`); }
    if (tally.mobile + tally.desktop > 0) {
      next.mobile_share = Math.round((tally.mobile / (tally.mobile + tally.desktop)) * 100) / 100;
      if (next.mobile_share !== segment.mobile_share) note(`on a phone ${Math.round(segment.mobile_share * 100)}% → ${Math.round(next.mobile_share * 100)}%`);
    }
    if (tally.countries.size) {
      next.countries = percents(tally.countries);
      if (!same(next.countries, segment.countries)) note(`countries ${mixText(next.countries)}`);
    }
    if (tally.languages.size) {
      const mix = percents(tally.languages);
      next.languages = Object.fromEntries(Object.entries(mix).map(([code, share]) => [code, share / 100]));
      if (!same(next.languages, segment.languages)) note(`languages ${mixText(mix)}`);
      if (next.countries ?? audience.countries) skipped.push(`${segment.name}: the languages are kept but do nothing while a country mix applies, because each country brings its own languages.`);
    }
    return next;
  });

  const { source } = options;
  return { audience: { ...audience, segments: segments.map((segment, i) => (source && !same(segment, audience.segments[i]) ? withSource(segment, source) : segment)) }, changes, skipped };
}
