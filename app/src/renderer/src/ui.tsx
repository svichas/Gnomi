import { cloneElement, createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { call, errorText } from './engine.ts';
import { Icon } from './Icon.tsx';
import { credentialProblem } from './credentials.ts';
import type { SettingsSection } from './credentials.ts';

export const inputClass = 'field-input w-full';
const buttonBase = 'button disabled:cursor-not-allowed disabled:opacity-50';
export const primaryButton = `${buttonBase} button-primary`;
export const secondaryButton = `${buttonBase} button-secondary`;
const VARIANTS = { primary: primaryButton, secondary: secondaryButton, quiet: 'quiet-button', link: 'text-link' };

/** The app's button: one of the house looks, and a spinner while the work it started runs (it cannot be pressed again meanwhile). */
export function Button({ variant = 'secondary', small, loading, disabled, className, children, ...rest }: ComponentProps<'button'> & { variant?: keyof typeof VARIANTS; small?: boolean; loading?: boolean }) {
  return (
    <button type="button" {...rest} disabled={disabled || loading} aria-busy={loading || undefined} className={[VARIANTS[variant], small && 'button-small', className].filter(Boolean).join(' ')}>
      {loading && <span className="button-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Card({ title, children, description, id, className }: { title: string; children: ReactNode; description?: string; id?: string; className?: string }) {
  return (
    <section id={id} tabIndex={id ? -1 : undefined} className={['content-panel', className].filter(Boolean).join(' ')}>
      <h2>{title}</h2>{description && <p className="panel-description">{description}</p>}
      {children}
    </section>
  );
}

/** A labelled control. The label is tied to it by id rather than wrapped around it, so its text stays "Goal" however much the control holds. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactElement<{ id?: string; 'aria-describedby'?: string }> }) {
  const id = useId();
  return (
    <div className="field-control">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-stone-700">
        {label}
      </label>
      {cloneElement(children, { id, ...(hint && { 'aria-describedby': `${id}-hint` }) })}
      {hint && <p id={`${id}-hint`} className="mt-1 text-xs text-stone-500">{hint}</p>}
    </div>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange(checked: boolean): void; children: ReactNode }) {
  return (
    <label className="flex items-start gap-2 text-sm text-stone-800">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-indigo-600" />
      <span>{children}</span>
    </label>
  );
}

/** A number field that can be half-typed: it hands the parent only whole, valid numbers and shows the last good one again on blur. */
export function NumberInput(props: { value: number; onChange(value: number): void; min?: number; max?: number; step?: number; label: string; id?: string; 'aria-describedby'?: string }) {
  const { value, onChange, min, max, step, label, id } = props;
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  return (
    <input
      type="number"
      id={id}
      aria-label={label}
      aria-describedby={props['aria-describedby']}
      value={text}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(Number(e.target.value))) onChange(Number(e.target.value));
      }}
      onBlur={() => setText(String(value))}
      className={inputClass}
    />
  );
}

/**
 * A step's actions, floating at the foot of the window. It is rendered where the buttons were, so the focus order is unchanged,
 * and the page is padded by its measured height (styles.css) so it never covers the last fields.
 * An error goes in `notice`, above the bar in the page, where it has room for its explanation; it scrolls into view when it appears.
 */
export function ActionBar({ notice, children }: { notice?: ReactNode; children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => { noticeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [!!notice]);
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const watcher = new ResizeObserver(() => {
      // A bar on a hidden tab measures 0; only the one showing sets the space.
      if (element.offsetHeight) document.documentElement.style.setProperty('--action-bar-height', `${element.offsetHeight}px`);
    });
    watcher.observe(element);
    return () => watcher.disconnect();
  }, []);
  return <>
    {notice && <div ref={noticeRef} className="action-bar-notice">{notice}</div>}
    <div ref={bar} className="action-bar">{children}</div>
  </>;
}

/** A screenshot, fetched only once it scrolls into view: a report or a timeline can hold hundreds. */
export function Screenshot({ path, alt }: { path: string; alt: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let current = true;
    const watcher = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        watcher.disconnect();
        call('get_blob', { path }).then(
          ({ mime, base64 }) => current && setSrc(`data:${mime};base64,${base64}`),
          () => current && setFailed(true),
        );
      },
      { rootMargin: '300px' },
    );
    watcher.observe(element);
    return () => {
      current = false;
      watcher.disconnect();
    };
  }, [path]);
  return (
    <div ref={box} className="min-h-12">
      {src ? <img src={src} alt={alt} className="w-full rounded-lg border border-stone-200" /> : <p className="text-sm text-stone-500">{failed ? 'The screenshot could not be loaded.' : 'Loading screenshot...'}</p>}
    </div>
  );
}

export const usd = (amount: number) => `$${amount.toFixed(amount < 1 ? 4 : 2)}`;

export const when = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

const NOTE_ICONS = { ok: 'check', error: 'alert', info: 'alert' } as const;

/** Opens Settings at a card. Null where there is nowhere to go: in Settings itself and in an exported report. */
export const OpenSettings = createContext<((section: SettingsSection) => void) | null>(null);

/**
 * A short message; results of an action are announced to screen readers, a standing notice is not.
 * An error about a missing, rejected or exhausted key says what happened in plain words and links to its Settings card.
 */
export function Note({ tone, children }: { tone: keyof typeof NOTE_ICONS; children: ReactNode }) {
  const openSettings = useContext(OpenSettings);
  const role = { ok: 'status', error: 'alert', info: undefined }[tone];
  const problem = tone === 'error' && typeof children === 'string' ? credentialProblem(children) : null;
  return (
    <div role={role} className="note" data-tone={tone}>
      <span className="note-icon"><Icon name={problem ? (problem.section === 'figma' ? 'figma' : 'settings') : NOTE_ICONS[tone]} size={16} /></span>
      <div className="note-copy">
        {problem ? <>
          <p className="note-title">{problem.title}</p>
          {problem.hint ? <><p>{problem.hint}</p><p className="note-detail">{children}</p></> : <p>{children}</p>}
        </> : <p>{children}</p>}
      </div>
      {problem && openSettings && <Button small className="note-action" onClick={() => openSettings(problem.section)}>Open Settings<Icon name="arrow" size={14} /></Button>}
    </div>
  );
}

export interface Outcome {
  ok: boolean;
  text: string;
}

/** Runs one async action at a time, tracking whether it is in flight and the message it ended with. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  async function run(action: () => Promise<Outcome | null>) {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await action());
    } catch (err) {
      setOutcome({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }
  return { busy, outcome, run };
}

/** A small bar chart as a list: one row per value, the longest bar for the most common. */
export function Bars({ title, entries }: { title: string; entries: [label: string, count: number][] }) {
  const most = Math.max(1, ...entries.map(([, count]) => count));
  return (
    <figure>
      <figcaption className="mb-2 text-xs font-medium text-stone-700">{title}</figcaption>
      <ul className="space-y-1">
        {entries.map(([label, count]) => (
          <li key={label} className="grid grid-cols-[6.5rem_minmax(0,1fr)_2rem] items-center gap-2 text-xs">
            <span className="truncate text-stone-600">{label}</span>
            <span className="h-2 rounded bg-stone-100">
              <span className="block h-full rounded bg-indigo-500" style={{ width: `${(count / most) * 100}%` }} />
            </span>
            <span className="text-right text-stone-600">{count}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
