# M2 acceptance measurements

The acceptance runner exercises 50 frozen personas against Gym v1 with all 12 defects, followed by a German locale probe. It retains the project database, screenshots, model transcripts, report, metrics and review sheets. The population uses seeded traits and authored prose: this measures browsing, not the quality or cost of live persona generation.

## Run without provider calls

From the repository root:

```sh
npm run acceptance -w @gnomi/simulation -- --out /tmp/gnomi-m2-scripted
```

Choose a fresh output directory for each run. Scripted mode is the default and requires no credentials. It can pass execution, browser-locale and report-replay checks, but every criterion requiring a real model stays `NOT_RUN`. A fast, free scripted run does not establish the live time or cost targets.

## Run with the default provider

Configure `ANTHROPIC_API_KEY` in the local shell without putting it in repository files or command history. Then run:

```sh
npm run acceptance -w @gnomi/simulation -- --live --allowance-usd 6 --out /tmp/gnomi-m2-live
```

This example authorizes a $6 recorded-spend threshold across both cases. The population case retains its $5 run threshold; the second case can use only the remaining allowance. Missing usage stops further acceptance work. Calls already dispatched may still be charged, including after cancellation, so this is not a strict provider invoice cap. No extra model is called to grade the outputs.

The manifest records the selected default routing, price-table snapshot, source/runtime information, fixture seed and hash. Model availability and the repository's prices must be checked against the configured provider before relying on a measured dollar result. The runner reports recorded usage-based cost, not an invoice reconciliation. Setup model cost is zero because the population is frozen; historical authoring cost is outside this measurement.

## Smaller runs and other providers

Three options trade coverage for spend. They work in every mode (M2, `--m3`, `--m4`, `--m5`):

- `--provider deepseek` routes every role to DeepSeek's defaults and reads `DEEPSEEK_API_KEY` instead of `ANTHROPIC_API_KEY`. A DeepSeek navigator reads text only, so visual-only defects cannot be found.
- `--personas N` runs the first personas of each segment of the same frozen fixture, apportioned by share with at least one per segment (4 to 50). The people do not change, only how many of them run.
- `--seeds N` runs the first N seeds of the M3 or M4 suite, or of M5's design runs.

```sh
npm run acceptance -w @gnomi/simulation -- --live --provider deepseek --personas 4 --allowance-usd 0.5 --out acceptance-results/m2-small
```

Below 50 personas, the duration, cost and 12-browser targets (and M3's and M4's scale-dependent criteria, including spread, which saturates in a small population; [M5's mode](m5-acceptance.md) has its own scale rules) report their figures as `NOT_RUN` with a "Reduced scale" note, because they are claims about fifty people. Execution, population and replay are still checked for the smaller population, and the review sheets work the same way.

## Read the results

Start with `acceptance.json` and `manifest.json`. Each case includes `metrics.json`, `events.json`, `transcripts.json`, `report.md`, `review.md`, `review.json`, and a reopenable `project/` directory. The German case also retains snapshots in `browser-evidence.json` showing the real HTTP language header and browser locale, languages and timezone.

| Criterion | Evidence needed |
|---|---|
| 50 personas finish | All 50 episodes terminate, with no blocked or incomplete personas and a finished run. Task-goal success is reported separately from episode completion. |
| Under 30 minutes | Measured population run duration is strictly below 30 minutes. |
| Under $5 | Recorded population cost is strictly below $5 with complete usage; incomplete usage cannot establish a pass. |
| 12 concurrent browsers | Population run reaches 12 open browser contexts. |
| German browser | Actual locale-page evidence shows `de-DE`, German-first language preferences and `Europe/Berlin`. |
| German thoughts | Review nonempty valid thoughts against the saved steps and screenshots. A German browser setting alone is insufficient. |
| Profile adherence | Review thoughts/actions against the frozen profiles and goals, recording verdicts and event references in the review sheet. |
| Replay | Rebuilding the report from the reopened SQLite log matches the saved report. |

`FAIL` means an observed requirement failed. `REVIEW_NEEDED` means evidence needs human judgment or charges are uncertain. `NOT_RUN` means the criterion has not been measured. Editing a review sheet does not automatically certify the summary; record reviewed results with their artifact paths and source revision in the roadmap.

The frozen fixture does not establish live persona-writer diversity or biography quality. M0 repeated defect-detection measurements are also separate: a scripted walk that reports seeded defects is not evidence that a real model discovered them.

## Budget enforcement regressions

```sh
node --test simulation/src/llm/gateway.test.ts simulation/src/llm/scripted.test.ts simulation/src/run.test.ts
npm run smoke:budget -w @gnomi/app
```

These checks cover paid invalid-output retries, final-response cap crossings, canceled requests, late returned usage, actions already dispatched, partial reports and the cost uncertainty explanation in Electron. The approved contract preserves concurrent browsers: after recorded spend reaches the cap, cancel outstanding model requests and dispatch no further requests, retries or browser actions. Already-started browser actions may finish and remain logged.
