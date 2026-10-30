import { personaEnvironment } from '../audience/locations.ts';
import { fnv1a } from '../audience/sample.ts';
import { readAsset } from '../assets.ts';
import { atSliceEnd, episodeLog, type EpisodeDeps, type EpisodeEnd } from '../agent/loop.ts';
import { InvalidOutputError } from '../llm/gateway.ts';
import type { Action, Opinion, TextPoi } from '../types.ts';
import type { PoiRunner } from './index.ts';
import type { HeardPost } from '../agent/prompt.ts';
import { READ_TEXT, readParts, readSchema, readShared, readSystemPrompt, type ReadMemory, type ReadOutput } from './text-prompt.ts';

/** About 12k tokens at four characters a token (tech.md §7, §10.4): a longer text is read in parts of at most this many characters. */
export const PART_CHARS = 48_000;

/** The text cut into parts of at most `max` characters, each ending at a paragraph break, else a line break, else a space, past its middle. */
export function textParts(text: string, max = PART_CHARS): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + max);
    if (end < text.length) {
      const window = text.slice(start, end);
      for (const cut of ['\n\n', '\n', ' ']) {
        const at = window.lastIndexOf(cut);
        if (at > max / 2) {
          end = start + at + cut.length;
          break;
        }
      }
    }
    parts.push({ start, end });
    start = end;
  }
  return parts;
}

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The passage a confusion quotes, checked against `text`: the model's offsets when they hold the quote, else the quote's occurrence
 * nearest to them, matched exactly and then ignoring case and runs of white space. Null when the text has no such span.
 */
export function locatePassage(text: string, quote: string, start: number, end: number): { start: number; end: number; text: string } | null {
  const q = quote.trim();
  // A word or two matches all over a text, so it would link a passage the persona may not have meant.
  if (q.split(/\s+/).length < 3 && q.length < 15) return null;
  if (text.slice(start, end) === q) return { start, end, text: q };
  const hits: { start: number; end: number }[] = [];
  for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + 1)) hits.push({ start: at, end: at + q.length });
  if (hits.length === 0) {
    for (const m of text.matchAll(new RegExp(q.split(/\s+/).map(escapeRegExp).join('\\s+'), 'gi'))) hits.push({ start: m.index, end: m.index + m[0].length });
  }
  const best = hits.sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start))[0];
  return best ? { ...best, text: text.slice(best.start, best.end) } : null;
}

/**
 * Copy read and rated (tech.md §7): one model call per part of the text, which is one call for anything under ~12k tokens. Each
 * confusion is a friction with the passage it quotes; the read that reaches the end says what the persona would do next.
 */
async function readText(poi: TextPoi, deps: EpisodeDeps): Promise<EpisodeEnd> {
  const { config, persona, segment, llm, signal, stepsBefore } = deps;
  const { run_id } = config;
  const where = `asset:${poi.asset}`;
  const log = episodeLog(deps, poi.id);
  const { emit } = log;

  if (signal.aborted) return 'stopped';
  const text = await readAsset(deps.blobs, poi.asset).then((data) => new TextDecoder().decode(data), () => null);
  if (!text?.trim()) throw new Error(`The text of "${poi.name}" is missing or empty. Add it again on the Project screen, then start a new run.`);
  emit('persona.episode_started', { poi_id: poi.id, device: persona.device, start_url: where, ...personaEnvironment(persona) });

  const parts = textParts(text);
  const system = readSystemPrompt(persona, config.project, segment, poi);
  const memory: ReadMemory[] = [];
  let opinion: Opinion | null = deps.opinion ?? null;
  let heard: HeardPost[] = []; // the last feed, for the next part only
  let index = 0;
  const last = stepsBefore + deps.budget;
  for (let step_no = stepsBefore + 1; step_no <= last; step_no++) {
    if (atSliceEnd(deps, step_no)) {
      const next = await deps.slice!.next();
      if (!next) return 'stopped';
      opinion = next.opinion;
      heard = next.heard ?? [];
    }
    if (!deps.beginStep()) return 'stopped';
    const started = Date.now();
    const part = parts[index];
    const heard_post_ids = heard.map((h) => h.post_id);
    let output: ReadOutput;
    try {
      const shared = readShared({ poi, text, part, index, parts: parts.length });
      const user = readParts({ persona, text, part, index, parts: parts.length, memory, opinion, heard });
      heard = [];
      const { object } = await llm.call({ role: 'navigator', model: config.project.settings.routing.navigator, run_id, persona_id: persona.id, round: deps.round(), purpose: READ_TEXT, poi_id: poi.id, shared, system, user, schema: readSchema(index < parts.length - 1), signal });
      output = object;
    } catch (err) {
      if (signal.aborted) return 'stopped';
      // The gateway already retried. No valid answer in time ends this reader as the model failing, with no read, exhausted
      // patience or survey answer; any other model error ends the run.
      if (!(err instanceof InvalidOutputError) && !(err instanceof Error && err.name === 'TimeoutError')) throw err;
      emit('signal.repeated_failure', { step_no, action: 'read', error: 'invalid_output' });
      return 'model_failed';
    } finally {
      deps.endStep();
    }
    // A provider may return successfully after cancellation. Its usage stays logged, but the answer must not act.
    if (signal.aborted) return 'stopped';

    const action: Action = { type: output.action.type === 'read_on' ? 'read' : output.action.type, ref: null, text: output.action.text };
    const result = { ok: true, error: null, url_before: where, url_after: where, dom_changed: false };
    const snapshot_hash = fnv1a(text.slice(part.start, part.end)).toString(16);
    const step = emit('persona.step', { step_no, action, target: null, result, thought: output.thought, feeling: output.feeling, snapshot_hash, screenshot: null, duration_ms: Date.now() - started, passage: part, heard_post_ids });
    opinion = log.opinion(opinion, output.opinion, step.seq);
    // A quote may come from any part read so far; one the text does not hold keeps its friction, flagged, but loses the passage.
    const read = text.slice(0, part.end);
    for (const c of output.confusions) {
      const passage = locatePassage(read, c.quote, c.start, c.end);
      emit('persona.friction_reported', { step_no, severity: c.severity, what: c.what, expected: c.expected, where: { url: where, ref: null }, heard_post_ids, ...(passage ? { passage } : { quote_unverified: true }) });
    }
    const own = log.ended(step_no, action);
    if (own) return own;
    memory.push({ part: index + 1, thought: output.thought, confusions: output.confusions.map((c) => c.what) });
    index++;
  }
  emit('signal.budget_exceeded', { step_no: last, budget: deps.budget });
  return 'budget_exceeded';
}

/** Pasted, .md or .txt copy, read and rated: a step is a part read, so a few steps from patience are plenty (tech.md §6.4). */
export const text: PoiRunner<TextPoi> = {
  budget: (patienceBudget) => Math.ceil(patienceBudget / 15), // patience 1 → 1 part, 5 → 4
  // hasAsset: whether the file is in the project's assets/, when the caller can check.
  preflight: (poi, _project, hasAsset?: (id: string) => boolean) =>
    !/^[0-9a-f]{16}\.(md|txt)$/.test(poi.asset) ? `"${poi.name}" has no text yet. Paste the text or choose a .md or .txt file for it.`
    : hasAsset && !hasAsset(poi.asset) ? `The text of "${poi.name}" is missing from the project's files. Paste it or choose the file again.`
    : null,
  episode: readText,
};
