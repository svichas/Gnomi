import { useEffect, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import { ControlsContainer, SigmaContainer, useRegisterEvents, useSigma, ZoomControl } from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import { layerImage } from '@sigma/node-image';
import { DEFAULT_STYLES } from 'sigma';
import type { Sigma } from 'sigma';
import { layerFill } from 'sigma/rendering';
import { animateNodes } from 'sigma/utils';
import { applyEvents, EDGE_TYPES, emptyGraph, graphAtRound } from '@gnomi/engine/graph/index.ts';
import type { EdgeType, SwarmGraph, SwarmNode } from '@gnomi/engine/graph/index.ts';
import type { GnomiEvent, PoiType, Segment } from '@gnomi/simulation/types.ts';
import { Button, Check } from './ui.tsx';
import { Icon, iconImage } from './Icon.tsx';
import { connectionMatches, EDGES, NO_SEGMENT, patch, POI_COLOR, reconcile, segmentColor, SMALL_GRAPH_LIMIT, summarizeConnections } from './swarm-view.ts';
import type { GraphFilter } from './swarm-view.ts';
import { roundMoments, selectMoments } from './swarm-moments.ts';
import type { MomentView } from './swarm-moments.ts';
import { MomentBubbles, MomentList } from './SwarmMoments.tsx';
import './swarm.css';

const BATCH_MS = 250; // tech.md §5.5: the live graph is patched at most four times a second
const SETTLE_MS = 4000; // the layout stops this long after the last change
const DEFAULT_CONNECTIONS: EdgeType[] = [...EDGE_TYPES];
const POI_KINDS: Record<PoiType, { label: string; icon: 'globe' | 'image' | 'report' }> = { web: { label: 'Website', icon: 'globe' }, design: { label: 'Design', icon: 'image' }, text: { label: 'Text', icon: 'report' } };
const NODE_IMAGES = { persona: iconImage('person'), web: iconImage('globe'), design: iconImage('image'), text: iconImage('report') };
const motion = (ms: number) => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
type Hover = { key: string; x: number; y: number; left: boolean };
type NodeState = { isHovered: boolean; isHighlighted: boolean };
type Easing = { stop(): void; targets: Record<string, Record<string, number>> };

/**
 * Eases what an update changed: new nodes grow in, and a small graph's ring slides to its new places (a larger one's positions belong to the layout).
 * An update first finishes the previous easing, so no node is left part-grown or animated after the update drops it.
 */
function eased(graph: Graph, last: { current: Easing | null }, update: () => void) {
  if (last.current) {
    last.current.stop();
    for (const [key, values] of Object.entries(last.current.targets)) if (graph.hasNode(key)) graph.mergeNodeAttributes(key, values);
    last.current = null;
  }
  const before = new Map(graph.mapNodes((key, attributes) => [key, { x: attributes.x as number, y: attributes.y as number }]));
  update();
  if (!motion(1)) return;
  const targets: Easing['targets'] = {};
  graph.forEachNode((key, attributes) => {
    const was = before.get(key);
    if (!was) {
      targets[key] = { size: attributes.size };
      graph.setNodeAttribute(key, 'size', 0);
    } else if (graph.order <= SMALL_GRAPH_LIMIT && (was.x !== attributes.x || was.y !== attributes.y)) {
      targets[key] = { x: attributes.x, y: attributes.y };
      graph.mergeNodeAttributes(key, was);
    }
  });
  if (Object.keys(targets).length) last.current = { stop: animateNodes(graph, targets, { duration: 450, easing: 'cubicOut' }), targets };
}

/** Clicks and hovers on the canvas; WebGL has no DOM, so the smoke test finds nodes through the instance on the container. */
function Interaction({ focus, onOpen, onHover, onFocus }: { focus: string | null; onOpen(personaId: string): void; onHover(hover: Hover | null): void; onFocus(key: string | null): void }) {
  const sigma = useSigma();
  const register = useRegisterEvents();
  useEffect(() => {
    Object.assign(sigma.getContainer(), { sigma });
    const graph = sigma.getGraph();
    register({
      clickNode: ({ node }) => node.startsWith('persona:') ? onOpen(node.slice('persona:'.length)) : onFocus(node),
      clickStage: () => onFocus(null),
      enterNode: ({ node }) => {
        // Hovering lights up a node's own connections; the styles fade everything else.
        sigma.setNodesState(graph.neighbors(node), { isHighlighted: true });
        sigma.setEdgesState(graph.edges(node), { isHighlighted: true });
        const at = sigma.framedGraphToViewport(sigma.getNodeDisplayData(node)!);
        const { width, height } = sigma.getDimensions();
        onHover({ key: node, x: at.x, y: Math.max(72, Math.min(height - 72, at.y)), left: at.x > width / 2 });
      },
      leaveNode: () => {
        sigma.setNodesState(graph.nodes(), { isHighlighted: false });
        sigma.setEdgesState(graph.edges(), { isHighlighted: false });
        onHover(null);
      },
    });
  }, [sigma, register, onOpen, onHover, onFocus]);
  useEffect(() => {
    const camera = sigma.getCamera();
    const at = focus ? sigma.getNodeDisplayData(focus) : undefined;
    if (at) camera.animate({ x: at.x, y: at.y, ratio: Math.min(camera.ratio, 0.75) }, { duration: motion(600), easing: 'cubicInOut' });
    else camera.reset({ duration: motion(600), easing: 'cubicInOut' });
  }, [sigma, focus]);
  useEffect(() => {
    const resize = new ResizeObserver(([entry]) => {
      const padding = entry.contentRect.width < 480 ? 64 : 88;
      if (sigma.getSetting('stagePadding') !== padding) sigma.setSetting('stagePadding', padding);
    });
    resize.observe(sigma.getContainer());
    return () => resize.disconnect();
  }, [sigma]);
  return null;
}

const STATUS: Record<string, string> = { waiting: 'Waiting to start', active: 'Exploring', blocked: 'Blocked', done: 'Goal reached', abandoned: 'Stopped trying', unfinished: 'Stopped early' };
const count = (n: number, noun: string, tail = '') => `${n} ${noun}${n === 1 ? '' : 's'}${tail}`;
const signed = (n: number) => `${n > 0 ? '+' : ''}${Number(n.toFixed(1))}`;

function NodeCard({ node, segments, at }: { node: SwarmNode; segments: Segment[]; at: Hover }) {
  const segmentName = (id: string) => segments.find((segment) => segment.id === id)?.name ?? 'No segment';
  const poi = node.kind === 'poi' && node.poi_type ? POI_KINDS[node.poi_type] : null;
  return (
    <div role="status" className="swarm-node-card" data-side={at.left ? 'left' : 'right'} style={{ left: at.x, top: at.y }}>
      <div className="swarm-node-head">
        <span aria-hidden className="swarm-node-icon" style={{ background: node.kind === 'persona' ? segmentColor(segments, node.segment_id) : POI_COLOR }}><Icon name={node.kind === 'persona' ? 'person' : poi?.icon ?? 'globe'} size={14} /></span>
        <div>
          <span className="swarm-node-kind">{node.kind === 'persona' ? 'Simulated person' : poi ? `Product area · ${poi.label}` : 'Product area'}</span>
          <p className="swarm-node-title">{node.label}</p>
        </div>
      </div>
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
export function Swarm({ active, events, segments, onOpen, expectedPersonas }: { active: boolean; events: GnomiEvent[]; segments: Segment[]; expectedPersonas?: number; onOpen(personaId: string, seq?: number): void }) {
  const [graph] = useState(() => new Graph({ multi: true, type: 'mixed' }));
  const [scrub, setScrub] = useState<number | null>(null); // null follows the run as it happens
  const [types, setTypes] = useState<Set<EdgeType>>(() => new Set(DEFAULT_CONNECTIONS));
  const [onlyRound, setOnlyRound] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [moving, setMoving] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [hovered, setHovered] = useState<Hover | null>(null);
  const [momentView, setMomentView] = useState<MomentView>('all');
  const [bubbles, setBubbles] = useState(true);
  const [shown, setShown] = useState<SwarmGraph>(emptyGraph); // what is drawn, for the counts and the hover card
  const [webgl2] = useState(() => document.createElement('canvas').getContext('webgl2') !== null); // without it sigma throws, which blanks the app
  const latest = useRef(events);
  latest.current = events;
  const rounds = useMemo(() => events.reduce((most, event) => Math.max(most, event.round), 1), [events]);
  const round = scrub ?? rounds;
  const filter = useMemo<GraphFilter>(() => ({ types, round: onlyRound ? round : null, focus }), [types, onlyRound, round, focus]);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const layout = useRef<FA2Layout | null>(null);
  const settle = useRef<number | undefined>(undefined);
  const easing = useRef<Easing | null>(null);
  const laidOut = moving && active; // a hidden map keeps its positions
  const movingRef = useRef(laidOut);
  movingRef.current = laidOut;

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
    if (laidOut && graph.order > SMALL_GRAPH_LIMIT) {
      layout.current?.start();
      settle.current = window.setTimeout(() => layout.current?.stop(), SETTLE_MS);
    } else layout.current?.stop();
  }, [graph, laidOut]);

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
      eased(graph, easing, () => reconcile(graph, projection, segments));
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
      eased(graph, easing, () => applied === 0 ? reconcile(graph, projection, segments) : patch(graph, projection, changes, segments));
      applied = all.length;
      changed();
    };
    tick();
    const timer = window.setInterval(tick, BATCH_MS);
    return () => window.clearInterval(timer);
  }, [graph, scrub, segments]);

  const summary = useMemo(() => summarizeConnections(shown.edges.values(), filter), [shown, filter]);
  const moments = useMemo(() => roundMoments(events, round, shown.last_seq), [events, round, shown.last_seq]);
  const highlights = useMemo(() => selectMoments(moments, momentView, focus), [moments, momentView, focus]);
  const viewRef = useRef({ focus, connectedNodes: summary.connectedNodes, nodeCount: shown.nodes.size });
  viewRef.current = { focus, connectedNodes: summary.connectedNodes, nodeCount: shown.nodes.size };

  // Filters are a style over the edges, not graph data: sigma 4 cannot repaint attribute changes on edges it has not indexed yet.
  const sigma = useRef<Sigma | null>(null);
  const [options] = useState(() => ({
    primitives: { nodes: { layers: [layerFill(), layerImage({ padding: 0.22 })] } },
    // allowInvalidContainer: React detaches the canvas a frame or more before it kills sigma, and an easing may render in between.
    settings: { allowInvalidContainer: true, itemSizesReference: 'screen' as const, labelRenderedSizeThreshold: 9, stagePadding: 88, minCameraRatio: 0.15, maxCameraRatio: 4 },
    styles: {
      nodes: [DEFAULT_STYLES.nodes, {
        cursor: 'pointer',
        image: (attributes: { kind?: string; poi_type?: PoiType | null }) => attributes.kind === 'persona' ? NODE_IMAGES.persona : attributes.poi_type ? NODE_IMAGES[attributes.poi_type] : undefined,
        size: (attributes: { kind?: string; size?: number }, state: NodeState) => (attributes.size ?? 6) * (attributes.kind === 'persona' && viewRef.current.nodeCount > 80 ? 0.65 : 1) * (state.isHovered ? 1.3 : 1),
        opacity: (attributes: { key?: string }, state: NodeState, graphState: { hasHovered: boolean }) => {
          if (graphState.hasHovered) return state.isHovered || state.isHighlighted ? 1 : 0.2;
          return viewRef.current.focus && !viewRef.current.connectedNodes.has(attributes.key ?? '') ? 0.2 : 1;
        },
        labelVisibility: (attributes: { kind?: string; key?: string }, state: NodeState, graphState: { hasHovered: boolean }) => {
          const view = viewRef.current;
          if (state.isHovered) return 'visible' as const;
          if (graphState.hasHovered && !state.isHighlighted) return 'hidden' as const;
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
        size: (attributes: { size?: number }, state: NodeState) => (attributes.size ?? 1) * (state.isHighlighted ? 1.8 : 1),
        opacity: (_: unknown, state: NodeState, graphState: { hasHovered: boolean }) => graphState.hasHovered && !state.isHighlighted ? 0.1 : 1,
        visibility: (attributes: { kind?: EdgeType; source?: string; target?: string; last_round?: number }) => attributes.kind && attributes.source && attributes.target && attributes.last_round !== undefined && connectionMatches({ type: attributes.kind, source: attributes.source, target: attributes.target, last_round: attributes.last_round }, filterRef.current) ? 'visible' as const : 'hidden' as const,
      }],
    },
  }));
  // biome-ignore lint/correctness/useExhaustiveDependencies: sigma reads the filter and graph through refs, so it is told to repaint when they change, and when shown again since a hidden canvas has no size
  useEffect(() => {
    if (active) sigma.current?.refresh();
  }, [filter, shown, active]);

  const nodes = useMemo(() => [...shown.nodes.values()], [shown]);
  const personas = nodes.filter((node) => node.kind === 'persona').length;
  const hoveredNode = hovered ? shown.nodes.get(hovered.key) : undefined;
  const focusedNode = focus ? shown.nodes.get(focus) : undefined;
  const filtered = types.size !== DEFAULT_CONNECTIONS.length || DEFAULT_CONNECTIONS.some((type) => !types.has(type)) || onlyRound || focus !== null || momentView !== 'all';
  const resetFilters = () => { setTypes(new Set(DEFAULT_CONNECTIONS)); setOnlyRound(false); setFocus(null); setMomentView('all'); };
  const name = (id: string) => shown.nodes.get(`persona:${id}`)?.label ?? id;
  const changeMomentView = (view: MomentView) => {
    setMomentView(view);
    setTypes(new Set(view === 'social' ? ['talked', 'influenced'] : view === 'friction' ? ['friction'] : DEFAULT_CONNECTIONS));
  };

  return (
      <section aria-label="Swarm graph" className="swarm-panel">
        <div className="swarm-heading">
          <div><h2>Simulation map</h2><p>A closer look at what people think, where they struggle, and who they talk to.</p></div>
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
        <div className="swarm-viewbar">
          <div className="swarm-view-switch" role="group" aria-label="Map activity view">
            {([['all', 'All activity', 'activity'], ['friction', 'Friction', 'alert'], ['social', 'Social', 'message']] as const).map(([view, label, icon]) => <button type="button" key={view} aria-pressed={momentView === view} onClick={() => changeMomentView(view)}><Icon name={icon} size={14} />{label}</button>)}
          </div>
          <Check checked={bubbles} onChange={setBubbles}>Show bubbles</Check>
        </div>
        <div className="swarm-canvas" role="group" aria-label="Interactive map. Use the focus selector below to explore people and product areas with a keyboard.">
          {webgl2 ? <SigmaContainer ref={sigma} graph={graph} style={{ height: '100%', width: '100%', background: 'transparent' }} options={options}>
            <Interaction focus={focus} onOpen={onOpen} onHover={setHovered} onFocus={setFocus} />
            {bubbles && <MomentBubbles moments={highlights} name={name} onOpen={onOpen} showConversations={types.has('talked')} />}
            <ControlsContainer position="bottom-right">
              <ZoomControl labels={{ zoomIn: 'Zoom in', zoomOut: 'Zoom out', reset: 'Fit the whole graph' }} />
            </ControlsContainer>
          </SigmaContainer> : <div className="swarm-empty"><Icon name="alert" size={28} /><strong>This computer cannot draw the map</strong><p>The map needs WebGL 2, which this computer’s graphics do not offer. The moments and activity still update.</p></div>}
          {hovered && hoveredNode && <NodeCard key={hovered.key} node={hoveredNode} segments={segments} at={hovered} />}
          {webgl2 && shown.nodes.size === 0 && <div className="swarm-empty"><Icon name="people" size={28} /><strong>Your simulation map is taking shape</strong><p>{expectedPersonas ? `${expectedPersonas} simulated ${expectedPersonas === 1 ? 'person' : 'people'} will appear as they join.` : 'People and product areas appear as the simulation starts.'}</p></div>}
          {shown.nodes.size > 0 && <div className="swarm-canvas-caption"><span />{momentView === 'social' ? 'Arrows show who replied or reacted to whom' : 'Each bubble is a recorded persona moment'}</div>}
        </div>
        <div className="swarm-moments">
          <div className="swarm-moments-heading"><h3>{momentView === 'social' ? 'Who’s talking to whom' : momentView === 'friction' ? 'Where people struggle' : 'Thoughts & reactions'}</h3><span>Round {round} · {highlights.length ? `${highlights.length} recent moments` : 'No moments yet'}</span></div>
          {highlights.length ? <MomentList moments={highlights} name={name} onOpen={onOpen} /> : <p className="swarm-moments-empty">{momentView === 'social' ? 'No social moments in this round and focus. Replies and reactions appear here when people interact.' : momentView === 'friction' ? 'No friction reported in this round and focus.' : 'Thoughts, friction, and conversations will appear as people take part in this round.'}</p>}
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
            <p className="swarm-filter-help">Lines show accumulated connections. Bubbles and moments show activity from the selected round; arrows point from the speaker to the person they replied or reacted to.</p>
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
