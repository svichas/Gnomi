import type { GnomiEvent, RunEstimate } from '@gnomi/simulation/types.ts';

const range = (low: number, high: number, show: (n: number) => string) => (show(low) === show(high) ? show(low) : `${show(low)}–${show(high)}`);

/** "about $0.40–$0.90 and 3–6 minutes", with the models it could not price. */
export function estimateText(estimate: RunEstimate): string {
  const minutes = range(Math.max(1, Math.round(estimate.minutes[0])), Math.max(1, Math.round(estimate.minutes[1])), String);
  return `About ${range(estimate.cost_usd[0], estimate.cost_usd[1], (n) => `$${n.toFixed(2)}`)} and ${minutes} ${minutes === '1' ? 'minute' : 'minutes'}`;
}

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
