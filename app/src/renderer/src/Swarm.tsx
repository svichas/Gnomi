import { useEffect, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import { ControlsContainer, SigmaContainer, useRegisterEvents, useSigma, ZoomControl } from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import { DEFAULT_STYLES } from 'sigma';
import type { Sigma } from 'sigma';
import { fnv1a } from '@gnomi/simulation/audience/sample.ts';
import { applyEvents, EDGE_TYPES, emptyGraph, graphAtRound } from '@gnomi/engine/graph/index.ts';
import type { EdgeType, GraphChanges, SwarmEdge, SwarmGraph, SwarmNode } from '@gnomi/engine/graph/index.ts';
import type { GnomiEvent, Segment } from '@gnomi/simulation/types.ts';
import { Button, Check } from './ui.tsx';
import { Icon } from './Icon.tsx';
import { connectionMatches, summarizeConnections } from './swarm-view.ts';
import type { GraphFilter } from './swarm-view.ts';
import './swarm.css';

// Colours from docs/brand.md §5: the categorical sequence for segments, Ink for POIs, status colours for edge meaning.
const SEGMENT_COLORS = ['#58684E', '#56768A', '#8A6A83', '#A27B36', '#417F78'];
const NO_SEGMENT = '#686D65';
const POI_COLOR = '#222823';
const EDGES: Record<EdgeType, { label: string; color: string; description: string }> = {
  used: { label: 'Product use', color: '#87917D99', description: 'A person interacted with a product area' },
  talked: { label: 'Conversations', color: '#686D6577', description: 'People replied or reacted to one another' },
  influenced: { label: 'Opinion shifts', color: '#496D85', description: 'A conversation contributed to a change of opinion' },
  friction: { label: 'Friction', color: '#AA5147', description: 'A person reported difficulty with a product area' },
};
const BATCH_MS = 250; // tech.md §5.5: the live graph is patched at most four times a second
const SETTLE_MS = 4000; // the layout stops this long after the last change
const SMALL_GRAPH_LIMIT = 24;
const DEFAULT_CONNECTIONS: EdgeType[] = ['used', 'friction'];

const segmentColor = (segments: Segment[], id: string | null) => {
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
function patch(graph: Graph, projection: SwarmGraph, changes: GraphChanges, segments: Segment[]) {
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
function reconcile(graph: Graph, projection: SwarmGraph, segments: Segment[]) {
  for (const key of graph.edges()) if (!projection.edges.has(key)) graph.dropEdge(key);
  for (const key of graph.nodes()) if (!projection.nodes.has(key)) graph.dropNode(key);
  patch(graph, projection, { nodes: new Set(projection.nodes.keys()), edges: new Set(projection.edges.keys()) }, segments);
}

/** Clicks and hovers on the canvas; WebGL has no DOM, so the smoke test finds nodes through the instance on the container. */
function Interaction({ onOpen, onHover, onFocus }: { onOpen(personaId: string): void; onHover(key: string | null): void; onFocus(key: string | null): void }) {
  const sigma = useSigma();
  const register = useRegisterEvents();
  useEffect(() => {
    Object.assign(sigma.getContainer(), { sigma });
    register({
      clickNode: ({ node }) => node.startsWith('persona:') ? onOpen(node.slice('persona:'.length)) : onFocus(node),
      clickStage: () => onFocus(null),
      enterNode: ({ node }) => onHover(node),
      leaveNode: () => onHover(null),
    });
  }, [sigma, register, onOpen, onHover, onFocus]);
  return null;
}

const STATUS: Record<string, string> = { waiting: 'Waiting to start', active: 'Exploring', blocked: 'Blocked', done: 'Goal reached', abandoned: 'Stopped trying', unfinished: 'Stopped early' };
const count = (n: number, noun: string, tail = '') => `${n} ${noun}${n === 1 ? '' : 's'}${tail}`;
const signed = (n: number) => `${n > 0 ? '+' : ''}${Number(n.toFixed(1))}`;

function NodeCard({ node, segments }: { node: SwarmNode; segments: Segment[] }) {
  const segmentName = (id: string) => segments.find((segment) => segment.id === id)?.name ?? 'No segment';
  return (
    <div role="status" className="swarm-node-card">
      <span className="swarm-node-kind">{node.kind === 'persona' ? 'Simulated person' : 'Product area'}</span>
      <p className="swarm-node-title">{node.label}</p>
      {node.kind === 'persona' ? (
        <><p>{node.segment_id ? segmentName(node.segment_id) : 'No segment'} · {STATUS[node.status]}</p><p>{count(node.step_count, 'action')} · {count(node.friction_count, 'friction')}</p><p className="swarm-node-hint">Click to inspect their activity</p></>
      ) : (
        <>
          <p>{count(node.friction_count, 'friction')} reported here</p>
          {Object.entries(node.sentiment_by_segment).map(([id, value]) => <p key={id}>{segmentName(id)}: sentiment {signed(value)} of −2 to +2</p>)}
          <p className="swarm-node-hint">Click to focus on this area</p>
        </>
      )}
    </div>
  );
}

/** An event-backed map of product use, friction, and social influence. */
export function Swarm({ events, segments, onOpen, expectedPersonas }: { events: GnomiEvent[]; segments: Segment[]; expectedPersonas?: number; onOpen(personaId: string): void }) {
  const [graph] = useState(() => new Graph({ multi: true, type: 'mixed' }));
  const [scrub, setScrub] = useState<number | null>(null); // null follows the run as it happens
  const [types, setTypes] = useState<Set<EdgeType>>(() => new Set(DEFAULT_CONNECTIONS));
  const [onlyRound, setOnlyRound] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [moving, setMoving] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [hovered, setHovered] = useState<string | null>(null);
  const [shown, setShown] = useState<SwarmGraph>(emptyGraph); // what is drawn, for the counts and the hover card
  const latest = useRef(events);
  latest.current = events;
  const rounds = useMemo(() => events.reduce((most, event) => Math.max(most, event.round), 1), [events]);
  const round = scrub ?? rounds;
  const filter = useMemo<GraphFilter>(() => ({ types, round: onlyRound ? round : null, focus }), [types, onlyRound, round, focus]);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const layout = useRef<FA2Layout | null>(null);
  const settle = useRef<number | undefined>(undefined);
  const movingRef = useRef(moving);
  movingRef.current = moving;

  useEffect(() => {
    // graphology's inferred ForceAtlas2 settings for a few hundred nodes; log weights so a 60-step edge does not swallow its persona.
    layout.current = new FA2Layout(graph, { settings: { strongGravityMode: true, gravity: 0.05, scalingRatio: 10, slowDown: 5, barnesHutOptimize: true }, getEdgeWeight: (_, attributes) => Math.log2(1 + attributes.weight) });
    return () => {
      window.clearTimeout(settle.current);
      layout.current?.kill();
    };
  }, [graph]);

  useEffect(() => {
    window.clearTimeout(settle.current);
    if (moving && graph.order > SMALL_GRAPH_LIMIT) {
      layout.current?.start();
      settle.current = window.setTimeout(() => layout.current?.stop(), SETTLE_MS);
    } else layout.current?.stop();
  }, [graph, moving]);

  useEffect(() => {
    const changed = () => {
      setShown({ ...projection }); // the projection is patched in place
      if (movingRef.current && graph.order > SMALL_GRAPH_LIMIT) layout.current?.start();
      else layout.current?.stop();
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
    if (latest.current.length === 0) {
      reconcile(graph, projection, segments);
      changed();
    }
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

  const summary = useMemo(() => summarizeConnections(shown.edges.values(), filter), [shown, filter]);
  const viewRef = useRef({ focus, connectedNodes: summary.connectedNodes, nodeCount: shown.nodes.size });
  viewRef.current = { focus, connectedNodes: summary.connectedNodes, nodeCount: shown.nodes.size };

  // Filters are a style over the edges, not graph data: sigma 4 cannot repaint attribute changes on edges it has not indexed yet.
  const sigma = useRef<Sigma | null>(null);
  const [options] = useState(() => ({
    settings: { itemSizesReference: 'screen' as const, labelRenderedSizeThreshold: 9, stagePadding: 64, minCameraRatio: 0.15, maxCameraRatio: 4 },
    styles: {
      nodes: [DEFAULT_STYLES.nodes, {
        cursor: 'pointer',
        size: (attributes: { kind?: string; size?: number }) => (attributes.size ?? 6) * (attributes.kind === 'persona' && viewRef.current.nodeCount > 80 ? 0.65 : 1),
        opacity: (attributes: { key?: string }) => viewRef.current.focus && !viewRef.current.connectedNodes.has(attributes.key ?? '') ? 0.2 : 1,
        labelVisibility: (attributes: { kind?: string; key?: string }) => {
          const view = viewRef.current;
          if (view.focus && !view.connectedNodes.has(attributes.key ?? '')) return 'hidden' as const;
          return attributes.kind === 'poi' || view.nodeCount <= 20 || attributes.key === view.focus ? 'visible' as const : 'auto' as const;
        },
        labelColor: POI_COLOR,
        labelSize: (attributes: { kind?: string }) => viewRef.current.nodeCount <= SMALL_GRAPH_LIMIT ? 14 : attributes.kind === 'poi' ? 13 : 12,
        labelPosition: () => viewRef.current.nodeCount <= SMALL_GRAPH_LIMIT ? 'below' as const : 'right' as const,
        labelFont: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        labelBackgroundColor: '#F6F5F0',
        labelBackgroundPadding: 3,
      }],
      edges: [DEFAULT_STYLES.edges, {
        visibility: (attributes: { kind?: EdgeType; source?: string; target?: string; last_round?: number }) => attributes.kind && attributes.source && attributes.target && attributes.last_round !== undefined && connectionMatches({ type: attributes.kind, source: attributes.source, target: attributes.target, last_round: attributes.last_round }, filterRef.current) ? 'visible' as const : 'hidden' as const,
      }],
    },
  }));
  useEffect(() => {
    sigma.current?.refresh();
  }, [filter, shown]);

  const nodes = useMemo(() => [...shown.nodes.values()], [shown]);
  const personas = nodes.filter((node) => node.kind === 'persona').length;
  const hoveredNode = hovered ? shown.nodes.get(hovered) : undefined;
  const focusedNode = focus ? shown.nodes.get(focus) : undefined;
  const filtered = types.size !== DEFAULT_CONNECTIONS.length || DEFAULT_CONNECTIONS.some((type) => !types.has(type)) || onlyRound || focus !== null;
  const resetFilters = () => { setTypes(new Set(DEFAULT_CONNECTIONS)); setOnlyRound(false); setFocus(null); };

  return (
      <section aria-label="Swarm graph" className="swarm-panel">
        <div className="swarm-heading">
          <div><h2>Simulation map</h2><p>See where people explore, encounter friction, and influence each other.</p></div>
          <span className="swarm-round-badge">{scrub === null ? 'Latest' : 'History'} · Round {round}</span>
        </div>
        <div className="swarm-toolbar">
          <p className="swarm-counts">
            {count(personas, 'persona')}, {count(shown.nodes.size - personas, 'point', ' of interest')}, {count(shown.edges.size, 'connection')}
          </p>
          {shown.nodes.size > SMALL_GRAPH_LIMIT && <Button variant="quiet" small className="swarm-motion" aria-pressed={!moving} onClick={() => setMoving((value) => !value)} title="Freeze node positions while new activity continues to arrive">
            <Icon name={moving ? 'check' : 'play'} size={14} />{moving ? 'Freeze layout' : 'Resume layout'}
          </Button>}
        </div>
        <div className="swarm-canvas" aria-label="Interactive map. Use the focus selector below to explore people and product areas with a keyboard.">
          <SigmaContainer ref={sigma} graph={graph} style={{ height: '100%', width: '100%', background: 'transparent' }} options={options}>
            <Interaction onOpen={onOpen} onHover={setHovered} onFocus={setFocus} />
            <ControlsContainer position="bottom-right">
              <ZoomControl labels={{ zoomIn: 'Zoom in', zoomOut: 'Zoom out', reset: 'Fit the whole graph' }} />
            </ControlsContainer>
          </SigmaContainer>
          {hoveredNode && <NodeCard node={hoveredNode} segments={segments} />}
          {shown.nodes.size === 0 && <div className="swarm-empty"><Icon name="people" size={28} /><strong>Your simulation map is taking shape</strong><p>{expectedPersonas ? `${expectedPersonas} simulated ${expectedPersonas === 1 ? 'person' : 'people'} will appear as they join.` : 'People and product areas appear as the simulation starts.'}</p></div>}
        </div>
        <div className="swarm-legend">
          <span>People by segment</span>
          <ul aria-label="Segments">
            {segments.map((segment) => <li key={segment.id}><span aria-hidden className="swarm-person-dot" style={{ background: segmentColor(segments, segment.id) }} />{segment.name}</li>)}
            {nodes.some((node) => node.kind === 'persona' && !node.segment_id) && <li><span aria-hidden className="swarm-person-dot" style={{ background: NO_SEGMENT }} />Unassigned</li>}
            <li className="swarm-poi-legend"><span aria-hidden className="swarm-poi-dot" />Product area</li>
          </ul>
          <p>Larger people have taken more actions.</p>
        </div>
        <div className="swarm-explore">
          <div className="swarm-focus-row">
            <label htmlFor="swarm-focus">Focus on</label>
            <select id="swarm-focus" value={focus ?? ''} onChange={(event) => setFocus(event.target.value || null)}>
              <option value="">Everyone &amp; every product area</option>
              <optgroup label="Product areas">{nodes.filter((node) => node.kind === 'poi').map((node) => <option key={node.key} value={node.key}>{node.label}</option>)}</optgroup>
              <optgroup label="Simulated people">{nodes.filter((node) => node.kind === 'persona').map((node) => <option key={node.key} value={node.key}>{node.label}</option>)}</optgroup>
            </select>
            {focusedNode?.kind === 'persona' && <Button variant="link" small onClick={() => onOpen(focusedNode.id)}>View activity <Icon name="arrow" size={14} /></Button>}
            <span className="swarm-visible-count" role="status">{count(summary.visible, 'visible connection')}</span>
            {filtered && <Button variant="quiet" small onClick={resetFilters}>Reset view</Button>}
          </div>
          <fieldset className="swarm-connection-filters">
            <legend>Show connections</legend>
            <div>
              {EDGE_TYPES.map((type) => (
                <label key={type} className="swarm-filter" title={EDGES[type].description}>
                  <input type="checkbox" checked={types.has(type)} onChange={(event) => setTypes((was) => { const next = new Set(was); if (event.target.checked) next.add(type); else next.delete(type); return next; })} />
                  <span aria-hidden className="swarm-edge-sample" style={{ background: EDGES[type].color.slice(0, 7) }} />
                  {EDGES[type].label}<span className="swarm-filter-count">{summary.byType[type]}</span>
                </label>
              ))}
            </div>
            <p className="swarm-filter-help">Product use and friction are shown first. Enable Conversations and Opinion shifts to explore social connections.</p>
          </fieldset>
          {filtered && summary.visible === 0 && shown.edges.size > 0 && <p className="swarm-filter-empty">No connections match this view. Choose another person, round, or connection type.</p>}
        </div>
        {rounds > 1 && <div className="swarm-history">
          <div className="swarm-round-label"><label htmlFor="swarm-round">Replay rounds</label><span>Round {round} of {rounds}</span></div>
            <input
              id="swarm-round"
              type="range"
              min={1}
              max={rounds}
              value={round}
              onChange={(e) => setScrub(Number(e.target.value) >= rounds ? null : Number(e.target.value))}
              aria-valuetext={`Round ${round} of ${rounds}${scrub === null ? ', latest' : ''}`}
            />
            <Check checked={onlyRound} onChange={setOnlyRound}>This round only</Check>
            {scrub !== null && <Button variant="link" small onClick={() => setScrub(null)}>Back to latest <Icon name="arrow" size={14} /></Button>}
        </div>}
        <p className="swarm-help">{shown.edges.size === 0 && 'Connections appear as people explore, share opinions, or report friction. '}Click a person to inspect their activity. Click a product area to isolate its connections. Drag to pan; use the controls to zoom.</p>
      </section>
  );
}
