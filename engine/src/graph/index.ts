import { withPois } from '../poi/pois.ts';
import { influenceEdges } from '../social/influence.ts';
import type { EventOf, GnomiEvent } from '../types.ts';

// The swarm graph (tech.md §5.5): a pure projection of one run's events. It is applied incrementally and reports what each
// batch changed, so the live view patches only those nodes and edges; applying any split of a log equals building it at once.

export const EDGE_TYPES = ['used', 'talked', 'influenced', 'friction'] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];
export type PersonaStatus = 'waiting' | 'active' | 'blocked' | 'done' | 'abandoned' | 'unfinished';

export interface PersonaNode {
  kind: 'persona';
  key: string; // 'persona:<id>', so a persona and a POI never share a key
  id: string;
  label: string;
  segment_id: string | null;
  status: PersonaStatus;
  step_count: number;
  friction_count: number;
}

export interface PoiNode {
  kind: 'poi';
  key: string; // 'poi:<id>'
  id: string;
  label: string;
  friction_count: number;
  sentiment_by_segment: Record<string, number>; // mean latest sentiment, −2…+2, by segment id ('' for personas without one)
}

export type SwarmNode = PersonaNode | PoiNode;

export interface SwarmEdge {
  key: string;
  type: EdgeType;
  source: string; // node keys; a talked edge has no direction, so its ends are sorted
  target: string;
  weight: number; // used: steps, talked: replies and reactions, influenced: opinion changes, friction: summed severity
  first_seq: number;
  last_seq: number;
  round: number; // the round it first appeared in
  last_round: number; // the latest round that added to it, for "only this round"
}

export interface SwarmGraph {
  nodes: Map<string, SwarmNode>;
  edges: Map<string, SwarmEdge>;
  last_seq: number;
  posts: Map<string, EventOf<'social.post'>>; // authors for replies and reactions, and the influence rule's cited posts
  sentiments: Map<string, { poi: string; persona: string; sentiment: number }>; // latest per POI and persona
}

/** The node and edge keys a batch touched. */
export interface GraphChanges {
  nodes: Set<string>;
  edges: Set<string>;
}

const ENDS: Partial<Record<GnomiEvent['type'], PersonaStatus>> = {
  'persona.blocked': 'blocked',
  'persona.goal_done': 'done',
  'persona.abandoned': 'abandoned',
  'signal.budget_exceeded': 'abandoned',
  'signal.repeated_failure': 'abandoned',
};

export function emptyGraph(): SwarmGraph {
  return { nodes: new Map(), edges: new Map(), last_seq: 0, posts: new Map(), sentiments: new Map() };
}

export function buildGraph(events: GnomiEvent[]): SwarmGraph {
  const graph = emptyGraph();
  applyEvents(graph, events);
  return graph;
}

/** The graph as it stood at the end of a round, rebuilt from the log alone: what the time scrubber shows. */
export function graphAtRound(events: GnomiEvent[], round: number): SwarmGraph {
  return buildGraph(events.filter((event) => event.round <= round));
}

/** Applies events in seq order; ones at or below the last applied seq are skipped, so a batch may overlap the previous one. */
export function applyEvents(graph: SwarmGraph, events: GnomiEvent[]): GraphChanges {
  const changes: GraphChanges = { nodes: new Set(), edges: new Set() };
  for (const event of events) {
    if (event.seq <= graph.last_seq) continue;
    graph.last_seq = event.seq;
    apply(graph, event, changes);
  }
  return changes;
}

function apply(graph: SwarmGraph, event: GnomiEvent, changes: GraphChanges) {
  const who = event.persona_id;
  switch (event.type) {
    case 'run.started': {
      const project = event.payload.config.project;
      for (const poi of project ? withPois(project).pois : []) Object.assign(poiNode(graph, changes, poi.id), { label: poi.name });
      return;
    }
    case 'run.finished':
    case 'run.stopped':
      for (const node of graph.nodes.values()) {
        if (node.kind === 'persona' && (node.status === 'waiting' || node.status === 'active')) {
          node.status = 'unfinished';
          changes.nodes.add(node.key);
        }
      }
      return;
    case 'persona.created':
      if (who) Object.assign(personaNode(graph, changes, who), { label: event.payload.persona.name, segment_id: event.payload.persona.segment_id });
      return;
    case 'persona.episode_started':
    case 'persona.resumed':
      if (who) personaNode(graph, changes, who).status = 'active';
      return;
    case 'persona.step': {
      if (!who) return;
      const node = personaNode(graph, changes, who);
      node.status = 'active';
      node.step_count += 1;
      if (event.poi_id) bump(graph, changes, 'used', `persona:${who}`, poiNode(graph, changes, event.poi_id).key, 1, event);
      return;
    }
    case 'persona.friction_reported':
      if (!who) return;
      personaNode(graph, changes, who).friction_count += 1;
      if (event.poi_id) {
        const poi = poiNode(graph, changes, event.poi_id);
        poi.friction_count += 1;
        bump(graph, changes, 'friction', `persona:${who}`, poi.key, event.payload.severity, event);
      }
      return;
    case 'social.post': {
      graph.posts.set(event.payload.post_id, event);
      const parent = event.payload.parent_id ? graph.posts.get(event.payload.parent_id) : undefined;
      if (who && parent) talked(graph, changes, who, parent.persona_id, event);
      return;
    }
    case 'social.reaction':
      if (who) talked(graph, changes, who, graph.posts.get(event.payload.post_id)?.persona_id ?? null, event);
      return;
    case 'persona.opinion_changed': {
      if (!who) return;
      // The shared rule over just the cited posts and this change: the same edges influenceEdges finds over the whole log.
      const cited = [...new Set(event.payload.cause.post_ids)].flatMap((id) => graph.posts.get(id) ?? []);
      for (const edge of influenceEdges([...cited, event])) bump(graph, changes, 'influenced', personaNode(graph, changes, edge.from).key, personaNode(graph, changes, edge.to).key, 1, event);
      sentiment(graph, changes, event.payload.poi_id, who, event.payload.after.sentiment);
      return;
    }
    case 'persona.survey':
      if (who) sentiment(graph, changes, event.payload.poi_id, who, event.payload.sentiment);
      return;
    default: {
      const status = ENDS[event.type];
      if (status && who) personaNode(graph, changes, who).status = status;
    }
  }
}

function personaNode(graph: SwarmGraph, changes: GraphChanges, id: string): PersonaNode {
  const key = `persona:${id}`;
  let node = graph.nodes.get(key) as PersonaNode | undefined;
  if (!node) graph.nodes.set(key, (node = { kind: 'persona', key, id, label: id, segment_id: null, status: 'waiting', step_count: 0, friction_count: 0 }));
  changes.nodes.add(key);
  return node;
}

function poiNode(graph: SwarmGraph, changes: GraphChanges, id: string): PoiNode {
  const key = `poi:${id}`;
  let node = graph.nodes.get(key) as PoiNode | undefined;
  if (!node) graph.nodes.set(key, (node = { kind: 'poi', key, id, label: id, friction_count: 0, sentiment_by_segment: {} }));
  changes.nodes.add(key);
  return node;
}

function bump(graph: SwarmGraph, changes: GraphChanges, type: EdgeType, source: string, target: string, by: number, event: GnomiEvent) {
  const key = `${type}:${source}>${target}`;
  const edge = graph.edges.get(key);
  if (edge) Object.assign(edge, { weight: edge.weight + by, last_seq: event.seq, last_round: event.round });
  else graph.edges.set(key, { key, type, source, target, weight: by, first_seq: event.seq, last_seq: event.seq, round: event.round, last_round: event.round });
  changes.edges.add(key);
}

/** A reply or reaction between two different personas. */
function talked(graph: SwarmGraph, changes: GraphChanges, from: string, to: string | null, event: GnomiEvent) {
  if (!to || to === from) return;
  const [a, b] = [personaNode(graph, changes, from).key, personaNode(graph, changes, to).key].sort();
  bump(graph, changes, 'talked', a, b, 1, event);
}

function sentiment(graph: SwarmGraph, changes: GraphChanges, poi_id: string, persona: string, value: number) {
  graph.sentiments.set(`${poi_id}\n${persona}`, { poi: poi_id, persona, sentiment: value });
  const sums: Record<string, [total: number, count: number]> = {};
  for (const entry of graph.sentiments.values()) {
    if (entry.poi !== poi_id) continue;
    const segment = (graph.nodes.get(`persona:${entry.persona}`) as PersonaNode | undefined)?.segment_id ?? '';
    const sum = (sums[segment] ??= [0, 0]);
    sum[0] += entry.sentiment;
    sum[1] += 1;
  }
  poiNode(graph, changes, poi_id).sentiment_by_segment = Object.fromEntries(Object.entries(sums).map(([segment, [total, count]]) => [segment, total / count]));
}
