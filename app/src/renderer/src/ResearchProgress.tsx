import type { GnomiEvent, RunConfig } from '@gnomi/simulation/types.ts';
import { comparisonPlan } from '@gnomi/simulation/comparison/planning.ts';

/** Research follows company requirements; the audience roster is not a set of independent observations. */
export function ResearchProgress({ config, events }: { config: RunConfig; events: GnomiEvent[] }) {
  const study = config.project.comparison!;
  const plan = comparisonPlan(config);
  const finished = new Map(events.filter((event) => event.type === 'comparison.episode_finished').map((event) => [event.payload.episode_id, event.payload]));
  const started = new Set(events.filter((event) => event.type === 'comparison.episode_started').map((event) => event.payload.episode_id));
  const environment = study.execution.research_environment ?? { locale: 'en-US', timezone: 'UTC' };
  return <section aria-label="Public evidence research" className="content-panel space-y-3 p-4">
    <div>
      <h2 className="text-base font-semibold text-stone-900">Researching your shortlist</h2>
      <p className="mt-1 text-sm text-stone-600">Sources are reviewed once for each company scenario and shared across the comparison.</p>
      <p className="mt-1 text-xs text-stone-500">Research environment: {environment.locale} · {environment.timezone} · desktop</p>
    </div>
    <ul className="grid gap-3 sm:grid-cols-2">
      {study.targets.map((target) => {
        const episodes = plan.episodes.filter((episode) => episode.target_id === target.id && episode.eligible);
        const outcomes = episodes.flatMap((episode) => finished.get(episode.episode_id) ?? []);
        const active = episodes.some((episode) => started.has(episode.episode_id) && !finished.has(episode.episode_id));
        const limited = outcomes.filter((outcome) => outcome.outcome !== 'completed');
        return <li key={target.id} className="rounded-lg border border-stone-200 p-3">
          <h3 className="font-medium text-stone-900">{target.name}</h3>
          <p className="mt-1 text-sm text-stone-700">{active ? 'Reviewing sources · ' : ''}{outcomes.length} of {episodes.length} source reviews recorded</p>
          {limited.length > 0 && <p className="mt-1 text-xs text-amber-800">{limited.length} review{limited.length === 1 ? '' : 's'} with unresolved work. Exact causes appear in the report.</p>}
          {episodes.length === 0 && <p className="mt-1 text-xs text-stone-500">No source review is eligible under the configured access.</p>}
        </li>;
      })}
    </ul>
  </section>;
}
