// Controlled provider simulation, not an API speed or prose-quality benchmark.
// node engine/src/audience/generation.perf.ts <baseline-git-ref>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultAudience } from './index.ts';
import { DEMO_PERSONA_WRITER } from './demo.ts';
import { sampleTraits, slotSeed } from '@gnomi/simulation/audience/sample.ts';
import { writePersonas, type Candidate } from './write.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import type { LlmGateway } from '@gnomi/simulation/seams.ts';
import type { ProjectConfig } from '@gnomi/simulation/types.ts';

const ref = process.argv[2];
if (!ref) throw new Error('Pass the baseline git ref to compare against.');
const baselineFile = join(import.meta.dirname, `.generation-baseline-${randomUUID()}.ts`);
const project: ProjectConfig = {
  name: 'Benchmark', description: 'Scheduling', goal: 'Book a meeting', role: null, audience: null, settings: DEFAULT_SETTINGS,
  pois: [{ id: 'poi', type: 'web', name: 'Benchmark', start_url: 'http://localhost/', allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null, mode: 'full', segments: null }],
};
const audience = defaultAudience(project);
const segment = audience.segments[0];
const jobs = Array.from({ length: 50 }, (_, i) => {
  const seed = slotSeed(audience.seed, segment.id, i);
  return { id: `p-${i}`, seed, segment, traits: sampleTraits(segment, audience, seed) };
});
const words = (text: string, n: number) => {
  const source = text.split(/\s+/);
  return Array.from({ length: n }, (_, i) => source[i % source.length]).join(' ');
};

async function measure(writer: typeof writePersonas, concurrency: number) {
  let calls = 0, output_chars = 0, input_chars = 0, active = 0, peak = 0;
  const llm: LlmGateway = { async call(req) {
    calls++; peak = Math.max(peak, ++active);
    const demo = DEMO_PERSONA_WRITER(req);
    const value = req.purpose === 'expand_persona'
      ? { background: words((demo as { background: string }).background, 175) }
      : { candidates: (demo as { candidates: Candidate[] }).candidates.map((c, i) => ({ ...c, name: `${req.persona_id} Candidate ${i}`, background: words(c.background, req.system.includes('30 to 45 words') ? 40 : 200) })) };
    const size = JSON.stringify(value).length;
    output_chars += size;
    input_chars += req.system.length + JSON.stringify(req.user).length;
    // Same fixed request overhead and output throughput for both implementations.
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.ceil(size / 40)));
    active--;
    return { object: req.schema.parse(value), cost_usd: 0 };
  } };
  const started = performance.now();
  const result = await writer(jobs, new Map(), { llm, project: { ...project, audience, settings: { ...project.settings, persona_concurrency: concurrency } }, model: project.settings.routing.persona_writer });
  assert.equal(result.personas.length, 50);
  return { ms: Math.round(performance.now() - started), calls, output_chars, input_chars, peak };
}

try {
  writeFileSync(baselineFile, execFileSync('git', ['show', `${ref}:engine/src/audience/write.ts`]), { flag: 'wx' });
  const baseline = (await import(pathToFileURL(baselineFile).href)).writePersonas as typeof writePersonas;
  for (const [name, writer, concurrency] of [['baseline', baseline, 6], ['updated_same_concurrency', writePersonas, 6], ['updated_default', writePersonas, 12]] as const) {
    const trials = [];
    for (let i = 0; i < 3; i++) trials.push(await measure(writer, concurrency));
    console.log(JSON.stringify({ name, median: [...trials].sort((a, b) => a.ms - b.ms)[1], trials_ms: trials.map((t) => t.ms) }));
  }
} finally { rmSync(baselineFile, { force: true }); }
