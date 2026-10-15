import type { SetupCall } from '@gnomi/engine/types.ts';
import { usd } from './ui.tsx';

const STAGES: Record<string, string> = { propose_audience: 'Audience', write_persona: 'Sketches', rename_persona: 'Names', expand_persona: 'Biography' };

/** Persisted diagnostics of the latest setup task, available after a failure and after restarting. */
export function GenerationDetails({ calls }: { calls: SetupCall[] }) {
  if (!calls.length) return null;
  const failed = calls.filter((c) => c.payload.status !== 'ok').length;
  const cost = calls.reduce((sum, c) => sum + c.payload.cost_usd, 0);
  const uncertain = calls.some((c) => c.payload.usage_reported === false);
  return <details className="disclosure">
    <summary>Generation details<span>{calls.length} model attempts · {failed} failed · {usd(cost)}{uncertain ? ' (usage incomplete)' : ''}</span></summary>
    <div className="disclosure-body">
      <p className="mb-3 text-sm text-stone-600">Latest setup task with model calls. Reusing saved drafts requires no new call. Output tokens include any thinking tokens; — means the provider did not report them.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead><tr>{['Persona / model', 'Stage', 'Time / queue', 'Input / output / thinking', 'Result'].map((label) => <th key={label} scope="col" className="p-2">{label}</th>)}</tr></thead>
          <tbody>{calls.map(({ id, persona_id, purpose, payload: p }) => <tr key={id} className="border-t border-stone-200">
            <td className="p-2">{persona_id ?? 'Audience'}<br />{p.model}</td>
            <td className="p-2">{STAGES[purpose] ?? purpose}</td>
            <td className="p-2">{(p.latency_ms / 1000).toFixed(1)}s / {((p.queue_ms ?? 0) / 1000).toFixed(1)}s</td>
            <td className="p-2">{p.input_tokens + p.cache_read_tokens + p.cache_write_tokens} / {p.output_tokens} / {p.reasoning_tokens ?? '—'}</td>
            <td className="max-w-64 break-words p-2">{p.status === 'ok' ? 'Complete' : p.error ?? p.status}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>
  </details>;
}
