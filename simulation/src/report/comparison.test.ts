import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftComparison } from '../comparison/config.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { ComparisonAssessment, ComparisonOutcome, ComparisonScope } from '../comparison/types.ts';
import type { EventPayloads, EventType, GnomiEvent, ProjectConfig, RunConfig } from '../types.ts';
import { buildComparison } from './comparison.ts';
import { buildReport } from './build.ts';
import { reportToMarkdown } from './markdown.ts';

test('comparison reports and Markdown disclose the frozen verifier model, including the legacy default', () => {
  for (const route of [undefined, 'judge', 'navigator'] as const) {
    const f = fixture();
    if (route) f.study.execution.verifier = route;
    f.episode(0, 0);
    const report = buildReport(f.events);
    const model = DEFAULT_SETTINGS.routing[route ?? 'judge'];
    const expected = `Configured semantic verifier: ${route ?? 'judge'} model (${model.provider}/${model.model})`;
    assert.ok(report.comparison!.limitations.some((line) => line.startsWith(expected)));
    assert.ok(reportToMarkdown(report).includes(expected));
    assert.deepEqual(buildReport(JSON.parse(JSON.stringify(f.events))).comparison, report.comparison);
  }
});

function fixture() {
  const project: ProjectConfig = { name: 'Tools', description: 'tools', goal: 'Choose ATS', role: null, audience: null, settings: DEFAULT_SETTINGS,
    pois: ['Alpha', 'Beta'].map((name, i) => ({ id: `poi-${i}`, name, type: 'web', mode: 'observe_only', segments: null, start_url: `https://v${i}.example/`, allowed_hosts: [], production_domains: [], reset_hook_url: null })) };
  const study = draftComparison(project);
  study.criteria = [study.criteria[0], study.criteria[1]];
  study.tasks[0].criterion_ids = study.criteria.map((c) => c.id);
  project.comparison = study;
  const personas = [0, 1].map((i) => ({ ...BUILTIN_PERSONA, id: `p-${i}` }));
  const config: RunConfig = { run_id: 'r-1', seed: 42, project, personas, sessions: [], reset: false, pause_timeout_ms: 100, app_version: 'test' };
  const events: GnomiEvent[] = [];
  function add<K extends EventType>(type: K, payload: EventPayloads[K], persona_id: string | null = null, poi_id: string | null = null): number {
    const seq = events.length + 1;
    events.push({ run_id: 'r-1', round: 1, persona_id, poi_id, type, payload, seq, ts: seq * 100 } as GnomiEvent);
    return seq;
  }
  add('run.started', { config });
  function episode(person: number, target: number, outcome: ComparisonOutcome = 'completed', fit: ComparisonAssessment = 'meets', price: ComparisonAssessment = 'unknown', taskIndex = 0) {
    const who = personas[person].id, poi = project.pois[target].id;
    const scope: ComparisonScope = { episode_id: `e-${taskIndex}-${person}-${target}`, replicate_id: 'replicate-1', target_id: study.targets[target].id, scenario_id: study.scenarios[0].id, task_id: study.tasks[taskIndex].id, segment_id: null, access_scope: 'public_site' };
    add('comparison.episode_started', { ...scope, poi_id: poi, order: target, target_order: study.targets.map((t) => t.id) }, who, poi);
    const step = add('persona.step', { step_no: 1, action: { type: 'done', ref: null, text: null }, target: null, result: { ok: true, url_before: `https://v${target}.example/`, url_after: `https://v${target}.example/`, dom_changed: false, error: null }, thought: 'Inspect the stated hiring workflow', feeling: 0, snapshot_hash: 'x', screenshot: null, duration_ms: 1, heard_post_ids: [] }, who, poi);
    const source = add('comparison.source', { ...scope, source_id: `source-${person}-${target}`, poi_id: poi, source: `https://v${target}.example/`, captured_at: 100, step_seq: step, step_no: 1, screenshot: null, text: 'Our product supports hiring teams. Contact sales for a quote.', kind: 'page' }, who, poi);
    for (const [criterion_id, assessment] of [['fit', fit], ['cost', price]] as const) add('comparison.assessment', { ...scope, criterion_id, assessment, basis: 'vendor_claim', summary: criterion_id === 'fit' ? 'Supports hiring teams.' : 'Quote required; applicable cost is unknown.', evidence: [{ event_seq: source, source: `https://v${target}.example/`, quote: criterion_id === 'fit' ? 'supports hiring teams' : 'Contact sales for a quote' }], assessor: { provider: 'scripted', model: 'judge', prompt_version: '1', rubric_version: '1' }, rejection: null }, who, poi);
    add('comparison.episode_finished', { ...scope, outcome, reason: outcome, evidence_seqs: [source] }, who, poi);
    return { scope, source, who, poi };
  }
  return { config, study, events, add, episode };
}

test('public evidence yields an inspectable matrix, unknown quote pricing, and conditional next checks', () => {
  const f = fixture(); f.episode(0, 0); f.episode(0, 1); f.episode(1, 0); f.episode(1, 1);
  const report = buildComparison(f.events)!;
  assert.equal(report.cells.length, 4);
  assert.equal(report.cells.find((cell) => cell.criterion_id === 'cost')?.assessment, 'unknown');
  assert.equal(report.cells.find((cell) => cell.criterion_id === 'fit')?.distinct_sources, 1);
  assert.equal(report.cells.find((cell) => cell.criterion_id === 'fit')?.assessed, 2);
  assert.ok(report.actions.some((action) => action.criterion_id === 'cost' && action.owner === 'buyer'));
  assert.match(report.decision.summary, /conditional|unresolved/i);
  assert.deepEqual(buildComparison(JSON.parse(JSON.stringify(f.events))), report);
});

test('denominators distinguish failed valid tasks, blocked setup, invalid assignments and unscheduled execution', () => {
  const f = fixture(); f.episode(0, 0, 'task_failed'); f.episode(1, 0, 'blocked_environment'); f.episode(0, 1, 'invalid_task');
  const report = buildComparison(f.events)!;
  const alpha = report.coverage[0], beta = report.coverage[1];
  assert.equal(alpha.scheduled, 2); assert.equal(alpha.attempted, 2);
  assert.equal(alpha.valid_attempts, 1); assert.equal(alpha.completion_rate, 0);
  assert.equal(alpha.outcomes.blocked_environment, 1);
  assert.equal(beta.valid_attempts, 0); assert.equal(beta.completion_rate, null);
  assert.equal(beta.outcomes.invalid_task, 1); assert.equal(beta.outcomes.not_attempted, 1);
  assert.equal(report.pairs[0].matched, 0);
  assert.equal(report.cells.find((cell) => cell.target_id === beta.target_id)?.assessed, 0);
  assert.ok(report.limitations.some((text) => /unequal|unmatched|coverage/i.test(text)));
});

test('rejects cross-target sources, fabricated quotations and unrelated task identities', () => {
  const f = fixture(); const a = f.episode(0, 0); const b = f.episode(0, 1);
  const assessments = f.events.filter((event) => event.type === 'comparison.assessment');
  assessments[0].payload.evidence[0].event_seq = b.source;
  assessments[1].payload.evidence[0].quote = 'The enterprise plan is free';
  assessments[2].payload.task_id = 'candidate-review-not-assigned';
  const report = buildComparison(f.events)!;
  assert.equal(report.rejected_assessments.length, 3);
  assert.equal(report.cells.find((cell) => cell.target_id === a.scope.target_id && cell.criterion_id === 'fit')?.assessment, 'unknown');
});

test('contradictory assessments stay unknown with both sources and no inferred absence', () => {
  const f = fixture(); f.episode(0, 0, 'completed', 'meets'); f.episode(1, 0, 'completed', 'does_not_meet');
  const cell = buildComparison(f.events)!.cells.find((item) => item.criterion_id === 'fit')!;
  assert.equal(cell.assessment, 'unknown'); assert.equal(cell.evidence.length, 2);
  assert.match(cell.limitations.join(' '), /contradict/i);
});

test('recorded semantic rejections cannot establish fit and unsupported completion is incomplete', () => {
  const f = fixture(); f.episode(0, 0);
  const assessment = f.events.find((event) => event.type === 'comparison.assessment')!;
  assessment.payload.rejection = 'The candidate-profile quote does not support pricing or product fit.';
  const finish = f.events.find((event) => event.type === 'comparison.episode_finished')!;
  finish.payload.evidence_seqs = [];
  const report = buildComparison(f.events)!;
  assert.equal(report.rejected_assessments.length, 1);
  assert.equal(report.coverage[0].outcomes.incomplete, 1);
  assert.equal(report.coverage[0].completion_rate, null);
});

test('owner actions target the explicit focal tool only, never the first full-access POI', () => {
  const f = fixture(); f.study.purpose = 'improve_own_product'; f.study.focal_target_id = f.study.targets[1].id;
  f.episode(0, 0); f.episode(1, 0); f.episode(0, 1, 'completed', 'does_not_meet'); f.episode(1, 1, 'completed', 'does_not_meet');
  const report = buildComparison(f.events)!;
  assert.ok(report.actions.some((action) => action.owner === 'product_team'));
  assert.ok(report.actions.filter((action) => action.owner === 'product_team').every((action) => action.target_id === f.study.focal_target_id));
});

test('legacy runs never acquire comparison judgments from pairwise votes', () => {
  const f = fixture(); delete f.config.project.comparison;
  assert.equal(buildComparison(f.events), undefined);
});

test('report rebuilding and Markdown lead with comparison decisions and preserve both pricing and fit citations', () => {
  const f = fixture(); f.episode(0, 0); f.episode(0, 1);
  const report = buildReport(f.events);
  const markdown = reportToMarkdown(report);
  assert.ok(report.comparison);
  assert.ok(markdown.indexOf('## Decision and scope') < markdown.indexOf('## Side-by-side comparison'));
  assert.ok(markdown.includes('## Coverage and evidence'));
  assert.ok(!markdown.includes('Weighted by share'));
  assert.ok(!markdown.includes('## Sentiment'));
  assert.match(markdown, /supports hiring teams/);
  assert.match(markdown, /Contact sales for a quote/);
  assert.match(markdown, /\(#comparison-source-\d+\)/);
});

test('different access scopes and unavailable evidence do not create focal superiority', () => {
  const f = fixture(); f.study.focal_target_id = f.study.targets[0].id;
  f.episode(0, 0); f.episode(0, 1);
  f.study.targets[1].access_scope = 'documentation';
  for (const event of f.events) if (event.type.startsWith('comparison.') && 'target_id' in event.payload && event.payload.target_id === f.study.targets[1].id) event.payload.access_scope = 'documentation';
  const report = buildComparison(f.events)!;
  assert.equal(report.pairs[0].matched, 0);
  assert.ok(report.tradeoffs.every((item) => item.result === 'unresolved'));
});

test('only unknown criteria cannot create a shortlist, and action logs are not vendor claims', () => {
  const f = fixture(); f.episode(0, 0, 'completed', 'unknown'); f.episode(0, 1, 'completed', 'unknown');
  assert.equal(buildComparison(f.events)!.decision.status, 'insufficient_evidence');
  const source = f.events.find((event) => event.type === 'comparison.source')!;
  source.payload.kind = 'action';
  const report = buildComparison(f.events)!;
  assert.equal(report.rejected_assessments.length, 2);
});

test('captured image interpretations remain inference and whitespace-only citations are invalid', () => {
  const f = fixture(); f.episode(0, 0);
  const source = f.events.find((event) => event.type === 'comparison.source')!;
  source.payload.interpretation = 'simulated';
  assert.equal(buildComparison(f.events)!.rejected_assessments.length, 2);
  delete source.payload.interpretation;
  const assessment = f.events.find((event) => event.type === 'comparison.assessment')!;
  assessment.payload.evidence[0].quote = '   ';
  assert.equal(buildComparison(f.events)!.rejected_assessments.length, 1);
});

test('shortlists require all tasks in a scenario and concise cells retain every recorded proposition', () => {
  const f = fixture(); f.study.tasks.push({ ...f.study.tasks[0], id: 'task-details' });
  f.episode(0, 0); f.episode(0, 1);
  f.episode(0, 0, 'completed', 'does_not_meet', 'unknown', 1);
  f.episode(0, 1, 'completed', 'meets', 'unknown', 1);
  const assessment = f.events.find((event) => event.type === 'comparison.assessment')!;
  assessment.payload.summary = 'Supported claim. '.repeat(200);
  const report = buildComparison(f.events)!;
  assert.deepEqual(report.decision.shortlist, [f.study.targets[1].id]);
  assert.ok(report.cells.every((cell) => cell.summary.length <= 1200));
  assert.ok(report.cells[0].evidence[0].proposition.length > 1200);
});

test('observed workflow findings can cite an action and the resulting page together', () => {
  const f = fixture(); const episode = f.episode(0, 0);
  const page = f.events.find((event) => event.type === 'comparison.source')!;
  for (const event of f.events) if (event.seq > page.seq) event.seq++;
  const action = { ...page, seq: page.seq + 1, payload: { ...page.payload, kind: 'action' as const, source_id: 'action-result', text: 'Clicked next; navigation succeeded.' } };
  f.events.push(action);
  const assessment = f.events.find((event) => event.type === 'comparison.assessment')!;
  assessment.payload.basis = 'observed_behavior';
  assert.equal(buildComparison(f.events)!.rejected_assessments.length, 1);
  assessment.payload.evidence.push({ event_seq: action.seq, source: page.payload.source, quote: 'navigation succeeded' });
  const report = buildComparison(f.events)!;
  assert.equal(report.rejected_assessments.length, 0);
  assert.equal(report.cells.find((cell) => cell.target_id === episode.scope.target_id && cell.criterion_id === 'fit')!.evidence.length, 2);
});

test('unattempted reasons require the frozen assignment identity before appearing in limitations', () => {
  const f = fixture();
  const scope: ComparisonScope = { episode_id: 'not-started', target_id: f.study.targets[0].id, task_id: f.study.tasks[0].id, scenario_id: f.study.scenarios[0].id, replicate_id: f.study.execution.replicate_id, segment_id: null, access_scope: 'public_site' };
  f.add('comparison.episode_finished', { ...scope, outcome: 'not_attempted', evidence_seqs: [], reason: 'Matched block cannot fit the allowance.' }, 'p-0', 'poi-0');
  f.add('comparison.episode_finished', { ...scope, episode_id: 'forged', task_id: 'foreign-task', outcome: 'not_attempted', evidence_seqs: [], reason: 'Forged limitation.' }, 'p-0', 'poi-0');
  const report = buildComparison(f.events)!;
  assert.ok(report.limitations.some((item) => /Matched block cannot fit/.test(item)));
  assert.ok(report.limitations.every((item) => !item.includes('Forged limitation')));
});
