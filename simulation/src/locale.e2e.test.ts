// Real browser and SQLite log, scripted model: this proves locale propagation and text preservation,
// not that a live provider consistently follows the requested thought language.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startGym } from '../../demo/GymSite/server.ts';
import { launchBrowserPool } from './browser/pool.ts';
import { createScriptedGateway, DEMO_SURVEY, requestText } from './llm/scripted.ts';
import { createFsBlobStore } from './log/blobs.ts';
import { openProject } from './log/sqlite.ts';
import { BUILTIN_PERSONA } from './persona.ts';
import { createRecorder, newRunConfig, startRun } from './run.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import type { GnomiEvent, Persona, ProjectConfig } from './types.ts';

test('a German persona reaches the Gym with her locale, languages and Berlin timezone, and logs her German thought unchanged', async (t) => {
  const gym = await startGym({ port: 0, defects: 'none' });
  t.after(() => gym.close());
  const browsers = await launchBrowserPool();
  t.after(() => browsers.close());
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-locale-'));
  const store = openProject(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const persona: Persona = {
    ...BUILTIN_PERSONA,
    id: 'p-de-01',
    name: 'Lea Schneider',
    country: 'DE',
    city: 'Berlin',
    timezone: 'Europe/Berlin',
    language: 'de',
    languages: ['de-DE', 'en-GB'],
  };
  const project: ProjectConfig = {
    name: 'Gym ATS',
    description: 'A demo applicant tracking system.',
    pois: [{ id: 'poi-locale', type: 'web', name: 'Locale echo', start_url: `${gym.url}/locale`, allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null }],
    goal: 'Check which language and timezone the website sees.',
    role: null,
    audience: null,
    settings: { ...DEFAULT_SETTINGS, screenshots: false },
  };
  const thought = 'Ich sehe Deutsch als erste Sprache und die Berliner Zeitzone. Das passt für mich.';
  const live: GnomiEvent[] = [];
  const record = createRecorder(store, (event) => live.push(event));
  let snapshot = '';
  const llm = createScriptedGateway({
    navigator: (request) => {
      if (request.purpose === 'survey') return DEMO_SURVEY;
      snapshot = requestText(request);
      return { thought, feeling: 1, action: { type: 'done', ref: null, text: 'Sprache und Zeitzone geprüft.' }, friction: null };
    },
  }, record);
  const config = store.createRun(newRunConfig(project, { personas: [persona], sessions: [], reset: false }));
  const report = await startRun(config, { store, blobs: createFsBlobStore(dir), browsers, llm, record, sessions: null }).done;

  assert.equal(report.status, 'finished', report.stop_reason ?? 'run finished');
  // These values are rendered by the real Gym page from the HTTP request and browser APIs.
  assert.match(snapshot, /Accept-Language: de-DE(?:,|;|["\n])/);
  assert.match(snapshot, /Browser locale: de-DE/);
  assert.match(snapshot, /Browser languages: de-DE, en-GB/);
  assert.match(snapshot, /Browser timezone: Europe\/Berlin/);

  const events = store.events(config.run_id);
  const started = events.find((event) => event.type === 'persona.episode_started');
  assert.ok(started);
  assert.deepEqual({ locale: started.payload.locale, timezone: started.payload.timezone, languages: started.payload.languages }, {
    locale: 'de-DE', timezone: 'Europe/Berlin', languages: ['de-DE', 'en-GB'],
  });
  const step = events.find((event) => event.type === 'persona.step');
  assert.ok(step);
  assert.equal(step.payload.thought, thought);
  assert.deepEqual(live.find((event) => event.type === 'persona.step'), step, 'the activity stream receives the persisted thought unchanged');
  const transcripts = store.transcripts(config.run_id);
  assert.equal(transcripts.length, 2, 'the step and the survey');
  assert.ok(transcripts[0].response_json.includes(thought));
  assert.equal(report.cost_usd, 0, 'the validation uses a scripted model');
});
