import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';

// Tones are styled in styles.css; a tone always sits beside its label, never stands in for it (brand.md §5).
export type Tone = 'good' | 'warn' | 'high' | 'bad' | 'neutral';
type IconName = Parameters<typeof Icon>[0]['name'];

export type Inspect = (personaId: string, seq?: number) => void;

/** True while the report is drawn into an exported file, which has no inspector to open and prints every fold open. */
export const InFile = createContext(false);

export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
export const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`;
export const heading = 'text-base font-semibold text-stone-900';

export const Th = ({ children }: { children: ReactNode }) => (
  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-stone-500">
    {children}
  </th>
);

export function SectionHeading({ id, title, hint }: { id?: string; title: ReactNode; hint: string }) {
  return <div className="report-section-heading"><div><h3 id={id}>{title}</h3><p>{hint}</p></div></div>;
}

export function PersonaLink({ id, name, seq, onInspect }: { id: string; name: string; seq?: number; onInspect: Inspect }) {
  if (useContext(InFile)) return <span className="font-medium normal-case tracking-normal text-stone-900">{name}</span>;
  return (
    <button type="button" onClick={() => onInspect(id, seq)} className="text-left font-medium normal-case tracking-normal text-indigo-700 underline decoration-indigo-300 hover:text-indigo-900">
      {name}
    </button>
  );
}

/** A section that starts closed in the app: secondary detail stays one click away. */
export function Fold({ id, title, hint, icon = 'report', children }: { id: string; title: string; hint: string; icon?: IconName; children: ReactNode }) {
  const inFile = useContext(InFile);
  return (
    <section aria-labelledby={id}>
      <details className="report-fold" open={inFile}>
        <summary>
          <span className="report-fold-icon"><Icon name={icon} size={18} /></span>
          <div className="report-fold-copy"><h3 id={id}>{title}</h3><span>{hint}</span></div>
          <Icon name="chevron" size={16} />
        </summary>
        <div className="report-fold-body">{children}</div>
      </details>
    </section>
  );
}

export function Tile({ label, value, detail, icon, tone }: { label: string; value: string; detail?: string; icon: IconName; tone: Tone }) {
  return (
    <div className="report-stat">
      <span className="report-stat-icon" data-tone={tone}><Icon name={icon} size={18} /></span>
      <div><p className="report-stat-label">{label}</p><p className="report-stat-value">{value}</p>{detail && <p className="report-stat-detail">{detail}</p>}</div>
    </div>
  );
}
