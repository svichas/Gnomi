# M5 acceptance measurements

The M5 mode of the [acceptance runner](m2-acceptance.md) checks the new point-of-interest types against the roadmap's M5 criteria, on Gym v3's content. It starts no browser and no Gym server, because text and design POIs open no page. It runs, in this order:

1. **Text with buyers** (`text-d28`, `text-control`). The frozen fixture's people read the Plotline pricing page ([`gymAssets`](../gym/assets.ts) `copy.pricing`) together with a buyer segment, "Procurement", of one more person for every five of the fixture's people run (at least three) and share 20, the other shares scaled to leave room. First with D28 on (the Team plan card lists single sign-on, the comparison table and FAQ give it to Business only), then on the control copy.
2. **Design** (`design-<seed>`, `design-control`). The people walk Gym v3's six checkout frames, D26 on (frame 4 is a sign-in prompt where an order confirmation is expected), once for each run seed 20261015 to 20261019, at most 20 personas each, then the control frames once. The frames carry no names, so a label cannot hint at the defect.
3. **Figma listing**, which this runner never measures.

The fixture's goals are for its applicant tracking system, so each case gives the same people another product and task (the traits and prose stay). Users are asked to work out which plan a team of 20 that needs single sign-on would use, buyers to decide which plan to buy for such a team, and shoppers to buy the rain jacket in their cart as a guest. The single sign-on need is the harness's choice, as the injected complaint is M4's: it points the readers at the question D28 contradicts. The control copy answers the same question consistently.

## Run without provider calls

```sh
npm run acceptance -w @gnomi/simulation -- --m5 --out /tmp/gnomi-m5-scripted
```

Choose a fresh output directory for each run. A scripted rehearsal runs everything above with the demo responders (a few seconds) and checks that the evidence is delivered: sentiment by segment, the buying survey, ranked confusions with quoted passages, one friction per frame, the sheets. Its answers are labelled samples that no model wrote, so every criterion stays `NOT_RUN`, whatever the structure shows. The rehearsal's design friction is on frame 2, not frame 4.

## Run live

```sh
npm run acceptance -w @gnomi/simulation -- --m5 --live --allowance-usd 5 --out acceptance-results/m5-live
```

The allowance works as in M2: a recorded-spend threshold shared by all eight runs, with the text runs first. Runs that have not started when it is reached, or when provider usage goes missing, stay missing; calls already dispatched may still be billed. The example figure is a starting point, not a measurement. A full-scale run makes about 1,100 navigator calls (a read and a survey per text persona, six frames and a survey per design persona), and the design calls send up to two frames each, downscaled to 1,024 px. Cost depends on the routing, so run a reduced run first and read its recorded cost.

`--provider`, `--personas` and `--seeds` shrink a run as in the [M2 guide](m2-acceptance.md#smaller-runs-and-other-providers):

- `--personas N` keeps the first N of the fixture's people for the text case (buyers in addition) and the first N, at most 20, for the design case.
- `--seeds N` runs the first N of the five design seeds. The text and control runs use seed 20261015 whatever N is.
- `--provider deepseek` cannot run the design case. Design POIs need a navigator that reads images, and the design runner's preflight refuses a DeepSeek navigator. The runner then skips the design case: it starts none of its runs, spends nothing on it, and reports `frame_mismatch` and `design_control` as `NOT_RUN` with the preflight's own sentence. The text case runs as usual, on DeepSeek.

With fewer than 20 design personas or fewer than 5 seeds, `frame_mismatch` and `design_control` report their figures as `NOT_RUN` with a "Reduced scale" note, because the roadmap's claim is about five seeds of a 20-person run.

## Read the results

Start with `acceptance.json` and `manifest.json`. The manifest records the seeds, the asset files with their ids, the fixture hashes, routing, the price table and source/runtime information; `defects.yaml` is the Gym catalogue. Each run has a folder with `events.json`, `transcripts.json`, `report.json`, `report.md`, `attempts.jsonl` and `project/` (reopenable, with the text or frames under `assets/`). `d28-themes.md` lists the two text runs' buying surveys and top 20 themes; record in `d28-themes.json` which of them describe D28. `acceptance.json` also gives, per design run, who reported a friction on frame 4, with their words and event numbers.

| Criterion | How it is measured |
|---|---|
| Buyer text (`buyer_text`) | Structural, on the D28 run only live: the run finished; every segment has a sentiment from its surveys; the buyer segment has buying survey answers; the POI has a ranked list of confusions (ranks 1 to n) of which at least one quotes a passage of the text, as the engine verified it. Live only; a rehearsal reports the structure it found and stays `NOT_RUN`. |
| D28 theme (`d28_theme`) | Review. Live runs where both text runs finished leave it `REVIEW_NEEDED` until `d28-themes.json` says whether a theme of the D28 run describes the contradiction and none of the control run does. A text POI has no browser signals, so every theme there has trust `reported`; M3's "confirmed or observed" rule cannot apply, and any theme that describes it counts. |
| Frame mismatch (`frame_mismatch`) | Automatic. A seed counts when a finished design run has a friction on frame 4, the frame where D26 shows the sign-in prompt. Passes when four of the five seeds count, only live; fails once two measured seeds do not count; a seed that did not run or finish is missing and the result stays `NOT_RUN` until the five seeds decide it. |
| Design control (`design_control`) | Automatic, from the control run: no persona reports a friction on frame 4, the order confirmation. A friction there is `REVIEW_NEEDED`, never `FAIL`: a reader decides whether it is a false positive, from the event numbers in `acceptance.json`. |
| Figma listing (`figma_listing`) | Always `NOT_RUN` here. `npm run smoke:figma -w @gnomi/app` (`app/figma.smoke.ts`) lists 50 frames in under ten seconds and shows the token error messages against the fixture API. Against a real file it has never run, and needs a Figma personal access token (Dev or Full seat). |

Statuses mean what they mean in M2. `FAIL` means an observed requirement failed. The overall status of a live run is `REVIEW_NEEDED` until the D28 sheet is reviewed and recorded with its artifact paths in the roadmap. A scripted rehearsal never passes a criterion that needs a live model.

The design runner records every expectation mismatch as a friction on its frame, and `frame_mismatch` reads those, so a friction on frame 4 that the persona gave for another reason also counts. The quotes in `acceptance.json` and `report.md` let a reader tell. Frame 4 is index 3 of the sequence; a test ties it to `gym/defects.yaml` and the frame files.

## Pure checks

```sh
node --test simulation/src/acceptance/m5.test.ts
```

These tests run the criteria on hand-built logs and reports (pass, fail, missing seeds, a run that did not finish, frictions on other frames, a reduced scale), the case builders, and two scripted rehearsals: the full one, and one on DeepSeek that skips the design case.
