import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SwarmEdge } from '@gnomi/engine/graph/index.ts';
import { connectionMatches, summarizeConnections } from './swarm-view.ts';

const edges: SwarmEdge[] = [
  { key: 'a', type: 'used', source: 'persona:a', target: 'poi:checkout', weight: 1, first_seq: 1, last_seq: 1, round: 1, last_round: 1 },
  { key: 'b', type: 'friction', source: 'persona:a', target: 'poi:checkout', weight: 2, first_seq: 2, last_seq: 2, round: 2, last_round: 2 },
  { key: 'c', type: 'talked', source: 'persona:b', target: 'persona:c', weight: 1, first_seq: 3, last_seq: 3, round: 2, last_round: 2 },
];

test('map filters match both ends of a connection and the round it last changed', () => {
  const filter = { types: new Set(['used', 'friction'] as const), round: 2, focus: 'poi:checkout' };
  assert.deepEqual(edges.filter((edge) => connectionMatches(edge, filter)).map((edge) => edge.key), ['b']);
  assert.equal(connectionMatches(edges[1], { ...filter, focus: 'persona:a' }), true);
  assert.equal(connectionMatches(edges[1], { ...filter, focus: 'persona:c' }), false);
});

test('map summary counts only visible connections while retaining available filter counts', () => {
  const summary = summarizeConnections(edges, { types: new Set(['used']), round: null, focus: 'persona:a' });
  assert.equal(summary.visible, 1);
  assert.deepEqual(summary.byType, { used: 1, talked: 0, influenced: 0, friction: 1 });
  assert.deepEqual([...summary.connectedNodes].sort(), ['persona:a', 'poi:checkout']);
  assert.equal(summarizeConnections(edges, { types: new Set(), round: null, focus: null }).visible, 0);
});

test('round summaries do not include historical connections', () => {
  const summary = summarizeConnections(edges, { types: new Set(['used', 'talked', 'friction']), round: 2, focus: null });
  assert.equal(summary.visible, 2);
  assert.equal(summary.byType.used, 0);
});
