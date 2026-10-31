// One line per event for a terminal timeline: what happened, in words, after the event's type.
import type { GnomiEvent } from '../types.ts';

export function describe(e: GnomiEvent): string {
  switch (e.type) {
    case 'run.started':
      return `${e.payload.config.run_id}: "${e.payload.config.project.goal}" on ${e.payload.config.project.pois.map((poi) => (poi.type === 'web' ? poi.start_url : poi.name)).join(', ')}`;
    case 'run.concurrency_changed':
      return `${e.payload.concurrency} at once: ${e.payload.reason}`;
    case 'run.reset_called':
      return `${e.payload.url} → ${e.payload.status ?? e.payload.error}`;
    case 'persona.created':
      return `${e.payload.persona.name}, ${e.payload.persona.job_title}`;
    case 'persona.episode_started':
      return `${e.payload.start_url} (${e.payload.device})`;
    case 'llm.call': {
      const p = e.payload;
      const cache = p.cache_read_tokens || p.cache_write_tokens ? ` (+${p.cache_read_tokens} cache read, +${p.cache_write_tokens} cache write)` : '';
      return `${p.provider}/${p.model} ${p.status}: ${p.input_tokens} in${cache}, ${p.output_tokens} out, $${p.cost_usd.toFixed(5)}, ${p.latency_ms} ms${p.error ? `: ${p.error.slice(0, 200)}` : ''}`;
    }
    case 'persona.step': {
      const { step_no, action, target, result, feeling, thought } = e.payload;
      const on = target ? ` ${target.role} "${target.name}"` : action.ref ? ` ${action.ref}` : '';
      const text = action.text ? ` "${action.text}"` : '';
      const outcome = !result.ok ? `failed: ${result.error}` : result.url_after !== result.url_before ? `→ ${result.url_after}` : 'ok';
      return `${step_no}. ${action.type}${on}${text} ${outcome} | feeling ${feeling} | "${thought}"`;
    }
    case 'persona.friction_reported':
      return `step ${e.payload.step_no}, severity ${e.payload.severity}: ${e.payload.what} (expected: ${e.payload.expected})`;
    case 'persona.opinion_changed':
      return `${e.payload.poi_id}: sentiment ${e.payload.after.sentiment}, self-reported confidence ${Math.round(e.payload.after.confidence * 100)}%`;
    case 'persona.goal_done':
      return `step ${e.payload.step_no}: ${e.payload.summary}`;
    case 'persona.abandoned':
      return `step ${e.payload.step_no}: ${e.payload.reason}`;
    case 'signal.budget_exceeded':
      return `all ${e.payload.budget} steps used`;
    case 'persona.blocked':
      return `step ${e.payload.step_no}, ${e.payload.reason}: ${e.payload.detail}`;
    case 'persona.resumed':
      return `step ${e.payload.step_no}`;
    case 'containment.blocked_request':
      return `${e.payload.method} ${e.payload.url}`;
    case 'containment.tripwire':
      return `${e.payload.kind}: ${e.payload.detail}`;
    case 'signal.repeated_failure':
      return `step ${e.payload.step_no}: the same ${e.payload.action} failed three times in a row (${e.payload.error})`;
    case 'signal.failed_action':
      return `step ${e.payload.step_no}: ${e.payload.action} failed (${e.payload.error})`;
    case 'signal.loop':
      return `step ${e.payload.step_no}: ${e.payload.url} seen ${e.payload.visits} times`;
    case 'signal.backtrack':
      return `step ${e.payload.step_no}: ${e.payload.kind} on ${e.payload.url}`;
    case 'signal.error':
      return `step ${e.payload.step_no}: ${e.payload.kind}${e.payload.status ? ` ${e.payload.status}` : ''} ${e.payload.message}`;
    case 'signal.validation_error':
      return `step ${e.payload.step_no}: "${e.payload.message}"`;
    case 'signal.small_target':
      return `step ${e.payload.step_no}: ${e.payload.box[2]}×${e.payload.box[3]} target`;
    case 'signal.accessibility':
      return `step ${e.payload.step_no}: ${e.payload.rule} (${e.payload.impact}) on ${e.payload.elements} element${e.payload.elements === 1 ? '' : 's'} of ${e.payload.url}`;
    case 'accessibility.scanned':
      return `step ${e.payload.step_no}: ${e.payload.url} ${e.payload.error ? `not scanned: ${e.payload.error}` : `scanned, ${e.payload.audit.length} moderate or minor`}`;
    case 'persona.survey':
      return `${e.payload.poi_id}: sentiment ${e.payload.sentiment}, ${e.payload.would_continue ? 'would' : 'would not'} continue: "${e.payload.reason}"`;
    case 'run.round_started':
    case 'run.round_ended':
      return `round ${e.round}`;
    case 'social.feed_viewed':
      return `${e.payload.post_ids.length} posts`;
    case 'social.post':
      return `${e.payload.parent_id ? `reply to ${e.payload.parent_id}` : 'post'} ${e.payload.post_id}${e.payload.injected ? ' (injected)' : ''}: "${e.payload.text}"`;
    case 'social.reaction':
      return `${e.payload.kind} ${e.payload.post_id}`;
    case 'social.discarded':
      return `answer of llm.call #${e.payload.call_seq} dropped by the stop`;
    case 'run.finished':
      return '';
    case 'run.stopped':
      return e.payload.detail ? `${e.payload.reason}: ${e.payload.detail}` : e.payload.reason;
    case 'report.started':
      return e.payload.pois.length ? `naming themes and writing suggestions for ${e.payload.pois.join(', ')}` : 'no frictions to name themes for';
    case 'report.themes':
      return `${e.payload.poi_id}: ${e.payload.themes.length} themes named by the judge`;
    case 'report.checks':
      return `${e.payload.poi_id}: ${e.payload.checks.length} themes reviewed by the evidence check`;
    case 'report.suggestions':
      return `${e.payload.poi_id}: ${e.payload.suggestions.length} suggested changes from the author`;
    case 'report.generated':
      return `${e.payload.path} (${e.payload.friction_count} frictions)`;
    case 'report.study':
      return `study plan for ${e.payload.themes.length} finding${e.payload.themes.length === 1 ? '' : 's'}`;
    case 'finding.validated':
      return `study outcome, ${e.payload.study_date}: ${e.payload.status} for "${e.payload.title}"`;
    case 'persona.interviewed':
      return `asked after the run: "${e.payload.question}"`;
    case 'finding.hidden':
      return `${e.payload.hidden ? 'hidden from exports' : 'back in exports'}: "${e.payload.title}"`;
    case 'finding.edited':
      return `${e.payload.new_title === null && e.payload.new_description === null ? 'wording back to the original' : 'reworded for exports'}: "${e.payload.title}"`;
    case 'comparison.episode_started':
      return `${e.payload.target_id}, ${e.payload.task_id}: position ${e.payload.order + 1}`;
    case 'comparison.episode_finished':
      return `${e.payload.target_id}, ${e.payload.task_id}: ${e.payload.outcome} — ${e.payload.reason}`;
    case 'comparison.source':
      return `${e.payload.target_id}: captured ${e.payload.source}`;
    case 'comparison.assessment':
      return `${e.payload.target_id}, ${e.payload.criterion_id}: ${e.payload.assessment}${e.payload.rejection ? ` (${e.payload.rejection})` : ''}`;
  }
}
