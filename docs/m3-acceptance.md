# M3 acceptance measurements

The M3 mode of the [acceptance runner](m2-acceptance.md) checks the friction pipeline against the roadmap's M3 criteria. It runs the frozen 50-person population on Gym v2 (all 25 defects) with run seeds 20261015 to 20261017, then once more on the control build with every defect switched off. Each run keeps a reopenable project, its event log and transcripts, and its report as JSON and Markdown.

## Run without provider calls

```sh
npm run acceptance -w @gnomi/simulation -- --m3 --out /tmp/gnomi-m3-scripted
```

A scripted rehearsal checks that every theme links to its log events. Scripted frictions do not come from the defects, so recall, precision, stability and the control run stay `NOT_RUN`.

## Run live

```sh
npm run acceptance -w @gnomi/simulation -- --m3 --live --allowance-usd 25 --out acceptance-results/m3-live
```

The allowance works as in M2 and is shared by all four runs; runs that have not started when it is reached stay missing. `--provider`, `--personas` and `--seeds` shrink a run as described in the [M2 guide](m2-acceptance.md#smaller-runs-and-other-providers). A smaller run reports its figures with a "Reduced scale" note and leaves every criterion that needs the full scale `NOT_RUN`.

## Read the results

Start with `acceptance.json` and `manifest.json`. Each run has a folder (`seed-<n>/`, `control/`) with `events.json`, `transcripts.json`, `report.json`, `report.md`, `attempts.jsonl` and `project/`. `theme-mapping.md` lists each report's top 20 themes with their evidence; record the defect each theme describes in `theme-mapping.json`, against the copied catalogue `defects.yaml`.

| Criterion | How it is measured |
|---|---|
| High-severity recall (`recall_high`) | Found high-severity defects ÷ high-severity defects switched on, from the reviewed mapping. A defect is found when a theme with trust confirmed or observed maps to it. Needs ≥ 0.6. |
| Precision (`precision`) | Themes mapped to a defect ÷ all themes in each Gym v2 report's top 20. Needs ≥ 0.7. |
| Stability (`stability`) | Jaccard overlap of the mapped top-ten sets across the three seeds. Needs ≥ 0.6. |
| Control run (`control_run`) | Automatic: the control report has no confirmed theme and at most two reported ones. |
| Evidence links (`evidence_links`) | Automatic and structural: every theme in a finished run has member events, and each is in that run's log. |
| Export size (`export_size`) | Always `NOT_RUN` here; the HTML export is rendered by the app. |

A theme made only of small-target or backtrack signals is left out of the report ([tech.md §8.1](tech.md#81-two-sources-combined)), so it counts in neither precision nor the control run, and it cannot find a defect for recall. Those signals stay in `events.json`, and undersized targets are listed in the report's methods appendix. Rebuilding an older report applies the same rule, so its theme count can drop.

Statuses mean what they mean in M2. The mapping is a reviewer's judgment, so the overall status of a live run is `REVIEW_NEEDED` until it is recorded with its artifact paths in the roadmap.
