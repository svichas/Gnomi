import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '@gnomi/simulation/audience/sample.ts';
import { influenceEdges } from '@gnomi/simulation/social/influence.ts';
import type { EventPayloads, EventType, GnomiEvent, Opinion, Persona } from '@gnomi/simulation/types.ts';
import { applyEvents, buildGraph, emptyGraph, graphAtRound } from './index.ts';
import type { PersonaNode, PoiNode, SwarmEdge, SwarmNode } from './index.ts';
import { syntheticRun } from '@gnomi/simulation/graph/synthetic.ts';

function logOf() {
  const events: GnomiEvent[] = [];
  const add = <K extends EventType>(type: K, payload: EventPayloads[K], envelope: { persona_id?: string | null; poi_id?: string | null; round?: number } = {}) => {
    events.push({ run_id: 'r-1', seq: events.length + 1, ts: 0, round: 1, persona_id: null, poi_id: null, ...envelope, type, payload } as GnomiEvent);
    return events.length;
  };
  const created = (id: string, segment_id: string | null) => add('persona.created', { persona: { id, name: `Name ${id}`, segment_id } as Persona }, { persona_id: id });
  const step = (persona_id: string, poi_id: string, round = 1) => add('persona.step', {
    step_no: 1, action: { type: 'click', ref: 'e1', text: null }, target: null, result: { ok: true, url_before: '', url_after: '', dom_changed: true, error: null },
    thought: '', feeling: 0, snapshot_hash: 'h', screenshot: null, duration_ms: 0, heard_post_ids: [],
  }, { persona_id, poi_id, round });
  const post = (persona_id: string, post_id: string, parent_id: string | null = null, round = 1) => add('social.post', { post_id, parent_id, text: 'Hard to find', about_poi_id: 'poi-1' }, { persona_id, round });
  return { events, add, created, step, post };
}

const view = (sentiment: number): Opinion => ({ sentiment, confidence: 0.5, likes: [], frictions: [] });
const edgesOf = (events: GnomiEvent[], type: SwarmEdge['type']) => [...buildGraph(events).edges.values()].filter((edge) => edge.type === type);

test('used: the first step on a POI draws the edge; its weight counts steps and it keeps the seqs and round it spans', () => {
  const { events, created, step } = logOf();
  created('a', 'seg-1');
  const first = step('a', 'poi-1');
  step('a', 'poi-1');
  const last = step('a', 'poi-1', 2);
  const graph = buildGraph(events);
  assert.deepEqual(edgesOf(events, 'used'), [{ key: 'used:persona:a>poi:poi-1', type: 'used', source: 'persona:a', target: 'poi:poi-1', weight: 3, first_seq: first, last_seq: last, round: 1, last_round: 2 }]);
  assert.deepEqual(graph.nodes.get('persona:a'), { kind: 'persona', key: 'persona:a', id: 'a', label: 'Name a', segment_id: 'seg-1', status: 'active', step_count: 3, friction_count: 0 });
  assert.equal(graph.nodes.get('poi:poi-1')?.kind, 'poi');
});

test('friction: weight is the summed severity, and both the persona and the POI count frictions', () => {
  const { events, created, add } = logOf();
  created('a', 'seg-1');
  for (const severity of [2, 3]) add('persona.friction_reported', { step_no: 1, severity, what: 'x', expected: 'y', where: { url: '', ref: null }, heard_post_ids: [] }, { persona_id: 'a', poi_id: 'poi-1' });
  assert.equal(edgesOf(events, 'friction')[0].weight, 5);
  const graph = buildGraph(events);
  assert.equal((graph.nodes.get('persona:a') as PersonaNode).friction_count, 2);
  assert.equal((graph.nodes.get('poi:poi-1') as PoiNode).friction_count, 2);
});

test('talked: replies and reactions between two personas make one undirected edge; self-replies and unknown posts draw none', () => {
  const { events, created, post, add } = logOf();
  for (const id of ['a', 'b']) created(id, 'seg-1');
  post('b', 's1');
  post('a', 'r1', 's1'); // a replies to b
  add('social.reaction', { post_id: 's1', kind: 'agree' }, { persona_id: 'a' });
  add('social.reaction', { post_id: 'r1', kind: 'disagree' }, { persona_id: 'b' }); // b reacts to a: the same pair
  post('b', 'r2', 's1'); // b replies to itself
  add('social.reaction', { post_id: 's1', kind: 'agree' }, { persona_id: 'b' }); // and reacts to itself
  add('social.reaction', { post_id: 'missing', kind: 'agree' }, { persona_id: 'a' });
  assert.deepEqual(edgesOf(events, 'talked').map(({ key, source, target, weight }) => ({ key, source, target, weight })), [{ key: 'talked:persona:a>persona:b', source: 'persona:a', target: 'persona:b', weight: 3 }]);
});

test('influenced: edges follow the shared rule, one per pair and kind with a count', () => {
  const { events, created, post, add } = logOf();
  for (const id of ['a', 'b']) created(id, 'seg-1');
  post('a', 's1');
  const changed = (before: number | null, after: number, post_ids: string[], round: number) =>
    add('persona.opinion_changed', { poi_id: 'poi-1', before: before === null ? null : view(before), after: view(after), cause: { step_ids: [], post_ids } }, { persona_id: 'b', round });
  changed(null, -1, ['s1'], 2);
  changed(-1, -1, ['s1'], 2); // no movement
  changed(-1, 1, ['s1', 's1'], 3);
  changed(1, -1, ['s1'], 4);
  assert.deepEqual(edgesOf(events, 'influenced').map(({ source, target, weight, round, last_round, kind }) => ({ source, target, weight, round, last_round, kind })), [
    { source: 'persona:a', target: 'persona:b', weight: 1, round: 2, last_round: 2, kind: 'formed' },
    { source: 'persona:a', target: 'persona:b', weight: 2, round: 3, last_round: 4, kind: 'influence' },
  ]);

  const { events: swarm } = syntheticRun({ personas: 40, pois: 3, rounds: 4, seed: 7 });
  const counts = new Map<string, number>();
  for (const edge of influenceEdges(swarm)) counts.set(`persona:${edge.from}>persona:${edge.to}/${edge.kind}`, (counts.get(`persona:${edge.from}>persona:${edge.to}/${edge.kind}`) ?? 0) + 1);
  assert.ok(counts.size > 0);
  assert.deepEqual(new Map(edgesOf(swarm, 'influenced').map((edge) => [`${edge.source}>${edge.target}/${edge.kind}`, edge.weight])), counts);
});

test('a persona node follows its episode to an end, and the run ending marks the rest unfinished', () => {
  const { events, created, step, add } = logOf();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) created(id, null);
  step('e', 'poi-1');
  add('signal.repeated_failure', { step_no: 1, action: 'click', error: 'ref_not_found' }, { persona_id: 'e' });
  step('f', 'poi-1');
  add('signal.budget_exceeded', { step_no: 1, budget: 1 }, { persona_id: 'f' });
  step('a', 'poi-1');
  add('persona.goal_done', { step_no: 1, summary: '' }, { persona_id: 'a' });
  step('b', 'poi-1');
  add('persona.blocked', { step_no: 1, reason: 'captcha', detail: '' }, { persona_id: 'b' });
  step('c', 'poi-1');
  add('run.finished', {});
  const status = (id: string) => (buildGraph(events).nodes.get(`persona:${id}`) as PersonaNode).status;
  // A budget or failure signal is not the persona's own giving up, as in the report's outcomes.
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f'].map(status), ['done', 'blocked', 'unfinished', 'unfinished', 'unfinished', 'unfinished']);
});

test("a POI's sentiment by segment is the mean of each persona's latest opinion, and surveys do not count", () => {
  const { events, created, add } = logOf();
  created('a', 'seg-1');
  created('b', 'seg-1');
  created('c', null);
  const opinion = (persona_id: string, sentiment: number) => add('persona.opinion_changed', { poi_id: 'poi-1', before: null, after: view(sentiment), cause: { step_ids: [], post_ids: [] } }, { persona_id });
  opinion('a', 2);
  opinion('a', -1); // replaces a's first
  opinion('b', 2);
  add('persona.survey', { poi_id: 'poi-1', sentiment: -2, confidence: 1, likes: [], frictions: [], would_continue: false, reason: '' }, { persona_id: 'c' });
  assert.deepEqual((buildGraph(events).nodes.get('poi:poi-1') as PoiNode).sentiment_by_segment, { 'seg-1': 0.5 });
});

test('an opinion citing a reply with no POI of its own inherits the parent post\'s POI', () => {
  const { events, created, post, add } = logOf();
  for (const id of ['a', 'b', 'c']) created(id, 'seg-1');
  post('a', 's1');
  add('social.post', { post_id: 'r1', parent_id: 's1', text: 'Same here', about_poi_id: null }, { persona_id: 'c' });
  add('persona.opinion_changed', { poi_id: 'poi-1', before: null, after: view(-1), cause: { step_ids: [], post_ids: ['r1'] } }, { persona_id: 'b' });
  assert.deepEqual(edgesOf(events, 'influenced').map(({ source, target, kind }) => ({ source, target, kind })), [{ source: 'persona:c', target: 'persona:b', kind: 'formed' }]);
});

test('the run snapshot names its POI node', () => {
  const { config, events } = syntheticRun({ personas: 3, pois: 2, rounds: 1 });
  const graph = buildGraph(events);
  assert.equal(graph.nodes.get(`poi:${config.project.pois[0].id}`)?.label, config.project.pois[0].name);
  assert.equal(graph.nodes.get('poi:poi-2')?.label, 'poi-2');
});

test('property: applying any prefix in random batches, patching only the reported changes, equals a rebuild', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const random = mulberry32(seed);
    const { events } = syntheticRun({ personas: 6 + Math.floor(random() * 20), pois: 1 + Math.floor(random() * 4), rounds: 1 + Math.floor(random() * 4), seed });
    if (random() < 0.5) events.push({ ...events.at(-1)!, seq: events.length + 1, persona_id: null, poi_id: null, type: 'run.finished', payload: {} } as GnomiEvent);
    for (const prefix of [events.slice(0, Math.floor(random() * events.length)), events]) {
      const live = emptyGraph();
      const nodes = new Map<string, SwarmNode>();
      const edges = new Map<string, SwarmEdge>();
      for (let at = 0; at < prefix.length;) {
        const next = at + 1 + Math.floor(random() * 60);
        const overlap = Math.max(0, at - Math.floor(random() * 5)); // a batch may resend events already applied
        const changes = applyEvents(live, prefix.slice(overlap, next));
        for (const key of changes.nodes) nodes.set(key, structuredClone(live.nodes.get(key)!));
        for (const key of changes.edges) edges.set(key, structuredClone(live.edges.get(key)!));
        at = next;
      }
      const rebuilt = buildGraph(prefix);
      assert.deepEqual(nodes, rebuilt.nodes, `nodes, seed ${seed}, ${prefix.length} events`);
      assert.deepEqual(edges, rebuilt.edges, `edges, seed ${seed}, ${prefix.length} events`);
    }
  }
});

test('scrubber: a round shows only what the log held by its end, and the last round is the whole run', () => {
  const { events } = syntheticRun({ personas: 30, pois: 3, rounds: 3, seed: 3 });
  const whole = buildGraph(events);
  for (const round of [1, 2]) {
    const graph = graphAtRound(events, round);
    const last = events.findLast((event) => event.round === round)!.seq;
    assert.ok(graph.edges.size < whole.edges.size, `round ${round} is a strict subset`);
    for (const edge of graph.edges.values()) {
      assert.ok(edge.round <= round && edge.last_round <= round && edge.last_seq <= last);
      assert.ok(edge.weight <= whole.edges.get(edge.key)!.weight);
    }
  }
  assert.ok([...graphAtRound(events, 2).edges.values()].some((edge) => edge.last_round === 2 && edge.round === 1), 'an edge that grew in round 2');
  assert.deepEqual(graphAtRound(events, 3).edges, whole.edges);
});

test('the synthetic run for the frame-rate check has 200 personas, 10 POIs and about 5,000 edges', () => {
  const graph = buildGraph(syntheticRun().events);
  assert.equal([...graph.nodes.values()].filter((node) => node.kind === 'persona').length, 200);
  assert.equal([...graph.nodes.values()].filter((node) => node.kind === 'poi').length, 10);
  assert.ok(graph.edges.size >= 5000 && graph.edges.size < 5500, `${graph.edges.size} edges`);
});
