import assert from 'node:assert/strict';
import { test } from 'node:test';
import Graph from 'graphology';
import { emptyGraph } from '@gnomi/engine/graph/index.ts';
import type { SwarmEdge } from '@gnomi/engine/graph/index.ts';
import { connectionMatches, reconcile, SMALL_GRAPH_LIMIT, summarizeConnections } from './swarm-view.ts';

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

test('reconcile drops nodes missing from the projection and keeps the positions of the rest', () => {
  const projection = emptyGraph();
  projection.nodes.set('poi:home', { kind: 'poi', key: 'poi:home', id: 'home', label: 'Home', friction_count: 0, sentiment_by_segment: {} });
  // More people than a small graph holds, so the layout, not the ring, places them.
  for (let i = 0; i <= SMALL_GRAPH_LIMIT; i++) {
    projection.nodes.set(`persona:p${i}`, { kind: 'persona', key: `persona:p${i}`, id: `p${i}`, label: `P${i}`, segment_id: null, status: 'active', step_count: 1, friction_count: 0 });
    projection.edges.set(`used:p${i}`, { key: `used:p${i}`, type: 'used', source: `persona:p${i}`, target: 'poi:home', weight: 1, first_seq: i, last_seq: i, round: 1, last_round: 1 });
  }
  const graph = new Graph({ multi: true, type: 'mixed' });
  reconcile(graph, projection, []);
  graph.mergeNodeAttributes('persona:p1', { x: 7, y: -3 }); // where the layout moved her
  projection.nodes.delete('persona:p0');
  projection.edges.delete('used:p0');
  reconcile(graph, projection, []);
  assert.equal(graph.hasNode('persona:p0'), false);
  assert.equal(graph.hasEdge('used:p0'), false);
  assert.deepEqual([graph.order, graph.size], [projection.nodes.size, projection.edges.size]);
  assert.deepEqual([graph.getNodeAttribute('persona:p1', 'x'), graph.getNodeAttribute('persona:p1', 'y')], [7, -3]);
});
