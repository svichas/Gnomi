import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultAudience, syncPersonas, type AudienceDeps } from './index.ts';
import { DEMO_PERSONA_WRITER } from './demo.ts';
import { nameKey, TAKEN_LABEL, type Candidate } from './write.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { LlmGateway, LlmRequest } from '../seams.ts';
import type { ProjectConfig } from '../types.ts';

const project: ProjectConfig = {
  name: 'Example', description: 'A scheduling tool', goal: 'Book an appointment', role: null,
  poi: { id: 'poi', name: 'Example', type: 'web', start_url: 'http://localhost/', allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null },
  audience: null, settings: { ...DEFAULT_SETTINGS, persona_concurrency: 3 },
};
const audience = { ...defaultAudience(project), persona_count: 12 };

function fixture(fail?: (req: LlmRequest<unknown>) => boolean) {
  const calls: LlmRequest<unknown>[] = [];
  const data = new Map<string, unknown>();
  let active = 0, peak = 0;
  const llm: LlmGateway = { async call(req) {
    calls.push(req); peak = Math.max(peak, ++active);
    await new Promise((resolve) => setImmediate(resolve)); active--;
    req.signal?.throwIfAborted();
    if (fail?.(req)) throw new Error('simulated provider failure');
    return { object: req.schema.parse(DEMO_PERSONA_WRITER(req)), cost_usd: 0.01 };
  } };
  const deps: AudienceDeps = { llm, project, model: project.settings.routing.persona_writer, cache: { get: (key) => data.get(key), set: (key, value) => { data.set(key, value); } } };
  return { deps, calls, data, peak: () => peak };
}

test('four short candidates are sampled, then only the selected biography is expanded with bounded requests', async () => {
  const f = fixture();
  const progress: number[] = [];
  const result = await syncPersonas(audience, [], { ...f.deps, onProgress: (done) => progress.push(done) });
  assert.equal(result.personas.length, 12);
  assert.equal(f.calls.filter((r) => r.purpose === 'write_persona').length, 12);
  assert.equal(f.calls.filter((r) => r.purpose === 'expand_persona').length, 12);
  assert.equal(f.peak(), 3);
  assert.match(f.calls[0].system, /30 to 45 words/);
  assert.ok(f.calls.every((r) => r.max_output_tokens! <= 4096 && r.timeout_ms! > 0));
  assert.deepEqual(progress, Array.from({ length: 13 }, (_, i) => i));
  assert.ok(result.personas.every((p) => p.background.includes('Scripted demo')));
});

test('a failed build resumes completed model stages, even with no published population', async () => {
  let shouldFail = true;
  const f = fixture((req) => shouldFail && req.purpose === 'expand_persona' && req.persona_id?.endsWith('-05') === true);
  await assert.rejects(syncPersonas(audience, [], f.deps), /simulated provider failure/);
  const stages = () => [...f.data.keys()].map((key) => JSON.parse(key) as string[]).map(([id, , , , purpose]) => `${purpose} ${id}`);
  const saved = stages();
  assert.ok(saved.some((s) => s.startsWith('write_persona')) && saved.some((s) => s.startsWith('expand_persona')), 'sketches and biographies were checkpointed');
  const before = f.calls.length;
  shouldFail = false;
  const finished = await syncPersonas(audience, [], f.deps);
  assert.equal(finished.personas.length, 12);
  const resumed = f.calls.slice(before).map((req) => `${req.purpose} ${req.persona_id}`);
  assert.ok(resumed.filter((s) => s.startsWith('expand_persona')).length < 12, 'completed biographies were reused');
  assert.ok(resumed.every((s) => !saved.includes(s)), 'no completed stage regenerated');
  const count = f.calls.length;
  await syncPersonas(audience, finished.personas, f.deps);
  assert.equal(f.calls.length, count, 'unchanged saved profiles still cost no calls');
  await syncPersonas(audience, [], { ...f.deps, project: { ...project, goal: 'Cancel an appointment' } });
  assert.ok(f.calls.length > count + 12, 'changed prompt inputs cannot reuse old drafts');
});

test('a persona is written before every sketch is in, and progress counts sketches', async () => {
  const f = fixture();
  const sketched: number[] = [];
  let firstWritten = -1;
  await syncPersonas(audience, [], { ...f.deps, onSketched: (n) => sketched.push(n), onProgress: (done, _total, persona) => {
    if (done === 1) firstWritten = f.calls.filter((r) => r.purpose === 'write_persona').length;
    if (done > 0) assert.ok(persona?.name, 'each progress step carries the persona just written');
  } });
  assert.deepEqual(sketched, Array.from({ length: 12 }, (_, i) => i + 1));
  assert.ok(firstWritten > 0 && firstWritten < 12, `the first biography finished after ${firstWritten} of 12 sketches started`);
});

test('writer concurrency is validated before dispatch', async () => {
  const f = fixture();
  for (const n of [0, 33, 1.5, NaN]) {
    await assert.rejects(syncPersonas(audience, [], { ...f.deps, project: { ...project, settings: { ...project.settings, persona_concurrency: n } } }), /concurrency/i);
  }
  assert.equal(f.calls.length, 0);
});

test('name repairs avoid names allocated by other repair requests', async () => {
  const calls: LlmRequest<unknown>[] = [];
  const llm: LlmGateway = { async call(req) {
    calls.push(req);
    let value = DEMO_PERSONA_WRITER(req);
    if (req.purpose === 'write_persona') {
      const draft = value as { candidates: Candidate[] };
      value = { candidates: draft.candidates.map((c, i) => ({ ...c, name: `Person ${i + 1}` })) };
    } else if (req.purpose === 'rename_persona') {
      const prompt = req.user.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const taken = new Set(JSON.parse(prompt.split(TAKEN_LABEL)[1].split('\n')[0]) as string[]);
      const names: string[] = [];
      for (let i = 1; names.length < 4; i++) if (!taken.has(`Person ${i}`)) names.push(`Person ${i}`);
      value = { names };
    }
    return { object: req.schema.parse(value), cost_usd: 0 };
  } };
  const result = await syncPersonas(audience, [], { llm, project, model: project.settings.routing.persona_writer });
  assert.equal(new Set(result.personas.map((p) => nameKey(p.name))).size, 12);
  assert.equal(calls.filter((r) => r.purpose === 'rename_persona').length, 8, 'one short repair per clashed slot');
  assert.equal(calls.filter((r) => r.purpose === 'write_persona').length, 12, 'no full drafts rewritten');
});

test('a rate limit reduces subsequent writer concurrency without dropping slots', async () => {
  let throttled = false, active = 0, expansionPeak = 0;
  const config = { ...project, settings: { ...project.settings, persona_concurrency: 6 } };
  const llm: LlmGateway = { async call(req) {
    active++;
    if (req.purpose === 'expand_persona') expansionPeak = Math.max(expansionPeak, active);
    await new Promise((resolve) => setImmediate(resolve));
    if (!throttled) {
      throttled = true;
      req.onAttempt?.({
        payload: { role: req.role, model: req.model.model, provider: req.model.provider, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, latency_ms: 1, status: 'error', error: 'Rate limited', http_status: 429 },
        transcript: { request: {}, response: {} },
      });
    }
    active--;
    return { object: req.schema.parse(DEMO_PERSONA_WRITER(req)), cost_usd: 0 };
  } };
  const result = await syncPersonas(audience, [], { llm, project: config, model: project.settings.routing.persona_writer });
  assert.equal(result.personas.length, 12);
  assert.equal(expansionPeak, 3);
});
