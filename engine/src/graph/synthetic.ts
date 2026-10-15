import { fixture } from '../acceptance/fixture.ts';
import { mulberry32 } from '../audience/sample.ts';
import { newRunConfig } from '../run.ts';
import type { EventPayloads, EventType, GnomiEvent, Persona, RunConfig } from '../types.ts';

// A seeded synthetic swarm run for graph tests and the frame-rate check: rounds of steps, frictions, posts, replies, reactions
// and cited opinion changes, written as the social engine would log them, with no browser and no model.

const SAYS = [
  'The save button is easy to miss', 'Took me three tries to find the filters', 'Honestly this part was quick',
  'The review screen hides the feedback button', 'Love the keyboard shortcuts here', 'Error message did not say what to fix',
];

export function syntheticRun({ personas: size = 200, pois = 10, rounds = 5, seed = 1 } = {}): { config: RunConfig; events: GnomiEvent[] } {
  const random = mulberry32(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const base = fixture('http://gym.test');
  const personas = Array.from({ length: size }, (_, i): Persona => {
    const template = base.personas[i % base.personas.length];
    const copy = Math.floor(i / base.personas.length);
    return copy ? { ...template, id: `${template.id}-${copy}`, name: `${template.name} ${copy + 1}` } : template;
  });
  const config: RunConfig = { ...newRunConfig(base.project, { personas, sessions: [], reset: false }), run_id: 'r-synthetic' };
  const poiIds = [base.project.poi.id, ...Array.from({ length: pois - 1 }, (_, i) => `poi-${i + 2}`)];

  const events: GnomiEvent[] = [];
  const log = <K extends EventType>(round: number, persona_id: string | null, poi_id: string | null, type: K, payload: EventPayloads[K]) =>
    events.push({ run_id: config.run_id, seq: events.length + 1, ts: events.length + 1, round, persona_id, poi_id, type, payload } as GnomiEvent);

  log(1, null, null, 'run.started', { config });
  const follows = new Map(personas.map((persona) => {
    const same = personas.filter((other) => other.segment_id === persona.segment_id && other.id !== persona.id);
    const others = personas.filter((other) => other.id !== persona.id);
    return [persona.id, [...new Set(Array.from({ length: 8 }, () => pick(random() < 0.7 && same.length ? same : others).id))]];
  }));
  for (const persona of personas) log(1, persona.id, null, 'persona.created', { persona, follows: follows.get(persona.id) });

  const visits = new Map(personas.map((persona, i) => [persona.id, [poiIds[i % pois], pick(poiIds), pick(poiIds)]]));
  const steps = new Map<string, number>();
  const opinions = new Map<string, number>();
  const posts: { id: string; author: string; poi: string }[] = [];
  for (let round = 1; round <= rounds; round++) {
    log(round, null, null, 'run.round_started', {});
    for (const persona of personas) {
      const poi = pick(visits.get(persona.id)!);
      const url = `http://gym.test/${poi}`;
      if (round === 1) log(round, persona.id, poi, 'persona.episode_started', { poi_id: poi, device: persona.device, start_url: url });
      for (let s = 0; s < 2; s++) {
        const step_no = (steps.get(persona.id) ?? 0) + 1;
        steps.set(persona.id, step_no);
        log(round, persona.id, poi, 'persona.step', {
          step_no, action: { type: 'click', ref: 'e1', text: null }, target: { role: 'button', name: 'Next', box: null },
          result: { ok: true, url_before: url, url_after: url, dom_changed: true, error: null },
          thought: 'Looking for the next step.', feeling: 0, snapshot_hash: `h${step_no}`, screenshot: null, duration_ms: 100,
        });
        if (random() < 0.12) log(round, persona.id, poi, 'persona.friction_reported', { step_no, severity: 1 + Math.floor(random() * 4), what: pick(SAYS), expected: 'A clear next step', where: { url, ref: 'e1' } });
      }
    }
    for (const persona of personas) {
      const followed = new Set(follows.get(persona.id));
      const recent = posts.slice(-80).filter((post) => post.author !== persona.id);
      const feed = [...recent.filter((post) => followed.has(post.author)), ...recent].filter((post, i, all) => all.indexOf(post) === i).slice(0, 12);
      log(round, persona.id, null, 'social.feed_viewed', { post_ids: feed.map((post) => post.id) });
      const injected = round === 1 && persona === personas[0];
      if (injected || random() < 0.25) {
        const parent = feed.length && random() < 0.5 ? pick(feed) : null;
        const post = { id: `post-${posts.length + 1}`, author: persona.id, poi: parent?.poi ?? pick(visits.get(persona.id)!) };
        posts.push(post);
        log(round, persona.id, null, 'social.post', { post_id: post.id, parent_id: parent?.id ?? null, text: pick(SAYS), about_poi_id: post.poi, ...(injected && { injected: true }) });
      }
      for (const post of feed.slice(0, 2 + Math.floor(random() * 9))) log(round, persona.id, null, 'social.reaction', { post_id: post.id, kind: random() < 0.6 ? 'agree' : 'disagree' });
      const cited = feed.filter((post) => post.poi === feed[0]?.poi).slice(0, 2);
      if (cited.length && random() < 0.4) {
        const key = `${persona.id}\n${cited[0].poi}`;
        const before = opinions.get(key) ?? null;
        const sentiment = Math.max(-2, Math.min(2, (before ?? 0) + pick([-2, -1, 1])));
        opinions.set(key, sentiment);
        const view = (value: number) => ({ sentiment: value, confidence: 0.6, likes: [], frictions: [] });
        log(round, persona.id, cited[0].poi, 'persona.opinion_changed', {
          poi_id: cited[0].poi, before: before === null ? null : view(before), after: view(sentiment), cause: { step_ids: [], post_ids: cited.map((post) => post.id) },
        });
      }
    }
    log(round, null, null, 'run.round_ended', {});
  }
  return { config, events };
}
