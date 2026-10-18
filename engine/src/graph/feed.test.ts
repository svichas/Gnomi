import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventPayloads, EventType, GnomiEvent } from '@gnomi/simulation/types.ts';
import { feedThreads, socialMemory } from './feed.ts';

function logOf() {
  const events: GnomiEvent[] = [];
  const add = <K extends EventType>(type: K, payload: EventPayloads[K], persona_id: string | null) =>
    events.push({ run_id: 'r-1', seq: events.length + 1, ts: 0, round: 1, persona_id, poi_id: null, type, payload } as GnomiEvent);
  const post = (persona_id: string, post_id: string, parent_id: string | null = null, injected?: boolean) =>
    add('social.post', { post_id, parent_id, text: `text of ${post_id}`, about_poi_id: 'poi-1', ...(injected && { injected }) }, persona_id);
  return { events, add, post };
}

test('threads: replies sit under their parents in order, injected posts are marked, a reply to a missing post stands alone', () => {
  const { events, post } = logOf();
  post('a', 's1', null, true);
  post('b', 'r1', 's1');
  post('c', 'r2', 'r1');
  post('c', 's2');
  post('b', 'orphan', 'missing');
  const threads = feedThreads(events);
  assert.deepEqual(threads.map((thread) => thread.post_id), ['s1', 's2', 'orphan']);
  assert.deepEqual(threads[0].replies.map((reply) => [reply.post_id, reply.replies.map((inner) => inner.post_id)]), [['r1', ['r2']]]);
  assert.deepEqual(threads.map((thread) => thread.injected), [true, false, false]);
});

test("reactions count each persona's latest reaction once", () => {
  const { events, post, add } = logOf();
  post('a', 's1');
  add('social.reaction', { post_id: 's1', kind: 'agree' }, 'b');
  add('social.reaction', { post_id: 's1', kind: 'disagree' }, 'b'); // b changed its mind
  add('social.reaction', { post_id: 's1', kind: 'agree' }, 'c');
  add('social.reaction', { post_id: 'missing', kind: 'agree' }, 'c');
  assert.deepEqual(feedThreads(events)[0].reactions, { agree: 1, disagree: 1 });
});

test('social memory: follows from persona.created, posts seen once each in order, and its own posts', () => {
  const { events, post, add } = logOf();
  add('persona.created', { persona: {} as never, follows: ['b', 'c'] }, 'a');
  post('b', 's1');
  post('c', 's2');
  add('social.feed_viewed', { post_ids: ['s2', 's1'] }, 'a');
  add('social.feed_viewed', { post_ids: ['s1', 'gone'] }, 'a');
  add('social.feed_viewed', { post_ids: ['s1'] }, 'b');
  post('a', 'r1', 's2');
  const memory = socialMemory(events, 'a');
  assert.deepEqual(memory.follows, ['b', 'c']);
  assert.deepEqual(memory.seen.map((seen) => seen.payload.post_id), ['s2', 's1']);
  assert.deepEqual(memory.own.map((own) => own.payload.post_id), ['r1']);
  assert.deepEqual(socialMemory([], 'a'), { follows: [], seen: [], own: [] });
});
