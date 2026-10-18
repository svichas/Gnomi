import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventPayloads, EventType, GnomiEvent } from '../types.ts';
import { fnv1a, mulberry32 } from '../audience/sample.ts';
import { readBoard, selectFeed } from './feed.ts';

let seq = 0;
const event = <K extends EventType>(type: K, persona_id: string, payload: EventPayloads[K]) =>
  ({ seq: ++seq, ts: seq, run_id: 'r-0001', round: 1, persona_id, poi_id: null, type, payload }) as GnomiEvent;
const post = (author: string, post_id: string, text = `Post ${post_id}`, parent_id: string | null = null) =>
  event('social.post', author, { post_id, parent_id, text, about_poi_id: 'poi-1' });
const react = (who: string, post_id: string, kind: 'agree' | 'disagree' = 'agree') => event('social.reaction', who, { post_id, kind });
const level = () => 0; // every tie equal, so the stable sort keeps seq order
const ids = (events: GnomiEvent[], who: string, follows: string[]) => selectFeed(readBoard(events), who, follows, level).map((p) => p.post_id);

test('followed posts come first, most reactions first, then two trending posts from anyone', () => {
  const events = [
    post('a', 'a1'), post('a', 'a2'), post('b', 'b1'), post('x', 'x1'), post('y', 'y1'), post('z', 'z1'),
    react('c', 'b1'), react('d', 'b1', 'disagree'), react('c', 'a1'), react('c', 'y1'), react('d', 'y1'), react('c', 'z1'),
  ];
  assert.deepEqual(ids(events, 'me', ['a', 'b']), ['b1', 'a1', 'a2', 'y1', 'z1']);
  const board = readBoard(events);
  assert.deepEqual(board.posts.find((p) => p.post_id === 'b1')?.agree, 1);
  assert.deepEqual(board.posts.find((p) => p.post_id === 'b1')?.disagree, 1);
});

test('a persona never sees its own posts or posts it was already shown', () => {
  const events = [post('a', 'a1'), post('me', 'm1'), post('a', 'a2'), event('social.feed_viewed', 'me', { post_ids: ['a1'] })];
  assert.deepEqual(ids(events, 'me', ['a']), ['a2']);
  assert.deepEqual(ids(events, 'a', ['me']), ['m1'], 'its own posts count as seen');
  assert.deepEqual(ids([], 'me', ['a']), []);
});

test('the feed holds at most 12 posts and about 2,500 tokens', () => {
  const many = Array.from({ length: 20 }, (_, i) => post('a', `a${i}`));
  assert.equal(ids(many, 'me', ['a']).length, 12, 'trending tops up from the followed when nobody else posted');
  const long = Array.from({ length: 8 }, (_, i) => post('a', `l${i}`, 'x'.repeat(2_000)));
  assert.equal(ids(long, 'me', ['a']).length, 4, '4 × 525 tokens fit, a fifth would not');
  const mixed = [post('a', 'big', 'x'.repeat(10_000)), post('a', 'small')];
  assert.deepEqual(ids(mixed, 'me', ['a']), ['small'], 'a post too big for the feed is left out, not the ones after it');
});

test('given the persona’s own POIs, posts about them or about nothing in particular come before posts about the others', () => {
  const about = (author: string, post_id: string, poi: string | null) => event('social.post', author, { post_id, parent_id: null, text: `Post ${post_id}`, about_poi_id: poi });
  const events = [about('a', 'app', 'poi-app'), about('a', 'price', 'poi-price'), about('a', 'general', null), react('c', 'app'), react('d', 'app')];
  const board = readBoard(events);
  assert.deepEqual(selectFeed(board, 'me', ['a'], level, new Set(['poi-price'])).map((p) => p.post_id), ['price', 'general', 'app'], 'still shown, just later');
  assert.deepEqual(selectFeed(board, 'me', ['a'], level).map((p) => p.post_id), ['app', 'price', 'general'], 'without POIs, reactions rank as before');
});

test('ties are shuffled by a stream seeded per persona and round: the same for a seed, different between personas', () => {
  const board = readBoard(Array.from({ length: 8 }, (_, i) => post('a', `a${i}`)));
  const feed = (who: string) => selectFeed(board, who, ['a'], mulberry32(fnv1a(`feed/7/${who}/1`))).map((p) => p.post_id);
  assert.deepEqual(feed('me'), feed('me'));
  assert.notDeepEqual(feed('me'), feed('you'));
  assert.deepEqual([...feed('me')].sort(), board.posts.map((p) => p.post_id).sort(), 'the same posts, only their order differs');
});

test('the chronological control shows followed posts in seq order under the same caps, with no ranking or trending', () => {
  const events = [post('a', 'a1'), post('x', 'x1'), post('a', 'a2'), react('c', 'a2'), react('d', 'a2'), ...Array.from({ length: 12 }, (_, i) => post('a', `b${i}`))];
  const feed = selectFeed(readBoard(events), 'me', ['a'], Math.random, undefined, 'chronological').map((p) => p.post_id);
  assert.deepEqual(feed, ['a1', 'a2', 'b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'], 'oldest unseen first, 12 at most, nobody unfollowed');
});
