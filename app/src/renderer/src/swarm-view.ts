import type Graph from 'graphology';
import { fnv1a } from '@gnomi/simulation/audience/sample.ts';
import { EDGE_TYPES } from '@gnomi/engine/graph/index.ts';
import type { EdgeType, GraphChanges, SwarmEdge, SwarmGraph, SwarmNode } from '@gnomi/engine/graph/index.ts';
import type { Segment } from '@gnomi/simulation/types.ts';

export interface GraphFilter {
  types: ReadonlySet<EdgeType>;
  round: number | null;
  focus: string | null;
}

type Connection = Pick<SwarmEdge, 'type' | 'source' | 'target' | 'last_round'>;

function inContext(edge: Connection, filter: GraphFilter) {
  return (filter.round === null || edge.last_round === filter.round)
    && (filter.focus === null || edge.source === filter.focus || edge.target === filter.focus);
}

export function connectionMatches(edge: Connection, filter: GraphFilter): boolean {
  return filter.types.has(edge.type) && inContext(edge, filter);
}

/** The legend counts available connections; the total and highlighted nodes match the filters actually drawn. */
export function summarizeConnections(edges: Iterable<SwarmEdge>, filter: GraphFilter) {
  const byType = Object.fromEntries(EDGE_TYPES.map((type) => [type, 0])) as Record<EdgeType, number>;
  const connectedNodes = new Set<string>();
  let visible = 0;
  for (const edge of edges) {
    if (!inContext(edge, filter)) continue;
    byType[edge.type] += 1;
    if (!filter.types.has(edge.type)) continue;
    visible += 1;
    connectedNodes.add(edge.source);
    connectedNodes.add(edge.target);
  }
  if (filter.focus) connectedNodes.add(filter.focus);
  return { byType, visible, connectedNodes };
}

// Colours from docs/brand.md §5: the categorical sequence for segments, Ink for POIs, status colours for edge meaning.
const SEGMENT_COLORS = ['#58684E', '#56768A', '#8A6A83', '#A27B36', '#417F78'];
export const NO_SEGMENT = '#686D65';
export const POI_COLOR = '#222823';
export const EDGES: Record<EdgeType, { label: string; color: string; description: string }> = {
  used: { label: 'Product use', color: '#87917D99', description: 'A person interacted with a product area' },
  talked: { label: 'Conversations', color: '#417F7888', description: 'People replied or reacted to one another' },
  influenced: { label: 'Opinion shifts', color: '#496D85', description: 'A conversation contributed to a change of opinion' },
  friction: { label: 'Friction', color: '#AA5147', description: 'A person reported difficulty with a product area' },
};
export const SMALL_GRAPH_LIMIT = 24;

export const segmentColor = (segments: Segment[], id: string | null) => {
  const index = segments.findIndex((segment) => segment.id === id);
  return index < 0 ? NO_SEGMENT : SEGMENT_COLORS[index % SEGMENT_COLORS.length];
};

function nodeAttributes(node: SwarmNode, segments: Segment[]) {
  return node.kind === 'poi'
    ? { key: node.key, kind: 'poi', label: node.label, color: POI_COLOR, size: Math.min(15, 11 + Math.sqrt(node.friction_count) / 2) }
    : { key: node.key, kind: 'persona', label: node.label, color: segmentColor(segments, node.segment_id), size: Math.min(10, 6 + Math.sqrt(node.step_count) * 0.5) };
}

function edgeAttributes(edge: SwarmEdge) {
  return {
    kind: edge.type, // not `type`, which sigma reads as the edge's rendering program
    source: edge.source,
    target: edge.target,
    color: EDGES[edge.type].color,
    size: Math.min(4, 0.5 + Math.log2(1 + edge.weight) * 0.5),
    weight: edge.weight,
    last_round: edge.last_round,
  };
}

/** Upserts the given projection nodes and edges into the rendered graph; a new persona starts at a spot derived from its id. */
export function patch(graph: Graph, projection: SwarmGraph, changes: GraphChanges, segments: Segment[]) {
  // Product areas are stable anchors; people settle around them as connections arrive.
  const ring = 25 * Math.sqrt(projection.nodes.size);
  for (const key of changes.nodes) {
    const node = projection.nodes.get(key)!;
    if (graph.hasNode(key)) graph.mergeNodeAttributes(key, nodeAttributes(node, segments));
    else {
      const hash = fnv1a(key);
      const angle = (hash % 3600) / 3600 * 2 * Math.PI;
      const radius = ring * (0.6 + 0.3 * ((hash >>> 12) % 1000) / 1000);
      graph.addNode(key, { ...nodeAttributes(node, segments), x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
  }
  for (const key of changes.edges) {
    const edge = projection.edges.get(key)!;
    if (graph.hasEdge(key)) graph.mergeEdgeAttributes(key, edgeAttributes(edge));
    else if (edge.type === 'talked') graph.addUndirectedEdgeWithKey(key, edge.source, edge.target, edgeAttributes(edge));
    else graph.addDirectedEdgeWithKey(key, edge.source, edge.target, edgeAttributes(edge));
  }
  const pois = graph.filterNodes((_, attributes) => attributes.kind === 'poi').sort();
  pois.forEach((key, i) => {
    const angle = (i / pois.length) * 2 * Math.PI - Math.PI / 2;
    const radius = pois.length > 1 ? ring * 0.6 : 0;
    graph.mergeNodeAttributes(key, { x: radius * Math.cos(angle), y: radius * Math.sin(angle), fixed: true });
  });
  // A small audience needs no physics: an even ring gives every person a readable place immediately.
  if (graph.order <= SMALL_GRAPH_LIMIT) {
    const people = graph.filterNodes((_, attributes) => attributes.kind === 'persona').sort();
    people.forEach((key, i) => {
      const angle = (i / people.length) * 2 * Math.PI + Math.PI / 2;
      const node = projection.nodes.get(key);
      const steps = node?.kind === 'persona' ? node.step_count : 0;
      graph.mergeNodeAttributes(key, { x: 120 * Math.cos(angle), y: 120 * Math.sin(angle), size: Math.min(13, 10 + Math.sqrt(steps) * 0.5) });
    });
    pois.forEach((key, i) => {
      const angle = (i / pois.length) * 2 * Math.PI - Math.PI / 2;
      const radius = pois.length > 1 ? 45 : 0;
      graph.mergeNodeAttributes(key, { x: radius * Math.cos(angle), y: radius * Math.sin(angle), size: 14 });
    });
  }
}

/** Makes the rendered graph exactly the projection, keeping the positions of nodes it already had. */
export function reconcile(graph: Graph, projection: SwarmGraph, segments: Segment[]) {
  for (const key of graph.edges()) if (!projection.edges.has(key)) graph.dropEdge(key);
  for (const key of graph.nodes()) if (!projection.nodes.has(key)) graph.dropNode(key);
  patch(graph, projection, { nodes: new Set(projection.nodes.keys()), edges: new Set(projection.edges.keys()) }, segments);
}
