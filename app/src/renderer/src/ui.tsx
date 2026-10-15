import { cloneElement, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { call, errorText } from './engine.ts';

export const inputClass =
  'w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200';
const buttonBase =
  'rounded-lg px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50';
export const primaryButton = `${buttonBase} bg-indigo-600 text-white hover:bg-indigo-700`;
export const secondaryButton = `${buttonBase} border border-stone-300 bg-white text-stone-800 hover:bg-stone-100`;

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-base font-semibold text-stone-900">{title}</h2>
      {children}
    </section>
  );
}

/** A labelled control. The label is tied to it by id rather than wrapped around it, so its text stays "Goal" however much the control holds. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-stone-700">
        {label}
      </label>
      {cloneElement(children, { id })}
      {hint && <p className="mt-1 text-xs text-stone-500">{hint}</p>}
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
export function NumberInput(props: { value: number; onChange(value: number): void; min?: number; max?: number; step?: number; label: string; id?: string }) {
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

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-2 w-full overflow-hidden rounded-full bg-stone-200">
      <div className="h-full rounded-full bg-indigo-600 transition-[width]" style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </div>
  );
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

const noteTone = {
  ok: 'border-green-200 bg-green-50 text-green-900',
  error: 'border-red-200 bg-red-50 text-red-900',
  info: 'border-amber-200 bg-amber-50 text-amber-900',
};

/** A short message; results of an action are announced to screen readers, a standing notice is not. */
export function Note({ tone, children }: { tone: keyof typeof noteTone; children: ReactNode }) {
  const role = { ok: 'status', error: 'alert', info: undefined }[tone];
  return (
    <p role={role} className={`rounded-lg border px-3 py-2 text-sm ${noteTone[tone]}`}>
      {children}
    </p>
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
