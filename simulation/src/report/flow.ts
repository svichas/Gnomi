import type { GnomiEvent, Outcome, ReportFlow, ReportFlowPage, ReportPersona, WebPoi } from '../types.ts';
import { pagePattern } from '../signals/index.ts';
import { placesOf } from './friction.ts';

/** Pages a flow shows: a real site can have many, so the most reached stay, ties going to where personas ended, and the rest are counted as left out. */
export const FLOW_PAGES = 8;

const endedOn = ({ ended }: ReportFlowPage) => Object.values(ended).reduce((sum, n) => sum + n, 0);

/**
 * Where the personas of each web POI went, with no new data: each persona's pages in order, from the URLs its steps start
 * and end on, so a redirect that lands between two steps is a move too. Each persona counts once per page and once per direction.
 */
export function buildFlow(events: GnomiEvent[], pois: WebPoi[], personas: ReportPersona[], defaultPoi: string): ReportFlow[] {
  const places = placesOf(events);
  return pois.flatMap((poi) => {
    const paths = new Map<string, string[]>(); // persona → its pages in order, a stay on one page counted once
    for (const e of events) {
      if (e.type !== 'persona.step' || !e.persona_id || (e.poi_id ?? defaultPoi) !== poi.id) continue;
      const path = paths.get(e.persona_id) ?? paths.set(e.persona_id, []).get(e.persona_id)!;
      for (const url of [e.payload.result.url_before, e.payload.result.url_after]) {
        const page = pagePattern(url, places);
        if (path.at(-1) !== page) path.push(page);
      }
    }
    if (paths.size === 0) return [];

    const pages = new Map<string, ReportFlowPage>();
    const pageOf = (page: string) => pages.get(page) ?? pages.set(page, { page, reached: 0, ended: {} }).get(page)!;
    const moves = new Map<string, number>();
    for (const [id, path] of paths) {
      for (const page of new Set(path)) pageOf(page).reached += 1;
      for (const move of new Set(path.slice(1).map((to, i) => JSON.stringify([path[i], to])))) moves.set(move, (moves.get(move) ?? 0) + 1);
      const persona = personas.find((p) => p.id === id);
      const outcome: Outcome = persona?.pois?.[poi.id] ?? persona?.outcome ?? 'incomplete';
      const { ended } = pageOf(path.at(-1)!);
      ended[outcome] = (ended[outcome] ?? 0) + 1;
    }

    const byReach = (a: ReportFlowPage, b: ReportFlowPage) => b.reached - a.reached;
    const onShow = new Set([...pages.values()].sort((a, b) => byReach(a, b) || endedOn(b) - endedOn(a)).slice(0, FLOW_PAGES).map(({ page }) => page));
    const ranked = [...pages.values()].sort(byReach); // a stable sort: ties stay in the order they were first reached, so a path reads from its start
    const shown = ranked.filter(({ page }) => onShow.has(page));
    const left = ranked.filter(({ page }) => !onShow.has(page));
    return [{
      poi_id: poi.id,
      personas: paths.size,
      pages: shown,
      moves: [...moves]
        .map(([move, count]) => {
          const [from, to] = JSON.parse(move) as [string, string];
          return { from, to, personas: count };
        })
        .filter(({ from, to }) => onShow.has(from) && onShow.has(to))
        .sort((a, b) => b.personas - a.personas),
      left_out: { pages: left.length, ended: left.reduce((sum, page) => sum + endedOn(page), 0) },
    }];
  });
}
