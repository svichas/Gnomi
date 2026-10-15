# M4 acceptance measurements

The M4 mode of the [acceptance runner](m2-acceptance.md) checks the social swarm against the roadmap's M4 criteria. It runs the frozen 50-person population against Gym v1 five times, with run seeds 20261015 to 20261019. The population stays the same and the run seed varies the follow graph and feed. In every run the harness injects the same complaint (`RunConfig.injected_posts`) for the fixture's first recruiter, `p-seg1-01`, in round 1. The complaint is about Gym D04: assigning a hiring manager who has no account throws away the job draft. Each run keeps a reopenable project, its event log and transcripts, a report, and its spread figures.

## Run without provider calls

From the repository root:

```sh
npm run acceptance -w @gnomi/engine -- --m4 --out /tmp/gnomi-m4-scripted
```

Scripted mode is the default and makes no provider calls. It can pass the structural scrubber check. Spread and the influence audit stay `NOT_RUN`, because a scripted socialiser shows only that the plumbing works, not how real personas behave. Choose a fresh output directory for each run.

## Run with the default provider

Put `ANTHROPIC_API_KEY` in the local shell, not in repository files or command history. Then run:

```sh
npm run acceptance -w @gnomi/engine -- --m4 --live --allowance-usd 30 --out /tmp/gnomi-m4-live
```

The allowance works as in M2. It is a recorded-spend threshold shared by all five runs. Each run's cost budget is the lower of the project budget and what remains of the allowance. When the allowance is reached, or provider usage is missing, the runner stops and dispatches no new calls, and seeds that have not started stay missing. Calls already dispatched may still be billed, so this is not a cap on the provider invoice. Five 50-person runs with social rounds cost several times the M2 run, so size the allowance accordingly. No extra model call grades the outputs.

## Read the results

Start with `acceptance.json` and `manifest.json`. The manifest records the seeds, the injected post, the fixture hash, routing, the price table and source/runtime information. Each `seed-<n>/` holds `events.json`, `transcripts.json`, `spread.json`, `report.md`, `attempts.jsonl` and `project/`. `influence-audit.md` and `influence-audit.json` hold the audit sample.

| Criterion | How it is measured |
|---|---|
| Spread (`spread`) | For each finished run, the personas other than the author who were reached by the complaint thread: they saw the complaint or a reply to it in a feed, replied in the thread, or have an influence edge from a post in the thread (the shared rule in `engine/src/social/influence.ts`). Reached personas are counted in the author's segment and in all other segments together. A seed counts when same-segment reach is strictly greater than cross-segment reach, so a tie does not count. The criterion passes when four of the five seeds count, and only on live runs. It fails once two measured seeds do not count. A seed with no finished run or no injected post is missing, and the result stays `NOT_RUN` until the five seeds decide it. `spread.json` lists who was reached and how, with segment populations for context. |
| Influence audit (`influence_audit`) | 50 influence edges are sampled across the seeds in the order of a fixed hash of seed, event and post. The sample does not depend on run order. For each edge, the sheet shows the cited post's text, the persona's opinion before and after, and its last socialiser answer before the change, with event references. A human or a judge records `plausible` or `implausible` in `influence-audit.json`. The criterion needs at least 80% plausible and stays `NOT_RUN` until it has been reviewed. If the runs produce fewer than 50 edges, the sheet says so. |
| Scrubber replay (`scrubber_replay`) | Read from the reopened log of each finished run. Rounds must be bracketed by `run.round_started` and `run.round_ended` in order 1, 2, … with nothing missing. Every `social.*` and `persona.opinion_changed` event must lie inside the round it carries. For each round, the log prefix up to its `run.round_ended` must project the same steps, social events, opinion changes and influence edges as the events tagged with that round or earlier. This check is structural, so a rehearsal can pass it. A run without rounds leaves it `NOT_RUN`. |
| Graph frame rate (`graph_frame_rate`) | Always `NOT_RUN` here. Pan and zoom above 30 fps with 200 personas, 10 POIs and 5,000 edges during a live run is measured by the swarm graph's 200-persona performance check in the app. |

Statuses mean what they mean in M2. `FAIL` means an observed requirement failed. `REVIEW_NEEDED` (overall only) means a live run produced evidence that still needs judgment. `NOT_RUN` means nothing was measured. A scripted rehearsal never passes a criterion that needs a live model.

Reach is a relative measure within one synthetic follow graph. It is not calibrated to any real community. The thread is used in place of the report's judge-tagged themes. A persona that repeats the complaint in a new post must have seen the thread first, so it is already counted as reached.

## Pure checks

```sh
node --test engine/src/acceptance/social.test.ts engine/src/acceptance/acceptance.test.ts
```

These tests run the criteria on hand-built logs: pass, fail, ties, missing seeds, deterministic audit sampling, broken round markers, mistagged rounds, and statuses that a rehearsal cannot pass.
