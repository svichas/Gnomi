import { EDGE_TYPES } from '@gnomi/engine/graph/index.ts';
import type { EdgeType, SwarmEdge } from '@gnomi/engine/graph/index.ts';

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
