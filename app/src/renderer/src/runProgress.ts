import type { GnomiEvent, RunConfig, RunStatus } from '@gnomi/simulation/types.ts';
import { admits, inScenario } from '@gnomi/simulation/comparison/config.ts';
import { poisFor, withPois } from '@gnomi/simulation/poi/pois.ts';
import { socialRounds } from '@gnomi/simulation/settings.ts';
import { runSetup } from './activity.ts';

export type RunPhase = 'starting' | 'exploring' | 'discussing' | 'reporting' | 'saving' | 'complete' | 'stopped' | 'interrupted';

export interface RunProgressStage {
  id: 'exploration' | 'discussion' | 'report';
  label: string;
  state: 'pending' | 'active' | 'complete' | 'stopped';
  detail: string;
}

export interface RunProgress {
  /** Completed work milestones, never an elapsed-time estimate. Only a successful run with an available report reaches 100. */
  percent: number;
  phase: RunPhase;
  label: string;
  detail: string;
  ended: boolean;
  complete: boolean;
  reportReady: boolean;
  sessions: { done: number; total: number };
  /** total is the configured maximum. The engine may finish discussion before using every round. */
  rounds: { done: number; total: number; current: number };
  stages: RunProgressStage[];
}

const EPISODE_ENDS = new Set(['persona.goal_done', 'persona.abandoned', 'signal.budget_exceeded', 'signal.repeated_failure', 'persona.survey']);
const sessionKey = (persona: string, poi: string) => JSON.stringify([persona, poi]);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Replay progress from durable events, including historical runs and incomplete runs recovered after a restart.
 * A session is one person's experience of one eligible point of interest. A finished session can still be followed
 * by surveys or discussion, so only report.started (or a successful terminal status) closes the research phases.
 * The three report milestones are starting analysis, completing analysis and making the report available. Recorded
 * themes and suggestions advance the analysis milestone; failures settle it only when the engine finishes.
 */
export function runProgress(events: GnomiEvent[], config?: RunConfig, status?: RunStatus, reportAvailable = false): RunProgress {
  const frozen = events.find((event) => event.type === 'run.started')?.payload.config ?? config;
  const setup = runSetup(frozen);
  const pois = frozen?.project ? withPois(frozen.project).pois : [];
  const comparison = frozen?.project.comparison;
  const taskKey = (persona: string, task: string, target: string) => JSON.stringify([persona, task, target]);
  const planned = new Set<string>();
  const assigned = new Map<string, string[]>();
  for (const persona of setup.personas) {
    if (comparison) {
      for (const task of comparison.tasks) {
        if (!inScenario(comparison, task.scenario_id, persona.segment_id)) continue;
        for (const entry of task.entries) {
          const poi = pois.find((item) => item.id === entry.poi_id);
          if (!poi || !admits(poi, persona.segment_id)) continue;
          planned.add(taskKey(persona.id, task.id, entry.target_id));
        }
      }
      continue;
    }
    const segment = setup.segments.find((candidate) => candidate.id === persona.segment_id) ?? null;
    const ids = poisFor(pois, segment).map((poi) => poi.id);
    // Early logs have no POI envelope. They still contain one experience per persona.
    if (!ids.length && !pois.length) ids.push('legacy');
    assigned.set(persona.id, ids);
    for (const id of ids) planned.add(sessionKey(persona.id, id));
  }

  const concluded = new Set<string>();
  const currentPoi = new Map<string, string>();
  const roundsStarted = new Set<number>();
  const roundsEnded = new Set<number>();
  const themed = new Set<string>();
  const suggested = new Set<string>();
  let reportPois: string[] | null = null;
  let generated = false;
  let finished = false;
  let stopped = false;
  let beganExploring = false;
  let socialRound = 0;

  for (const event of events) {
    if (event.type === 'run.finished') finished = true;
    else if (event.type === 'run.stopped') stopped = true;
    else if (event.type === 'report.generated') generated = true;
    else if (event.type === 'report.started') reportPois = [...new Set(event.payload.pois)];
    else if (event.type === 'report.themes') themed.add(event.payload.poi_id);
    else if (event.type === 'report.suggestions') {
      // Suggestions also prove that the judge step settled, even if it failed and used deterministic themes.
      themed.add(event.payload.poi_id);
      suggested.add(event.payload.poi_id);
    } else if (event.type === 'run.round_started') roundsStarted.add(event.round);
    else if (event.type === 'run.round_ended') roundsEnded.add(event.round);
    else if (event.type.startsWith('social.')) socialRound = Math.max(socialRound, event.round);

    if (!event.persona_id) continue;
    const id = event.persona_id;
    if (comparison) {
      if (event.type === 'comparison.episode_started' || event.type === 'comparison.assessment') beganExploring = true;
      if (event.type === 'comparison.episode_finished') {
        const key = taskKey(id, event.payload.task_id, event.payload.target_id);
        if (planned.has(key)) concluded.add(key);
      }
      continue;
    }
    if (event.type === 'persona.episode_started') {
      beganExploring = true;
      currentPoi.set(id, event.payload.poi_id);
      if (!frozen) planned.add(sessionKey(id, event.payload.poi_id));
    } else if (event.type === 'persona.step') beganExploring = true;
    if (!EPISODE_ENDS.has(event.type)) continue;
    beganExploring = true;
    const poi = event.type === 'persona.survey' ? event.payload.poi_id : event.poi_id ?? currentPoi.get(id) ?? (assigned.get(id)?.length === 1 ? assigned.get(id)![0] : null);
    if (!poi) continue;
    const key = sessionKey(id, poi);
    if (planned.has(key)) concluded.add(key);
  }

  const interrupted = status === 'interrupted';
  stopped ||= status === 'stopped';
  const successful = !interrupted && !stopped && (finished || status === 'finished');
  const ended = interrupted || stopped || successful;
  const reportReady = ended && (generated || reportAvailable);
  const complete = successful && reportReady;
  const researchDone = reportPois !== null || successful;
  const sessions = { done: researchDone && !comparison ? planned.size : concluded.size, total: planned.size };
  const configuredRounds = !comparison && frozen?.project.settings ? socialRounds(frozen.project.settings, frozen.project.audience) : 0;
  const currentRound = Math.max(0, ...roundsStarted, ...roundsEnded);
  const rounds = { done: roundsEnded.size, total: Math.max(configuredRounds, currentRound), current: currentRound };
  const hasDiscussion = rounds.total > 0;

  // Once research ends, unused optional rounds leave the plan. They never appear as completed rounds.
  const roundsPlanned = researchDone ? rounds.done : rounds.total;
  const analyses = reportPois?.length ? reportPois.reduce((sum, poi) => sum + Number(themed.has(poi)) + Number(suggested.has(poi)), 0) / (reportPois.length * 2) : 0;
  const reportWork = successful ? 2 : reportPois !== null ? 1 + analyses : 0;
  const milestones = sessions.total + roundsPlanned + 3;
  const settled = sessions.done + rounds.done + reportWork + Number(reportReady);
  const percent = complete ? 100 : Math.min(99, Math.floor(100 * settled / milestones));

  let phase: RunPhase;
  if (interrupted) phase = 'interrupted';
  else if (stopped) phase = 'stopped';
  else if (complete) phase = 'complete';
  else if (successful) phase = 'saving';
  else if (reportPois !== null) phase = 'reporting';
  else if (currentRound > 0 && socialRound === currentRound) phase = 'discussing';
  else if (beganExploring || currentRound > 0) phase = 'exploring';
  else phase = 'starting';

  const sessionDetail = `${sessions.done} of ${sessions.total} ${comparison ? 'tool/task outcomes recorded' : 'sessions concluded'}`;
  const roundDetail = researchDone ? `${plural(rounds.done, 'round')} concluded` : `Round ${rounds.current || 1} of up to ${rounds.total}`;
  const reportDetail = reportReady ? successful ? 'Report ready to explore' : 'Partial report ready' : successful ? 'Saving the final report' : reportPois !== null ? reportPois.length === 0 ? 'Preparing the final report' : reportPois.every((poi) => themed.has(poi)) ? 'Writing suggested improvements' : 'Grouping feedback into findings' : 'Available after the simulation';
  const labels: Record<RunPhase, string> = {
    starting: 'Getting your audience ready',
    exploring: 'Your audience is exploring',
    discussing: 'Your audience is exchanging perspectives',
    reporting: 'Turning experiences into findings',
    saving: 'Saving your report',
    complete: 'Your simulation is complete',
    stopped: 'Simulation stopped',
    interrupted: 'Simulation interrupted',
  };
  const details: Record<RunPhase, string> = {
    starting: comparison ? `${plural(setup.personas.length, 'person')} will compare ${plural(comparison.targets.length, 'tool')} using ${plural(comparison.tasks.length, 'shared task')}.` : `${plural(setup.personas.length, 'person')} will explore ${plural(pois.length, 'point of interest')}.`,
    exploring: comparison ? `${sessionDetail}. Evidence is assessed after each task.` : sessions.done === sessions.total && sessions.total > 0 ? 'Collecting final feedback from your audience.' : sessionDetail,
    discussing: `${roundDetail} · People are sharing and responding to their experiences.`,
    reporting: reportDetail,
    saving: 'The simulation has finished. Your report will appear when it is ready.',
    complete: 'Explore the findings, or revisit how each experience unfolded.',
    stopped: reportReady ? `${sessionDetail}. The report covers the work completed before the stop.` : `${sessionDetail}. Preparing a report of the completed work.`,
    interrupted: `${sessionDetail}. This run ended before the planned work was complete.`,
  };

  const stages: RunProgressStage[] = [{
    id: 'exploration', label: comparison ? 'Compare tools' : 'Explore', detail: sessionDetail,
    state: researchDone ? 'complete' : ended ? 'stopped' : beganExploring || currentRound > 0 ? 'active' : 'pending',
  }];
  if (hasDiscussion) stages.push({
    id: 'discussion', label: 'Exchange views', detail: roundDetail,
    state: researchDone ? 'complete' : ended ? 'stopped' : currentRound > 0 ? 'active' : 'pending',
  });
  stages.push({
    id: 'report', label: 'Build report', detail: reportDetail,
    state: reportReady ? 'complete' : interrupted ? 'stopped' : reportPois !== null || ended ? 'active' : 'pending',
  });
  return { percent, phase, label: labels[phase], detail: details[phase], ended, complete, reportReady, sessions, rounds, stages };
}
