import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventPayloads, EventType, GnomiEvent } from '@gnomi/engine/types.ts';
import { merge, resetOutcome, stopText, toRows, waitingBlock } from './activity.ts';

function event<K extends EventType>(seq: number, type: K, payload: EventPayloads[K]): GnomiEvent {
  return { seq, ts: seq, run_id: 'r-0001', round: 1, persona_id: 'p-001', poi_id: 'poi-1', type, payload } as GnomiEvent;
}
const blockedRequest = (seq: number, host: string, path: string) => event(seq, 'containment.blocked_request', { host, url: `http://${host}${path}`, method: 'GET' });
const blocked = (seq: number, reason: 'captcha' | 'session_expired' = 'captcha') => event(seq, 'persona.blocked', { step_no: 2, reason, detail: 'recaptcha' });
const resumed = (seq: number) => event(seq, 'persona.resumed', { step_no: 2 });

test('blocked requests are one row per host that keeps its place while its count grows', () => {
  const events = [
    event(1, 'persona.episode_started', { poi_id: 'poi-1', device: 'desktop', start_url: 'http://localhost/' }),
    blockedRequest(2, 'cdn.example.com', '/a.js'),
    blockedRequest(3, 'ads.example.net', '/p.gif'),
    blockedRequest(4, 'cdn.example.com', '/b.js'),
    blockedRequest(5, 'cdn.example.com', '/c.js'),
  ];
  const rows = toRows(events);
  assert.deepEqual(
    rows.map(({ seq, title }) => [seq, title]),
    [
      [3, 'Blocked requests to ads.example.net (1)'],
      [2, 'Blocked requests to cdn.example.com (3)'],
      [1, 'Opened http://localhost/ in a desktop browser'],
    ],
  );
  assert.equal(toRows([...events, blockedRequest(6, 'ads.example.net', '/q.gif')]).find((row) => row.seq === 3)?.title, 'Blocked requests to ads.example.net (2)');
});

test('safety stops and the pause for the user have their own rows', () => {
  const rows = toRows([
    blocked(1, 'session_expired'),
    resumed(2),
    event(3, 'containment.tripwire', { kind: 'live_payment_key', detail: 'pk_live_ on /pay' }),
    event(4, 'run.stopped', { reason: 'tripwire', detail: 'pk_live_ on /pay' }),
  ]);
  assert.deepEqual(rows.map((row) => row.tone), ['alarm', 'alarm', 'good', 'bad']);
  assert.match(rows[3].title, /Login expired/);
});

test('a blocked persona is waited on until a later resume, and not once the run has ended', () => {
  assert.equal(waitingBlock([]), null);
  assert.equal(waitingBlock([blocked(1)])?.seq, 1);
  assert.equal(waitingBlock([blocked(1), resumed(2)]), null);
  assert.equal(waitingBlock([blocked(1), resumed(2), blocked(3)])?.seq, 3, 'blocked again after a retry');
  assert.equal(waitingBlock([blocked(1), event(2, 'run.stopped', { reason: 'user', detail: null })]), null);
});

test('merge ignores events it already has and keeps them in order', () => {
  const have = [resumed(2)];
  assert.equal(merge(have, [resumed(2)]), have);
  assert.deepEqual(merge(have, [blocked(1), resumed(2), resumed(3)]).map((e) => e.seq), [1, 2, 3]);
});

test('the reset hook outcome says whether it worked', () => {
  assert.deepEqual(resetOutcome({ status: 204, error: null }), { ok: true, text: 'called, HTTP 204' });
  assert.deepEqual(resetOutcome({ status: 500, error: null }), { ok: false, text: 'answered HTTP 500' });
  assert.deepEqual(resetOutcome({ status: null, error: 'ECONNREFUSED' }), { ok: false, text: 'failed: ECONNREFUSED' });
});

test('the stop reason reads as a sentence, with its detail after it', () => {
  assert.equal(stopText('user'), 'You stopped the run');
  assert.equal(stopText('tripwire: The persona tried to open https://acme.com/.'), 'The run was halted by a safety check: The persona tried to open https://acme.com/.');
  assert.equal(stopText('something else'), 'something else');
});
