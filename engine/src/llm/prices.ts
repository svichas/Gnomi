import type { ModelChoice } from '../types.ts';

// USD per million tokens, standard tier. Checked 2026-10-15 against tech.md §10.3 (Anthropic's figures from its pricing
// page via the claude-api skill, cached 2026-10-06; OpenAI's and Google's from their pricing pages). A stale table
// under-reports cost until it is updated.
interface Rates {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

// A card is in effect from its date (UTC) until the next card's. A date before the first card uses the first card.
interface Card extends Rates {
  from: string;
  /** Some models switch every rate to another card once the whole prompt is longer than `above` tokens. */
  long?: Rates & { above: number };
}

const CHECKED = '2026-10-15';
const card = (from: string, input: number, output: number, cache_read: number, cache_write = input): Card => ({ from, input, output, cache_read, cache_write });

// Keyed by `${provider}/${model}`; the oldest card first.
const PRICES: Record<string, Card[]> = {
  // Anthropic writes to its 5-minute cache at 1.25× the input rate.
  'anthropic/claude-fable-5-1': [card(CHECKED, 10, 50, 0.25, 12.5)],
  'anthropic/claude-opus-5-5': [card(CHECKED, 4, 20, 0.2, 5)],
  'anthropic/claude-sonnet-5-5': [card(CHECKED, 2, 10, 0.2, 2.5)], // cache read per the claude-api skill (2026-10-06); tech.md §10.3 had 0.10
  // Haiku 5.5 bills a 5× card once the whole prompt is over 100k tokens.
  'anthropic/claude-haiku-5-5': [{ ...card(CHECKED, 0.1, 0.5, 0.01, 0.125), long: { above: 100_000, input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625 } }],
  // OpenAI and Gemini cache implicitly: a cache write costs the plain input rate.
  'openai/gpt-6-astra': [card(CHECKED, 10, 50, 1)],
  'openai/gpt-6.1-sol': [card(CHECKED, 2, 10, 0.1)],
  'openai/gpt-6-luna': [card(CHECKED, 0.1, 0.5, 0.01)],
  'openai/gpt-5.4-mini': [card(CHECKED, 0.75, 4.5, 0.075)],
  // Gemini cache reads cost 0.1× input. Argon and 3.8 Flash go up on the dates announced in tech.md §10.3.
  'google/gemini-4-argon': [card(CHECKED, 2, 10, 0.2), card('2026-12-01', 4, 20, 0.4)],
  'google/gemini-3.8-flash': [card(CHECKED, 0.75, 3.75, 0.075), card('2027-01-01', 1.5, 7.5, 0.15)],
  'google/gemini-3.5-flash-lite': [card(CHECKED, 0.3, 2.5, 0.03)],
};

/** Disjoint counts, as Anthropic reports them: input_tokens excludes cache reads and writes. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** A local model has no per-token price, so it counts as priced at zero. */
export const isPriced = ({ provider, model }: ModelChoice) => provider === 'openai_compatible' || `${provider}/${model}` in PRICES;

export function costUsd(choice: ModelChoice, usage: TokenUsage, at: Date = new Date()): number {
  if (choice.provider === 'openai_compatible') return 0;
  const cards = PRICES[`${choice.provider}/${choice.model}`];
  // An unpriced model would make the cost budget silently blind, so refuse it.
  if (!cards) throw new Error(`No price for model ${choice.model} (${choice.provider}); add it to engine/src/llm/prices.ts`);
  const current = cards.findLast((c) => Date.parse(c.from) <= at.getTime()) ?? cards[0];
  const prompt = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
  const r = current.long && prompt > current.long.above ? current.long : current;
  return (
    (usage.input_tokens * r.input +
      usage.output_tokens * r.output +
      usage.cache_read_tokens * r.cache_read +
      usage.cache_write_tokens * r.cache_write) /
    1_000_000
  );
}
