import { atSliceEnd, episodeLog, type EpisodeEnd } from '../agent/loop.ts';
import type { HeardPost } from '../agent/prompt.ts';
import { assetMime, assetPath, readAsset } from '../assets.ts';
import { personaEnvironment } from '../audience/locations.ts';
import { InvalidOutputError } from '../llm/gateway.ts';
import { readsImages } from '../settings.ts';
import type { BlobStore, UserPart } from '../seams.ts';
import type { Action, DesignPoi, Opinion } from '../types.ts';
import { designParts, designSchema, designSystemPrompt, frameLabel, type DesignOutput } from './design-prompt.ts';
import { frameForModel, type ImageType } from './frames.ts';
import type { PoiRunner } from './index.ts';

// The static-design POI (tech.md §7): one model call per screen, which sees only that screen and the one before, downscaled.

// Asset ids are content hashes, so one downscaled copy serves every persona and run; the oldest goes past CACHED.
const CACHED = 64;
const downscaled = new Map<string, Promise<UserPart>>();
function modelFrame(blobs: BlobStore, poi: DesignPoi, index: number): Promise<UserPart> {
  const { asset } = poi.frames[index];
  let image = downscaled.get(asset);
  if (!image) {
    image = readAsset(blobs, asset).then(
      (data) => ({ type: 'image', ...frameForModel(data, assetMime(asset) as ImageType) }),
      () => {
        throw new Error(`Frame ${index + 1} of "${poi.name}" is missing from the project's assets. Add the image again, then start a new run.`);
      },
    );
    image.catch(() => downscaled.delete(asset)); // a missing frame that is added again must be read again
    downscaled.set(asset, image);
    if (downscaled.size > CACHED) downscaled.delete(downscaled.keys().next().value!);
  }
  return image;
}

export const design: PoiRunner<DesignPoi> = {
  // A screen is a step: the sequence sets the budget, and patience caps a very long one.
  budget: (patienceBudget, poi) => Math.min(patienceBudget, poi.frames.length),

  preflight(poi, project, hasAsset) {
    if (poi.frames.length === 0) return `"${poi.name}" has no frames. Add at least one image, or remove it.`;
    const missing = poi.frames.findIndex((frame) => !hasAsset(frame.asset));
    if (missing >= 0) return `Frame ${missing + 1} of "${poi.name}" is missing from the project's assets. Add the image again, or remove the frame.`;
    const { provider, model } = project.settings.routing.navigator;
    const choose = 'Choose a navigator from Anthropic, OpenAI or Google, or DeepSeek deepseek-flash, under Model choices.';
    if (!readsImages({ provider, model })) return `"${poi.name}" is a design, and the navigator model (DeepSeek ${model}) reads text only. ${choose}`;
    if (provider === 'openai_compatible') return `"${poi.name}" is a design, and Gnomi cannot tell whether the local endpoint's navigator model (${model}) can see images. ${choose}`;
    return null;
  },

  async episode(poi, deps): Promise<EpisodeEnd> {
    const { config, persona, segment, llm, blobs, signal, stepsBefore, budget } = deps;
    const { run_id } = config;
    const poi_id = poi.id;
    const log = episodeLog(deps, poi_id);
    const { emit } = log;
    const system = designSystemPrompt(persona, config.project, segment, poi);
    const last = Math.min(budget, poi.frames.length);
    let said: DesignOutput | null = null; // the persona's answer on the screen before
    let opinion: Opinion | null = deps.opinion ?? null;
    let heard: HeardPost[] = []; // the last feed, for the next screen only

    if (signal.aborted) return 'stopped';
    emit('persona.episode_started', { poi_id, device: persona.device, start_url: `asset:${poi.frames[0].asset}`, ...personaEnvironment(persona) });
    for (let index = 0; index < last; index++) {
      const step_no = stepsBefore + index + 1;
      if (atSliceEnd(deps, step_no)) {
        const next = await deps.slice!.next();
        if (!next) return 'stopped';
        opinion = next.opinion;
        heard = next.heard ?? [];
      }
      if (!deps.beginStep()) return 'stopped';
      const started = Date.now();
      const heard_post_ids = heard.map((h) => h.post_id);
      let output: DesignOutput | null;
      try {
        const [previous, current] = await Promise.all([index > 0 ? modelFrame(blobs, poi, index - 1) : null, modelFrame(blobs, poi, index)]);
        if (signal.aborted) return 'stopped';
        const user = designParts({ persona, poi, index, current, previous: previous && { image: previous, said }, opinion, heard });
        heard = [];
        output = (await llm.call({ role: 'navigator', model: config.project.settings.routing.navigator, run_id, persona_id: persona.id, round: deps.round(), purpose: 'design', poi_id: poi.id, system, user, schema: designSchema, signal })).object;
      } catch (err) {
        if (signal.aborted) return 'stopped';
        // A second invalid answer is a failed step, as in the web loop; a missing frame or any other model error ends the run.
        if (!(err instanceof InvalidOutputError)) throw err;
        output = null;
      } finally {
        deps.endStep();
      }
      if (signal.aborted) return 'stopped'; // a late answer after a stop stays logged but does not act

      const { asset } = poi.frames[index];
      const url = `asset:${asset}`;
      const end = output?.action === 'abandon' ? 'abandon' : index === poi.frames.length - 1 ? 'done' : null;
      const summary = `Looked through all ${poi.frames.length} screens of ${poi.name}`;
      const action: Action = end ? { type: end, ref: null, text: end === 'abandon' ? (output?.reason ?? '') : summary } : { type: 'read', ref: null, text: null };
      const recorded = emit('persona.step', {
        step_no,
        action,
        target: { role: 'frame', name: frameLabel(poi, index), box: null },
        result: { ok: output !== null, url_before: url, url_after: url, dom_changed: false, error: output ? null : 'invalid_output' },
        thought: output?.thought ?? '',
        feeling: output?.feeling ?? 0,
        snapshot_hash: asset,
        screenshot: assetPath(asset), // the frame itself is the evidence: the report and its exports show it like a screenshot
        duration_ms: Date.now() - started,
        frame: index,
        heard_post_ids,
      });
      opinion = log.opinion(opinion, output?.opinion, recorded.seq);
      // A mismatch is always a friction: in the persona's words on this frame where it gave them, else on the frame whose
      // expectation this one broke, saying what was expected and what the flow showed instead.
      if (output?.friction) emit('persona.friction_reported', { step_no, ...output.friction, where: { url, ref: null }, frame: index, heard_post_ids });
      else if (output?.matched === false && index > 0 && said?.expects_next) {
        const expected = said.expects_next;
        const what = `Expected ${expected}, but the next screen showed: ${output.sees}`;
        emit('persona.friction_reported', { step_no: step_no - 1, severity: 2, what, expected, where: { url: `asset:${poi.frames[index - 1].asset}`, ref: null }, frame: index - 1, heard_post_ids });
      }

      const own = log.ended(step_no, action);
      if (own) return own;
      said = output;
    }
    emit('signal.budget_exceeded', { step_no: stepsBefore + last, budget });
    return 'budget_exceeded';
  },
};
