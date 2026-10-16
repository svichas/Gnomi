import type { CSSProperties } from 'react';

const paths = {
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  back: 'M19 12H5m6 6-6-6 6-6',
  chevron: 'm9 5 7 7-7 7',
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
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
} as const;

export function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

/** A stable, local identity for simulated people. Never relies on a remote avatar service. */
export function PersonaAvatar({ name, id }: { name: string; id: string }) {
  const color = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5 + 1;
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('');
  return <span className="persona-avatar" style={{ '--avatar-color': `var(--gnomi-segment-${color})` } as CSSProperties} aria-hidden="true">{initials || <Icon name="people" size={16} />}</span>;
}
