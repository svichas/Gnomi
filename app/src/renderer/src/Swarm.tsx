import { useEffect, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import { ControlsContainer, SigmaContainer, useRegisterEvents, useSigma, ZoomControl } from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import { DEFAULT_STYLES } from 'sigma';
import type { Sigma } from 'sigma';
import { fnv1a } from '@gnomi/engine/audience/sample.ts';
import { applyEvents, EDGE_TYPES, emptyGraph, graphAtRound } from '@gnomi/engine/graph/index.ts';
import type { EdgeType, GraphChanges, SwarmEdge, SwarmGraph, SwarmNode } from '@gnomi/engine/graph/index.ts';
import type { GnomiEvent, Segment } from '@gnomi/engine/types.ts';
import { Feed } from './Feed.tsx';
import { Check } from './ui.tsx';

// Colours from docs/brand.md §5: the categorical sequence for segments, Ink for POIs, status colours for edge meaning.
const SEGMENT_COLORS = ['#58684E', '#56768A', '#8A6A83', '#A27B36', '#417F78'];
const NO_SEGMENT = '#686D65';
const POI_COLOR = '#222823';
const EDGES: Record<EdgeType, { label: string; color: string }> = {
  used: { label: 'Used', color: '#87917D88' },
  talked: { label: 'Talked', color: '#686D6566' },
  influenced: { label: 'Influenced', color: '#496D85' },
  friction: { label: 'Friction', color: '#AA5147' },
};
const BATCH_MS = 250; // tech.md §5.5: the live graph is patched at most four times a second
const SETTLE_MS = 4000; // the layout stops this long after the last change

const segmentColor = (segments: Segment[], id: string | null) => {
  const index = segments.findIndex((segment) => segment.id === id);
  return index < 0 ? NO_SEGMENT : SEGMENT_COLORS[index % SEGMENT_COLORS.length];
};

interface Filter {
  types: Set<EdgeType>;
  round: number | null; // only edges that grew in this round
}

function nodeAttributes(node: SwarmNode, segments: Segment[]) {
  return node.kind === 'poi'
    ? { kind: 'poi', label: node.label, color: POI_COLOR, size: Math.min(14, 9 + Math.sqrt(node.friction_count) / 2) }
    : { kind: 'persona', label: node.label, color: segmentColor(segments, node.segment_id), size: Math.min(10, 4 + Math.sqrt(node.step_count) * 0.6) };
}

function edgeAttributes(edge: SwarmEdge) {
  return {
    kind: edge.type, // not `type`, which sigma reads as the edge's rendering program
    color: EDGES[edge.type].color,
    size: Math.min(4, 0.5 + Math.log2(1 + edge.weight) * 0.5),
    weight: edge.weight,
    last_round: edge.last_round,
  };
}

/** Upserts the given projection nodes and edges into the rendered graph; a new persona starts at a spot derived from its id. */
function patch(graph: Graph, projection: SwarmGraph, changes: GraphChanges, segments: Segment[]) {
  // POIs sit on a fixed ring in id order, so two runs of a project look alike; it grows with the swarm the layout spreads out.
  const ring = 25 * Math.sqrt(projection.nodes.size);
  for (const key of changes.nodes) {
    const node = projection.nodes.get(key)!;
    if (graph.hasNode(key)) graph.mergeNodeAttributes(key, nodeAttributes(node, segments));
    else {
      const hash = fnv1a(key);
      const angle = (hash % 3600) / 3600 * 2 * Math.PI;
      const radius = ring * 0.8 * Math.sqrt(((hash >>> 12) % 1000) / 1000);
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
    graph.mergeNodeAttributes(key, { x: ring * Math.cos(angle), y: ring * Math.sin(angle), fixed: true });
  });
}

/** Makes the rendered graph exactly the projection, keeping the positions of nodes it already had. */
function reconcile(graph: Graph, projection: SwarmGraph, segments: Segment[]) {
  for (const key of graph.edges()) if (!projection.edges.has(key)) graph.dropEdge(key);
  for (const key of graph.nodes()) if (!projection.nodes.has(key)) graph.dropNode(key);
  patch(graph, projection, { nodes: new Set(projection.nodes.keys()), edges: new Set(projection.edges.keys()) }, segments);
}

/** Clicks and hovers on the canvas; WebGL has no DOM, so the smoke test finds nodes through the instance on the container. */
function Interaction({ onOpen, onHover }: { onOpen(personaId: string): void; onHover(key: string | null): void }) {
  const sigma = useSigma();
  const register = useRegisterEvents();
  useEffect(() => {
    Object.assign(sigma.getContainer(), { sigma });
    register({
      clickNode: ({ node }) => node.startsWith('persona:') && onOpen(node.slice('persona:'.length)),
      enterNode: ({ node }) => onHover(node),
      leaveNode: () => onHover(null),
    });
  }, [sigma, register, onOpen, onHover]);
  return null;
}

const STATUS: Record<string, string> = { waiting: 'Waiting to start', active: 'Working', blocked: 'Blocked', done: 'Done', abandoned: 'Gave up', unfinished: 'Stopped early' };
const count = (n: number, noun: string, tail = '') => `${n} ${noun}${n === 1 ? '' : 's'}${tail}`;
const signed = (n: number) => `${n > 0 ? '+' : ''}${Number(n.toFixed(1))}`;

function NodeCard({ node, segments }: { node: SwarmNode; segments: Segment[] }) {
  const segmentName = (id: string) => segments.find((segment) => segment.id === id)?.name ?? 'No segment';
  return (
    <div role="status" className="pointer-events-none absolute left-3 top-3 max-w-64 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-stone-700 shadow-sm">
      <p className="text-sm font-medium text-stone-900">{node.label}</p>
      {node.kind === 'persona' ? (
        <p>{node.segment_id ? segmentName(node.segment_id) : 'No segment'} · {STATUS[node.status]} · {node.step_count} steps · {node.friction_count} frictions</p>
      ) : (
        <>
          <p>{node.friction_count} frictions reported here</p>
          {Object.entries(node.sentiment_by_segment).map(([id, value]) => <p key={id}>{segmentName(id)}: sentiment {signed(value)} of −2 to +2</p>)}
        </>
      )}
    </div>
  );
}

/** The live swarm (roadmap M4): personas coloured by segment around a ring of POIs, filterable by edge type and round, scrubbable through rounds. */
export function Swarm({ events, segments, names, poi, onOpen }: { events: GnomiEvent[]; segments: Segment[]; names: Map<string, string>; poi?: { id: string; name: string }; onOpen(personaId: string): void }) {
  const [graph] = useState(() => new Graph({ multi: true, type: 'mixed' }));
  const [scrub, setScrub] = useState<number | null>(null); // null follows the run as it happens
  const [types, setTypes] = useState<Set<EdgeType>>(() => new Set(EDGE_TYPES));
  const [onlyRound, setOnlyRound] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [shown, setShown] = useState<SwarmGraph>(emptyGraph); // what is drawn, for the counts and the hover card
  const latest = useRef(events);
  latest.current = events;
  const rounds = useMemo(() => events.reduce((most, event) => Math.max(most, event.round), 1), [events]);
  const round = scrub ?? rounds;
  const filter = useMemo<Filter>(() => ({ types, round: onlyRound ? round : null }), [types, onlyRound, round]);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const layout = useRef<FA2Layout | null>(null);
  const settle = useRef<number | undefined>(undefined);

  useEffect(() => {
    // graphology's inferred ForceAtlas2 settings for a few hundred nodes; log weights so a 60-step edge does not swallow its persona.
    layout.current = new FA2Layout(graph, { settings: { strongGravityMode: true, gravity: 0.05, scalingRatio: 10, slowDown: 5 }, getEdgeWeight: (_, attributes) => Math.log2(1 + attributes.weight) });
    return () => {
      window.clearTimeout(settle.current);
      layout.current?.kill();
    };
  }, [graph]);

  useEffect(() => {
    const changed = () => {
      setShown({ ...projection }); // the projection is patched in place
      layout.current?.start();
      window.clearTimeout(settle.current);
      settle.current = window.setTimeout(() => layout.current?.stop(), SETTLE_MS);
    };
    let projection = emptyGraph();
    if (scrub !== null) {
      // The scrubber replays the log alone up to that round; live events wait until it returns to the latest round.
      projection = graphAtRound(latest.current, scrub);
      reconcile(graph, projection, segments);
      changed();
      return;
    }
    let applied = 0;
    const tick = () => {
      const all = latest.current;
      if (applied > 0 && all[applied - 1]?.seq !== projection.last_seq) {
        // An older event arrived late (the initial load raced the live feed): rebuild rather than patch.
        projection = emptyGraph();
        applied = 0;
      }
      if (all.length === applied) return;
      const changes = applyEvents(projection, all.slice(applied));
      if (applied === 0) reconcile(graph, projection, segments);
      else patch(graph, projection, changes, segments);
      applied = all.length;
      changed();
    };
    tick();
    const timer = window.setInterval(tick, BATCH_MS);
    return () => window.clearInterval(timer);
  }, [graph, scrub, segments]);

  // Filters are a style over the edges, not graph data: sigma 4 cannot repaint attribute changes on edges it has not indexed yet.
  const sigma = useRef<Sigma | null>(null);
  const [options] = useState(() => ({
    settings: { itemSizesReference: 'screen' as const, labelRenderedSizeThreshold: 11 },
    styles: {
      nodes: [DEFAULT_STYLES.nodes, {
        cursor: { whenData: { kind: 'persona' }, then: 'pointer', else: 'default' },
        labelVisibility: { whenData: { kind: 'poi' }, then: 'visible' as const, else: DEFAULT_STYLES.nodes.labelVisibility }, // POIs are always named
        labelColor: POI_COLOR,
        labelFont: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }],
      edges: [DEFAULT_STYLES.edges, {
        visibility: (attributes: { kind?: EdgeType; last_round?: number }) => {
          const { types, round } = filterRef.current;
          return types.has(attributes.kind!) && (round === null || attributes.last_round === round) ? 'visible' as const : 'hidden' as const;
        },
      }],
    },
  }));
  useEffect(() => {
    sigma.current?.refresh();
  }, [filter]);

  const counts = useMemo(() => {
    const byType = Object.fromEntries(EDGE_TYPES.map((type) => [type, 0])) as Record<EdgeType, number>;
    for (const edge of shown.edges.values()) byType[edge.type] += 1;
    return byType;
  }, [shown]);
  const personas = [...shown.nodes.values()].filter((node) => node.kind === 'persona').length;
  const shownEvents = useMemo(() => (scrub === null ? events : events.filter((event) => event.round <= scrub)), [events, scrub]);
  const hoveredNode = hovered ? shown.nodes.get(hovered) : undefined;

  return (
    <div className="space-y-5">
      <section aria-label="Swarm graph" className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-base font-semibold text-stone-900">Swarm</h2>
          <p className="text-sm text-stone-600" aria-live="polite">
            {count(personas, 'persona')}, {count(shown.nodes.size - personas, 'point', ' of interest')}, {count(shown.edges.size, 'connection')}
          </p>
        </div>
        <div className="relative mt-3 h-[28rem] overflow-hidden rounded-lg border border-stone-200 bg-[#F6F5F0]">
          <SigmaContainer ref={sigma} graph={graph} style={{ height: '100%', width: '100%', background: 'transparent' }} options={options}>
            <Interaction onOpen={onOpen} onHover={setHovered} />
            <ControlsContainer position="bottom-right">
              <ZoomControl labels={{ zoomIn: 'Zoom in', zoomOut: 'Zoom out', reset: 'Fit the whole graph' }} />
            </ControlsContainer>
          </SigmaContainer>
          {hoveredNode && <NodeCard node={hoveredNode} segments={segments} />}
          {shown.nodes.size === 0 && <p className="absolute inset-0 grid place-items-center text-sm text-stone-500">Nothing to draw yet.</p>}
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-stone-700">Connections</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {EDGE_TYPES.map((type) => (
                <Check key={type} checked={types.has(type)} onChange={(on) => setTypes((was) => { const next = new Set(was); if (on) next.add(type); else next.delete(type); return next; })}>
                  <span aria-hidden className="mr-1.5 inline-block h-0.5 w-4 align-middle" style={{ background: EDGES[type].color.slice(0, 7) }} />
                  {EDGES[type].label} <span className="text-stone-500">({counts[type]})</span>
                </Check>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="swarm-round" className="mb-2 block text-sm font-medium text-stone-700">
              Round {round} of {rounds}{scrub === null ? ' (latest)' : ''}
            </label>
            <input
              id="swarm-round"
              type="range"
              min={1}
              max={rounds}
              value={round}
              disabled={rounds < 2}
              onChange={(e) => setScrub(Number(e.target.value) >= rounds ? null : Number(e.target.value))}
              className="w-full accent-[#58684E]"
            />
            <div className="mt-1">
              <Check checked={onlyRound} onChange={setOnlyRound}>Only connections active in this round</Check>
            </div>
          </div>
        </div>

        <ul aria-label="Segments" className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-stone-600">
          {segments.map((segment) => (
            <li key={segment.id} className="flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: segmentColor(segments, segment.id) }} />
              {segment.name}
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="h-3 w-3 rounded-full" style={{ background: POI_COLOR }} />
            Point of interest
          </li>
        </ul>
      </section>
      <Feed events={shownEvents} names={names} poi={poi} onOpen={onOpen} />
    </div>
  );
}
