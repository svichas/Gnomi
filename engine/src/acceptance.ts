import { BILLING_CAVEAT, parseOptions } from './acceptance/checks.ts';
import { runAcceptance } from './acceptance/run.ts';

try {
  const options = parseOptions(process.argv.slice(2));
  console.log(options.mode === 'live' ? `Live browsing acceptance. ${BILLING_CAVEAT}` : 'Scripted acceptance rehearsal: no provider calls; live criteria will remain NOT_RUN.');
  const result = await runAcceptance(options);
  console.log(`${result.status}: ${options.out}/acceptance.json`);
  console.log(`Recorded browsing cost: $${result.recorded_cost_usd.toFixed(6)}. Setup cost: $0 (frozen fixture). Review sheets are stored with each case.`);
  if (result.error) console.error(result.error);
  if (result.status === 'FAIL') process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
