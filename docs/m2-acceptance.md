# M2 acceptance measurements

The acceptance runner exercises 50 frozen personas against Gym v1 with all 12 defects, followed by a German locale probe. It retains the project database, screenshots, model transcripts, report, metrics and review sheets. The population uses seeded traits and authored prose: this measures browsing, not the quality or cost of live persona generation.

## Run without provider calls

From the repository root:

```sh
npm run acceptance -w @gnomi/engine -- --out /tmp/gnomi-m2-scripted
```

Choose a fresh output directory for each run. Scripted mode is the default and requires no credentials. It can pass execution, browser-locale and report-replay checks, but every criterion requiring a real model stays `NOT_RUN`. A fast, free scripted run does not establish the live time or cost targets.

## Run with the default provider

Configure `ANTHROPIC_API_KEY` in the local shell without putting it in repository files or command history. Then run:

```sh
npm run acceptance -w @gnomi/engine -- --live --allowance-usd 6 --out /tmp/gnomi-m2-live
```

This example authorizes a $6 recorded-spend threshold across both cases. The population case retains its $5 run threshold; the second case can use only the remaining allowance. Missing usage stops further acceptance work. Calls already dispatched may still be charged, including after cancellation, so this is not a strict provider invoice cap. No extra model is called to grade the outputs.

The manifest records the selected default routing, price-table snapshot, source/runtime information, fixture seed and hash. Model availability and the repository's prices must be checked against the configured provider before relying on a measured dollar result. The runner reports recorded usage-based cost, not an invoice reconciliation. Setup model cost is zero because the population is frozen; historical authoring cost is outside this measurement.

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
node --test engine/src/llm/gateway.test.ts engine/src/llm/scripted.test.ts engine/src/run.test.ts
npm run smoke:budget -w @gnomi/app
```

These checks cover paid invalid-output retries, final-response cap crossings, canceled requests, late returned usage, actions already dispatched, partial reports and the cost uncertainty explanation in Electron. The approved contract preserves concurrent browsers: after recorded spend reaches the cap, cancel outstanding model requests and dispatch no further requests, retries or browser actions. Already-started browser actions may finish and remain logged.
