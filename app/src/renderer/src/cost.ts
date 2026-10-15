import type { GnomiEvent } from '@gnomi/engine/types.ts';

/** The meter uses recorded charges, including retries; absent legacy metadata proves neither complete nor missing usage. */
export function recordedCost(events: GnomiEvent[]): { cost_usd: number; unreported_usage_calls: number } {
  let cost_usd = 0;
  let unreported_usage_calls = 0;
  for (const event of events) {
    if (event.type !== 'llm.call') continue;
    cost_usd += event.payload.cost_usd;
    if (event.payload.usage_reported === false) unreported_usage_calls++;
  }
  return { cost_usd, unreported_usage_calls };
}

export function missingUsageText(count: number | undefined): string | null {
  if (!count) return null;
  return `${count} model call${count === 1 ? '' : 's'} did not report complete usage. Canceled or failed requests may still incur provider charges. Actual charges may exceed the recorded cost.`;
}
