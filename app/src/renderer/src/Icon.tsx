import type { CSSProperties } from 'react';

const paths = {
  search: 'M21 21l-5-5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z',
  up: 'M12 19V5m-6 6 6-6 6 6',
  down: 'M12 5v14m-6-6 6 6 6-6',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  image: 'M4 3h16v18H4V3Zm0 13 5-5 4 4 3-3 4 4M16 7h.01',
  figma: 'M12 9H8a3 3 0 0 1 0-6h8a3 3 0 0 1 0 6h-4Zm0-6v15a3 3 0 1 1-3-3H8a3 3 0 1 1 0-6m4 3a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  back: 'M19 12H5m6 6-6-6 6-6',
  chevron: 'm9 5 7 7-7 7',
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
  person: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM5 21a7 7 0 0 1 14 0',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM17 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87',
  activity: 'M4 5h16M4 12h11M4 19h14',
  message: 'M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0ZM7 10h10M7 14h6',
  check: 'm5 12 4 4L19 6',
  alert: 'm12 3 10 18H2L12 3Zm0 6v5m0 3h.01',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-5v5l3 2',
  play: 'm8 4 12 8-12 8V4Z',
  close: 'm6 6 12 12M6 18 18 6',
  filter: 'M4 7h16M7 12h10M10 17h4',
  leaf: 'M20 4C8 2 2 8 6 15s16 2 14-11ZM4 21 15 10',
  report: 'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8M8 16h6',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16v4m-2-2h4',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z',
} as const;

export function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

/** A white glyph as an image, for WebGL graph nodes, which cannot draw the SVG element. */
export const iconImage = (name: keyof typeof paths) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name]}"/></svg>`)}`;

/** A stable, local identity for simulated people. Never relies on a remote avatar service. */
export function PersonaAvatar({ name, id }: { name: string; id: string }) {
  const color = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5 + 1;
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('');
  return <span className="persona-avatar" style={{ '--avatar-color': `var(--gnomi-segment-${color})` } as CSSProperties} aria-hidden="true">{initials || <Icon name="people" size={16} />}</span>;
}
