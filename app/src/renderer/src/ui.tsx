import { useState } from 'react';
import type { ReactNode } from 'react';
import { errorText } from './engine.ts';

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

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-stone-700">{label}</span>
        {children}
      </label>
      {hint && <p className="mt-1 text-xs text-stone-500">{hint}</p>}
    </div>
  );
}

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
