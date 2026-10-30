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

## Compare arms on defects

`--evaluate` runs each arm in `ARMS` on Gym v2 and then, with the same arm and seed, on the control build (folders `r<n>-<arm>/` and `r<n>-<arm>-control/`). A scripted rehearsal needs no key:

```sh
npm run acceptance -w @gnomi/simulation -- --evaluate --repeats 1 --arms baseline --personas 4 --out /tmp/gnomi-evaluate-scripted
```

`results.md` and `results.json` compare three defect metrics per replicate:

| Metric | How it is measured |
|---|---|
| `recall_high` | A hint-based estimate, not a reviewed mapping. `defectScores` pairs a theme with a defect only when they share a catalogue page and one of the defect's `hints` in `defects.yaml` appears, as whole words with a regular ending (`s`, `es`, `d`, `ed` or `ing`), in the theme's title, description, elements or evidence. Pairs are one-to-one. |
| `precision` | The same estimate, over the report's top 20 themes. |
| `control_themes` | Themes on the control build with trust confirmed or observed: the false-positive definition in [the evaluation plan](roadmap.md#evaluation-plan). |

They also give each arm a `stability`: the Jaccard overlap of the top ten themes of two replicates, averaged over every pair of complete replicates, with themes paired by `matchThemes` in [report/match.ts](../simulation/src/report/match.ts). It is a single number per arm, so it has no paired interval, and it needs at least two complete replicates. It differs from the M3 `stability` criterion above, which overlaps reviewed defect mappings, and `matchThemes` can pair two themes that only share one key, so it can read a little high.

Add `--mapper provider:model` to have a judge map every theme of the Gym v2 runs after they finish. The mapper must come from a different provider than the navigator, because the evaluation plan asks for another model family, and live it needs that provider's key and a priced model. It shares `--allowance-usd` and writes `theme-mapping.json` with status `MAPPED_BY_MODEL` (`NOT_RUN` on a scripted rehearsal, where no model maps anything), plus `theme-mapping.md`, a sample of 20 themes picked by a fixed hash for a person to check. `results.md` then lists high-severity recall and top-20 precision per run, from `mappingScores` in [checks.ts](../simulation/src/acceptance/checks.ts).

If the allowance runs out during the mapping, it stops before the next call. The runs mapped so far are kept and scored, the others are named in `results.md` and have no score, and the status is `INCOMPLETE`, not `FAIL`; `results.md` gives the reason it stopped. A provider failure during the mapping is a `FAIL` with the provider's message, and the mappings already paid for are kept. When no run was mapped there is no `theme-mapping.json`, and the evaluation claims no mapping. A theme the model left out has no `defect` key in `theme-mapping.json`, unlike `null`, which is its answer that no defect fits. Such a theme counts in no score until a person gives it an id or `null`.

Once a person has corrected `theme-mapping.json`, score it again:

```sh
npm run acceptance -w @gnomi/simulation -- --rescore acceptance-results/evaluate-live
```

This opens no browser and calls no model. It rewrites `results.json` and `results.md` from the folder's `theme-mapping.json`, and refuses an id that is not a web defect switched on in that evaluation. `recall_high` and `precision` then come from the mapping in the per-run table, the scoreboard and the arm differences. A run the mapping does not cover has neither, so an estimate never mixes into a mapped mean, and each run's `outcomes.defect_proxy` keeps the hint-based estimate. The scoreboard's means for those two metrics take only the replicates mapped in every arm, so the arms average the same seeds. A rescore also works out the status again: `INCOMPLETE` while a replicate is unfinished or a run has no score, otherwise `REVIEW_NEEDED` (`NOT_RUN` on a scripted rehearsal). An evaluation that failed stays `FAIL`. Until a rescore, the scoreboard and the arm differences stay hint-based, even with `--mapper`. A rescored live evaluation has the defect status `RESCORED`; the harness cannot tell how many themes a person checked.

A model's mapping is not a reviewed one. The plan's other judge rules (both orders, calibration against a labelled set) are not built.
