import { fnv1a, mulberry32 } from '../audience/sample.ts';
import type { LlmAttempt, LlmGateway, LlmRequest, LlmResult, Recorder, Responder } from '../seams.ts';
import type { LlmRole } from '../types.ts';
import { InvalidOutputError, recordAttempt, retryParts, transcriptRequest } from './gateway.ts';

/** One entry per model call: the raw output object, or a function of the request that returns it. */
export type Script = Array<object | ((req: LlmRequest<unknown>) => unknown)>;

/** Page-independent, so GNOMI_FAKE_LLM=1 works on any site; every text says plainly that no model ran. */
const DEMO_STEPS = [
  {
    thought: 'Scripted demo, no model is running. Scrolling to look the page over.',
    feeling: 0,
    action: { type: 'scroll', ref: null, text: 'down' },
    friction: null,
  },
  {
    thought: 'Scripted demo: logging a sample friction so the report has one to show.',
    feeling: -1,
    action: { type: 'scroll', ref: null, text: 'up' },
    friction: {
      severity: 1,
      what: 'Sample friction from the scripted demo persona; no model looked at this page',
      expected: 'A run with a model API key, which reports real frictions',
    },
    opinion: {
      sentiment: -1,
      confidence: 0.5,
      likes: ['Sample like from the scripted demo: clear navigation; no model assessed this page'],
      frictions: ['Sample friction from the scripted demo persona; no model looked at this page'],
    },
  },
  {
    thought: 'Scripted demo: stopping here.',
    feeling: 0,
    action: { type: 'abandon', ref: null, text: 'Scripted demo run: no model was called' },
    friction: null,
  },
];

export const DEMO_SCRIPT: Script = DEMO_STEPS;

/** The buying survey answer of every demo buyer. */
export const DEMO_BUYER_SURVEY = {
  objections: ['Sample objection from the scripted demo buyer; no model read this'],
  unclear: ['Sample question from the scripted demo buyer; no model read this'],
  likes: [],
  price: 'unclear',
  sentiment: 0,
  confidence: 0.5,
  would_buy: false,
  reason: 'Scripted demo buying survey: no model was called.',
};

/**
 * A demo read of one part of a text POI (poi/text-prompt.ts): the part's first line comes back as a sample confusion at its real
 * offsets, so the passage points into the text; the last part ends the read.
 */
export const DEMO_READ: Responder = (req) => {
  // The part itself is the shared prefix (poi/text-prompt.ts readShared).
  const text = [req.shared ?? '', ...req.user.map((p) => (p.type === 'text' ? p.text : ''))].join('\n');
  const part = /<text start="(\d+)">\n([\s\S]*)\n<\/text>/.exec(text);
  const offset = Number(part?.[1] ?? 0);
  const quote = (part?.[2] ?? '').split('\n').find((line) => line.trim())?.trim().slice(0, 200) ?? '';
  const start = offset + (part?.[2].indexOf(quote) ?? 0);
  const end = /This is the end of the text\./.test(text);
  const sample = 'Sample confusion from the scripted demo persona; no model read this text';
  return {
    thought: 'Scripted demo, no model is reading. Skimming the text.',
    feeling: 0,
    confusions: quote ? [{ quote, start, end: start + quote.length, what: sample, expected: 'A run with a model API key, which reports real confusions', severity: 1 }] : [],
    opinion: { sentiment: 0, confidence: 0.5, likes: [], frictions: [sample] },
    action: end ? { type: 'done', text: 'Scripted demo: no model decided what to do next' } : { type: 'read_on', text: null },
  };
};

/** The end-of-episode survey answer of every demo persona. */
export const DEMO_SURVEY = {
  frictions: [{ where: 'scripted demo', what: 'Sample friction from the scripted demo persona; no model looked at this page', severity: 2 }],
  objections: [],
  likes: [{ where: 'scripted demo', what: 'Sample like from the scripted demo: clear navigation; no model assessed this page' }],
  sentiment: -1,
  confidence: 0.5,
  would_continue: false,
  reason: 'Scripted demo survey: no model was called.',
};

/**
 * A design screen (poi/design-prompt.ts) with no model looking at it: every screen is passed over, and the second one is a sample
 * mismatch so the report has frame evidence to show. Every text says plainly that no model ran.
 */
export const DEMO_DESIGNER: Responder = (req) => {
  const text = requestText(req);
  const screen = Number(/^Screen (\d+) of/m.exec(text)?.[1] ?? 1);
  const quiet = {
    thought: 'Scripted demo, no model is running, so nobody looked at this screen.',
    feeling: 0,
    matched: screen === 1 ? null : true,
    sees: 'Scripted demo: no model looked at this screen.',
    would_do: 'Scripted demo: move on to the next screen.',
    expects_next: 'Scripted demo: the next screen.',
    action: 'continue',
    reason: null,
    friction: null,
    opinion: null,
  };
  if (screen !== 2) return quiet;
  return {
    ...quiet,
    thought: 'Scripted demo: logging a sample mismatch so the report has one to show.',
    matched: false,
    friction: { severity: 1, what: 'Sample mismatch from the scripted demo persona; no model looked at this screen', expected: 'A run with a model API key, which reports real mismatches' },
  };
};

/** Every persona of every run plays the three demo steps in turn, then answers the demo survey; counted per run, so the next run starts over. */
export const DEMO_NAVIGATOR: Responder = (() => {
  const calls = new Map<string, number>();
  return (req) => {
    if (req.purpose === 'buyer_survey') return DEMO_BUYER_SURVEY;
    if (req.purpose === 'read_text') return DEMO_READ(req);
    if (req.purpose === 'survey') return DEMO_SURVEY;
    if (req.purpose === 'design') return DEMO_DESIGNER(req);
    const key = `${req.run_id}/${req.persona_id}`;
    const n = calls.get(key) ?? 0;
    calls.set(key, n + 1);
    return DEMO_STEPS[Math.min(n, DEMO_STEPS.length - 1)];
  };
})();

/**
 * A plausible, mostly silent swarm with no model behind it: a draw seeded by run, persona and round sometimes reacts to or answers
 * the top post of the feed, and sometimes posts. Every text says plainly that no model wrote it, and opinions never move.
 */
export const DEMO_SOCIALISER: Responder = (req) => {
  const text = requestText(req);
  const feed = [...text.matchAll(/^\[post ([^\]\s]+)\]/gm)].map((m) => m[1]); // the feed lines of socialParts
  const about = /about_poi_id: "([^"]+)"/.exec(req.system)?.[1] ?? null;
  const next = mulberry32(fnv1a(`social/${req.run_id}/${req.persona_id}/${req.round}`));
  const u = next();
  const quiet = { thought: 'Scripted demo: no model read this feed.', action: 'nothing', post_id: null, text: null, reaction: null, about_poi_id: null, opinion_updates: [] };
  if (feed.length && u < 0.2) return { ...quiet, action: 'react', post_id: feed[0], reaction: next() < 0.7 ? 'agree' : 'disagree' };
  if (feed.length && u < 0.3) return { ...quiet, action: 'reply', post_id: feed[0], text: 'Scripted demo reply: no model wrote this.', about_poi_id: about };
  if (u < 0.35) return { ...quiet, action: 'post', text: 'Scripted demo post: no model wrote this, so it says nothing about the product.', about_poi_id: about };
  return quiet;
};

/** The request's text parts, one per line, for responders that read the prompt. */
export function requestText(req: LlmRequest<unknown>): string {
  return req.user.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

/** The JSON object a report-model request carries as its one text part (report/models.ts). */
function requestJson(req: LlmRequest<unknown>): Record<string, unknown> {
  const part = req.user.find((p) => p.type === 'text');
  try {
    return part ? JSON.parse(part.text) : {};
  } catch {
    return {};
  }
}

/** One theme per friction or like group the judge was shown, saying plainly that no model named it; in social runs every post is tagged with the first group. */
export const DEMO_JUDGE: Responder = (req) => {
  if (req.purpose === 'comparison_assessment' || req.purpose === 'comparison_verification') {
    const input = requestJson(req) as { criteria?: { id: string }[] };
    const reason = 'Scripted demo: no model assessed the comparison evidence. Run with a configured model to evaluate these criteria.';
    if (req.purpose === 'comparison_verification') return {
      outcome_supported: false, outcome_reason: reason,
      criteria: (input.criteria ?? []).map((criterion) => ({ criterion_id: criterion.id, supported: true, reason })),
    };
    return { outcome: 'incomplete', reason, outcome_evidence: [], criteria: (input.criteria ?? []).map((criterion) => ({ criterion_id: criterion.id, assessment: 'unknown', basis: 'simulated_inference', summary: reason, evidence: [] })) };
  }
  const { groups = [], posts, likes } = requestJson(req) as { groups?: { id: string }[]; posts?: { id: string }[]; likes?: { id: string }[] };
  return {
    themes: groups.map((group, i) => ({
      title: `Scripted demo theme ${i + 1}: no model named it`,
      description: `Scripted demo: no judge model ran, so this is friction group ${group.id} as the engine grouped it.`,
      group_ids: [group.id],
    })),
    ...(posts ? { posts: groups.length > 0 ? posts.map((post) => ({ post_id: post.id, group_ids: [groups[0].id] })) : [] } : {}),
    ...(likes ? { likes: likes.map((like, i) => ({ title: `Scripted demo like ${i + 1}: no model named it`, description: `Scripted demo: no judge model ran, so this is like group ${like.id} as the engine grouped it.`, group_ids: [like.id] })) } : {}),
  };
};

/** A labelled placeholder suggestion for every theme the author was shown. */
export const DEMO_AUTHOR: Responder = (req) => {
  const themes = (requestJson(req).themes ?? []) as { id: string }[];
  return {
    suggestions: themes.map((theme) => ({
      theme_id: theme.id,
      change: 'Scripted demo suggestion: no author model ran, so this is not a real suggested change.',
      solution: 'Run with a model API key to get a suggested change and a possible solution for this theme.',
    })),
  };
};

/** The ref of the first `- role "name" … [ref=eN]` line in the request's page snapshot, for scripts that walk a known site. */
export function findRef(req: LlmRequest<unknown>, role: string, name: string): string | null {
  const text = requestText(req);
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`- ${role} "${quoted}".*?\\[ref=([^\\]\\s]+)\\]`).exec(text)?.[1] ?? null;
}

/**
 * A gateway with no model behind it. `script` is either an array that answers the calls one after another whatever their
 * role, or a responder per role. Each attempt costs `costPerCall`, so budget tests can spend fake money.
 */
export function createScriptedGateway(script: Script | Partial<Record<LlmRole, Responder>>, record: Recorder, opts: { costPerCall?: number } = {}): LlmGateway {
  const costPerCall = opts.costPerCall ?? 0;
  let next = 0;
  const respond = (req: LlmRequest<unknown>): unknown => {
    if (!Array.isArray(script)) {
      const responder = script[req.role];
      if (!responder) throw new Error(`The script has no responder for the ${req.role} role`);
      return responder(req);
    }
    if (next >= script.length) throw new Error(`The script ran out after ${script.length} model calls`);
    const entry = script[next++];
    return typeof entry === 'function' ? entry(req) : entry;
  };

  return {
    async call<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      let user = req.user;
      let spent = 0;
      for (let attemptNo = 1; ; attemptNo++) {
        req.signal?.throwIfAborted();
        const output = respond({ ...req, user });
        const parsed = req.schema.safeParse(output);
        const error = parsed.success ? null : parsed.error.message;
        spent += costPerCall;
        const attempt: LlmAttempt = {
          payload: {
            role: req.role, purpose: req.purpose ?? null, provider: 'scripted', model: req.model.model,
            input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
            cost_usd: costPerCall, latency_ms: 0, usage_reported: true,
            status: parsed.success ? 'ok' : 'invalid_output', error,
          },
          transcript: { request: transcriptRequest(req, user), response: { output, error } },
        };
        recordAttempt(req, attempt, record);
        if (parsed.success) return { object: parsed.data, cost_usd: spent };
        req.signal?.throwIfAborted();
        if (attemptNo === 2) throw new InvalidOutputError(`Invalid output twice: ${error}`);
        user = retryParts(req.user, error ?? '');
      }
    },
  };
}
