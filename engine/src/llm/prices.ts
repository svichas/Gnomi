// USD per million tokens, standard tier, 5-minute cache writes. Checked 2026-10-15 against tech.md §10.3 and
// Anthropic's pricing via the claude-api skill (cached 2026-10-06). A stale table under-reports cost until updated.
type Rates = { input: number; output: number; cache_read: number; cache_write: number };

const PRICES: Record<string, Rates & { long?: Rates & { above: number } }> = {
  'claude-fable-5-1': { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  // Haiku 5.5 switches every rate to a 5× card once the whole prompt is over 100k tokens.
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cache_read: 0.01,
    cache_write: 0.125,
    long: { above: 100_000, input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625 },
  },
};

/** Disjoint counts, as Anthropic reports them: input_tokens excludes cache reads and writes. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export function costUsd(model: string, usage: TokenUsage): number {
  const card = PRICES[model];
  // An unpriced model would make the cost budget silently blind, so refuse it.
  if (!card) throw new Error(`No price for model ${model}; add it to engine/src/llm/prices.ts`);
  const prompt = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
  const r = card.long && prompt > card.long.above ? card.long : card;
  return (
    (usage.input_tokens * r.input +
      usage.output_tokens * r.output +
      usage.cache_read_tokens * r.cache_read +
      usage.cache_write_tokens * r.cache_write) /
    1_000_000
  );
}
