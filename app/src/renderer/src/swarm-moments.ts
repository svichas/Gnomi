import type { EventOf, GnomiEvent } from '@gnomi/simulation/types.ts';

export type MomentView = 'all' | 'friction' | 'social';
export interface SwarmMoment {
  seq: number;
  persona: string;
  target: string | null;
  poi: string | null;
  label: string;
  text: string;
  detail?: string;
  tone: 'thought' | 'friction' | 'social' | 'success';
}

/** Only recorded moments in the displayed round. Earlier posts resolve authors, never leak future activity. */
export function roundMoments(events: GnomiEvent[], round: number, throughSeq: number): SwarmMoment[] {
  const posts = new Map<string, EventOf<'social.post'>>();
  const moments: SwarmMoment[] = [];
  for (const event of events) {
    if (event.seq > throughSeq || event.round > round) continue;
    if (event.type === 'social.post') posts.set(event.payload.post_id, event);
    if (event.round !== round || !event.persona_id) continue;
    const base = { seq: event.seq, persona: event.persona_id, target: null, poi: event.poi_id };
    switch (event.type) {
      case 'persona.step':
        if (event.payload.thought.trim()) moments.push({ ...base, label: 'Thought', text: event.payload.thought, tone: 'thought' });
        break;
      case 'persona.friction_reported':
        moments.push({ ...base, label: 'Friction', text: event.payload.what, detail: `Severity ${event.payload.severity} of 4`, tone: 'friction' });
        break;
      case 'social.post':
      case 'social.reaction': {
        const isPost = event.type === 'social.post';
        const parent = posts.get(isPost ? event.payload.parent_id ?? '' : event.payload.post_id);
        const target = parent?.persona_id && parent.persona_id !== event.persona_id ? parent.persona_id : null;
        moments.push({ ...base, target, poi: isPost ? event.payload.about_poi_id ?? parent?.payload.about_poi_id ?? null : parent?.payload.about_poi_id ?? null,
          label: isPost ? event.payload.injected ? 'Seeded post' : event.payload.parent_id ? 'Reply' : 'Post' : event.payload.kind === 'agree' ? 'Agreed' : 'Disagreed',
          text: isPost ? event.payload.text : parent?.payload.text ?? 'Reacted to a post that is unavailable in this log.',
          detail: parent?.payload.injected ? 'In response to a seeded post' : undefined, tone: 'social' });
        break;
      }
      case 'persona.opinion_changed':
        moments.push({ ...base, poi: event.payload.poi_id, label: event.payload.before ? 'Opinion changed' : 'Opinion formed',
          text: [...event.payload.after.frictions, ...event.payload.after.likes].join(' · ') || `Sentiment ${event.payload.after.sentiment > 0 ? '+' : ''}${event.payload.after.sentiment} of −2 to +2`,
          tone: event.payload.cause.post_ids.length ? 'social' : 'thought' });
        break;
      case 'persona.goal_done':
        moments.push({ ...base, label: 'Goal reached', text: event.payload.summary, tone: 'success' });
        break;
      case 'persona.abandoned':
        moments.push({ ...base, label: 'Stopped trying', text: event.payload.reason, tone: 'friction' });
        break;
      case 'persona.blocked':
        moments.push({ ...base, label: 'Blocked', text: event.payload.detail, tone: 'friction' });
        break;
    }
  }
  return moments;
}

/** One recent moment per person keeps a busy speaker from filling the map. */
export function selectMoments(moments: SwarmMoment[], view: MomentView, focus: string | null, limit = 6): SwarmMoment[] {
  const selected: SwarmMoment[] = [];
  const seen = new Set<string>();
  for (let i = moments.length - 1; i >= 0 && selected.length < limit; i--) {
    const moment = moments[i];
    if (view !== 'all' && moment.tone !== view) continue;
    if (focus && ![`persona:${moment.persona}`, moment.target && `persona:${moment.target}`, moment.poi && `poi:${moment.poi}`].includes(focus)) continue;
    if (seen.has(moment.persona)) continue;
    seen.add(moment.persona);
    selected.push(moment);
  }
  return selected;
}
