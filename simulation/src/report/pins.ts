import { boxIn } from '../browser/prune.ts';
import { pagePattern } from '../signals/index.ts';
import type { BlobStore, Recorder } from '../seams.ts';
import type { ActionTarget, EventOf, EventPayloads, GnomiEvent, ReportBox, ReportPicture, RunConfig, ScreenLead, Viewport } from '../types.ts';
import { boxOn, buildCandidates, groupCandidates, isWeak, placesOf, type Candidate } from './friction.ts';

// Pins across personas: once the episodes end, each web page's lead step per device and where the elements findings name sit on
// its screenshot, read from the stored snapshots. Recorded as report.screens, so the report stays a fold over the log alone.

export type Episodes = Map<string, EventPayloads['persona.episode_started']>;
export type Leads = Map<string, ScreenLead>;

export const viewer = (persona_id: string, poi_id: string) => `${persona_id}\u0000${poi_id}`;

/** Each persona's episode on each POI, by `viewer`: its device and any simulated perception. */
export const episodesOf = (events: GnomiEvent[]): Episodes =>
  new Map(events.flatMap((e) => (e.type === 'persona.episode_started' && e.persona_id ? [[viewer(e.persona_id, e.payload.poi_id), e.payload] as const] : [])));

const screenKey = (poi_id: string, page: string, device: string | undefined) => JSON.stringify([poi_id, page, device]);
// A snapshot line keeps a name's escapes and a step's target has them undone (browser/prune.ts), so both are compared without them.
const unescaped = (element: string) => element.replace(/\\(.)/g, '$1');
const LINE = /^\s*- (\S+) "((?:[^"\\]|\\.)*)"/;
const REF = /\[ref=([^\]]+)\]/;

/** Where each of `elements` (role "name") shows on the screenshot `viewport` spans: none for one missing, on two lines of the snapshot, off screen or in a frame. */
export function boxesOn(snapshot: string, elements: Iterable<string>, viewport: Viewport): ReportBox[] {
  const lines = new Map<string, { ref: string | null; target: ActionTarget }[]>();
  for (const line of snapshot.split('\n')) {
    const [, role, name] = LINE.exec(line) ?? [];
    if (!role) continue;
    const key = unescaped(`${role} "${name.trim()}"`);
    lines.set(key, [...(lines.get(key) ?? []), { ref: REF.exec(line)?.[1] ?? null, target: { role, name, box: boxIn(line) } }]);
  }
  return [...elements].flatMap((element) => {
    const [only, ...more] = lines.get(unescaped(element)) ?? [];
    const box = only && more.length === 0 ? boxOn(only.target, only.ref, viewport) : undefined; // two "Sign up" lines: either could be it
    return box ? [{ ...box, element }] : [];
  });
}

/**
 * Per web page and device, the step whose snapshot shows the most of the elements its findings name, with their boxes: one by a
 * persona without simulated perception first, as its screenshot is the page as it is, then the earliest. `read` gives a snapshot's text by hash.
 */
export async function screenLeads(events: GnomiEvent[], defaultPoi: string, read: (hash: string) => Promise<string | null>): Promise<ScreenLead[]> {
  const named = new Map<string, Set<string>>(); // POI and page → the elements findings name there
  for (const group of groupCandidates(buildCandidates(events, defaultPoi))) {
    if (!group.page || isWeak(group)) continue; // a weak group never becomes a finding
    const key = JSON.stringify([group.poi_id, group.page]);
    for (const m of group.members) if (m.element) named.set(key, (named.get(key) ?? new Set()).add(m.element));
  }
  const places = placesOf(events);
  const episodes = episodesOf(events);
  const texts = new Map<string, string | null>();
  const best = new Map<string, { plain: boolean; lead: ScreenLead }>();
  for (const e of events) {
    // Texts and designs record no viewport, and older logs none at all.
    if (e.type !== 'persona.step' || !e.persona_id || !e.payload.viewport || !e.payload.screenshot) continue;
    const poi_id = e.poi_id ?? defaultPoi;
    const page = pagePattern(e.payload.result.url_before, places); // its screenshot is taken before its action
    const elements = named.get(JSON.stringify([poi_id, page]));
    const episode = episodes.get(viewer(e.persona_id, poi_id));
    if (!elements || !episode) continue;
    const hash = e.payload.snapshot_hash;
    if (!texts.has(hash)) texts.set(hash, await read(hash)); // one at a time: a run can have thousands
    const boxes = boxesOn(texts.get(hash) ?? '', elements, e.payload.viewport);
    const key = screenKey(poi_id, page, episode.device);
    const held = best.get(key);
    const plain = !episode.perception;
    if (boxes.length === 0 || (held && (Number(held.plain) - Number(plain) || held.lead.boxes.length - boxes.length) >= 0)) continue;
    best.set(key, { plain, lead: { poi_id, page, device: episode.device, persona_id: e.persona_id, step_seq: e.seq, screenshot: e.payload.screenshot, boxes } });
  }
  return [...best.values()].map(({ lead }) => lead);
}

/** Records report.screens once the episodes are over, before the judge and whatever stopped the run; a snapshot that is gone shows nothing. */
export async function recordScreens({ config, round, blobs, record, events }: { config: RunConfig; round: number; blobs: BlobStore; record: Recorder; events: GnomiEvent[] }): Promise<void> {
  const { run_id } = config;
  const read = (hash: string) => blobs.get(`runs/${run_id}/snapshots/${hash}.txt`).then((data) => new TextDecoder().decode(data), () => null);
  const screens = await screenLeads(events, config.project.pois[0]?.id ?? '', read);
  if (screens.length > 0) record({ run_id, round, persona_id: null, poi_id: null, type: 'report.screens', payload: { screens } });
}

/** The newest report.screens of a log, by POI, page and device. */
export function leadsOf(events: GnomiEvent[]): Leads {
  const recorded = events.findLast((e): e is EventOf<'report.screens'> => e.type === 'report.screens');
  return new Map((recorded?.payload.screens ?? []).map((lead) => [screenKey(lead.poi_id, lead.page, lead.device), lead]));
}

/** A member's element marked on the lead screenshot of its page for its persona's device; none when it does not show there. */
export function pinOf(m: Pick<Candidate, 'poi_id' | 'persona_id' | 'page' | 'element'>, leads: Leads, episodes: Episodes): ReportPicture | undefined {
  const lead = m.page === null ? undefined : leads.get(screenKey(m.poi_id, m.page, episodes.get(viewer(m.persona_id, m.poi_id))?.device));
  const box = lead?.boxes.find((b) => b.element === m.element);
  return lead && box && { page: lead.page, screenshot: lead.screenshot, box, persona_id: lead.persona_id, step_seq: lead.step_seq };
}
