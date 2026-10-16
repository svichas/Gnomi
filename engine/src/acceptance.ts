import { BILLING_CAVEAT, parseOptions } from './acceptance/checks.ts';
import { runAcceptance, runM3Acceptance, runM4Acceptance } from './acceptance/run.ts';

try {
  const options = parseOptions(process.argv.slice(2));
  console.log(options.mode === 'live' ? `Live ${options.m4 ? 'M4 social' : options.m3 ? 'M3 friction' : 'browsing'} acceptance on ${options.provider}, ${options.personas} personas. ${BILLING_CAVEAT}` : 'Scripted acceptance rehearsal: no provider calls; live criteria will remain NOT_RUN.');
  const result = options.m4 ? await runM4Acceptance(options) : options.m3 ? await runM3Acceptance(options) : await runAcceptance(options);
  console.log(`${result.status}: ${options.out}/acceptance.json`);
  console.log(options.m4
    ? `Recorded cost: $${result.recorded_cost_usd.toFixed(6)}. Setup cost: $0 (frozen fixture). Influence audit sheet: ${options.out}/influence-audit.md.`
    : options.m3 ? `Recorded cost: $${result.recorded_cost_usd.toFixed(6)}. Setup cost: $0 (frozen fixture). Theme mapping sheet: ${options.out}/theme-mapping.md.`
    : `Recorded browsing cost: $${result.recorded_cost_usd.toFixed(6)}. Setup cost: $0 (frozen fixture). Review sheets are stored with each case.`);
  if (result.error) console.error(result.error);
  if (result.status === 'FAIL') process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
