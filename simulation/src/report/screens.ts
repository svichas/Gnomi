import type { ReportBox, ReportPicture, ReportReach, ReportTheme } from '../types.ts';

// Findings by screen: the same themes regrouped by the page they are on, for the app and the exports alike. Pure.

/** A theme on this many pages or more is site-wide: one group, not a copy on every screen. */
export const ACROSS_SCREENS = 4;

export interface ScreenFinding {
  theme: ReportTheme;
  number: number; // 1-based within its screen, in the order given
  picture?: ReportPicture; // its picture on this page; in the across group its first picture
  pinned: boolean; // its picture is the lead's file and has a box
}

export interface Screen {
  poi_id: string;
  kind: 'page' | 'across' | 'none';
  page: string | null; // null for across and none
  reached: number | null; // personas who reached the page, from reach; null when unknown
  picture: ReportPicture | null; // the lead
  pins: { box: ReportBox; numbers: number[] }[]; // on the lead: one per distinct box, numbers ascending
  findings: ScreenFinding[];
}

/**
 * A page as people read it: a web page (its host, then its path) by its path; a text or design screen by its whole name, as a
 * Figma frame's name often holds a slash ("Desktop / Payment").
 */
export const screenName = (page: string) => (/^[\w.-]+(:\d+)?\//.test(page) ? page.slice(page.indexOf('/')) : page);

const sameBox = (a: ReportBox, b: ReportBox) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

function screen(poi_id: string, kind: Screen['kind'], page: string | null, themes: ReportTheme[], reached: number | null): Screen {
  const pictureOf = (t: ReportTheme) => (kind === 'page' ? t.pictures?.find((p) => p.page === page) : t.pictures?.[0]);
  const lead = kind === 'page' ? (themes.map(pictureOf).find((p) => p !== undefined) ?? null) : null;
  const findings = themes.map((theme, i): ScreenFinding => {
    const picture = pictureOf(theme);
    return { theme, number: i + 1, ...(picture && { picture }), pinned: !!picture?.box && picture.screenshot === lead?.screenshot };
  });
  const pins: Screen['pins'] = [];
  for (const { picture, number, pinned } of findings) {
    if (!pinned) continue;
    const pin = pins.find((p) => sameBox(p.box, picture!.box!));
    if (pin) pin.numbers.push(number);
    else pins.push({ box: picture!.box!, numbers: [number] });
  }
  return { poi_id, kind, page, reached, picture: lead, pins, findings };
}

/**
 * The themes by screen, each screen keeping the order the caller lists them in. Per POI, in order of first appearance: its pages, the
 * most reached first, ties in the order reach first saw them; then its site-wide themes; then those tied to no page.
 */
export function screensOf(themes: ReportTheme[], reach: ReportReach[] = []): Screen[] {
  return [...new Set(themes.map((t) => t.poi_id))].flatMap((poi_id) => {
    const own = themes.filter((t) => t.poi_id === poi_id);
    const across = own.filter((t) => t.pages.length >= ACROSS_SCREENS);
    const none = own.filter((t) => t.pages.length === 0);
    const reachedOn = new Map(Object.entries(reach.find((r) => r.poi_id === poi_id)?.pages ?? {}));
    const firstReached = [...reachedOn.keys()];
    const count = (page: string) => reachedOn.get(page)?.length ?? null;
    const known = (page: string) => reachedOn.has(page);
    // Pages reach does not name go last, in order of first appearance: the sort is stable.
    const pages = [...new Set(own.flatMap((t) => (t.pages.length < ACROSS_SCREENS ? t.pages : [])))].sort((a, b) =>
      Number(!known(a)) - Number(!known(b)) || (known(a) && known(b) ? count(b)! - count(a)! || firstReached.indexOf(a) - firstReached.indexOf(b) : 0),
    );
    return [
      ...pages.map((page) => screen(poi_id, 'page', page, own.filter((t) => t.pages.length < ACROSS_SCREENS && t.pages.includes(page)), count(page))),
      ...(across.length > 0 ? [screen(poi_id, 'across', null, across, null)] : []),
      ...(none.length > 0 ? [screen(poi_id, 'none', null, none, null)] : []),
    ];
  });
}
