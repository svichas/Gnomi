# M2 gap closure tasks

- [x] Audit M0–M2 implementation and assign non-overlapping agent ownership.
- [x] Country identity: deterministic country/city/timezone/language sampling; legacy fallback; supplied employer lists.
- [x] Browser locale: propagate persona locale to the real browser and episode log; native-language thought instruction.
- [x] Audience UI: country mix/employer inputs and profile displays.
- [x] Project home: create/open/rename/duplicate/delete/export with isolation and credential exclusion.
- [x] Gym locale echo and real-browser German locale regression.
- [x] Integration checkpoint: tests, typecheck, build, Electron smoke and review.
- [x] Update roadmap status with implemented capabilities and unverified acceptance criteria.

## Verification commands

- Focused engine and helper tests: `node --test <test-path>`.
- Full test suite: `npm test`.
- Type checking: `npm run typecheck`.
- App build: `npm run build -w @gnomi/app`.
- Electron runtime smoke: `node app/smoke.ts` after building.
- Project-management smoke: `npm run smoke:projects -w @gnomi/app`.

## Results — 15 October 2026

- `npm test`: 343 passing tests (262 engine, 44 Gym, 37 app); no failures or skips.
- `npm run typecheck` and the production app build passed.
- Main Electron smoke passed, including country/employer generation and inspector displays.
- Project Electron smoke passed, including Save/Discard/Cancel, failed-operation recovery, export cancellation, Trash, active-run switching refusal, persistence and 720px layout; no page errors.
- Reviewed desktop/narrow project-home and inspector screenshots. Review findings around corrupt-project rollback, very large country weights and symlinked metadata/SQLite sidecars were fixed with regressions.
- A mutation check in a disposable source copy confirmed that removing the in-flight project guard makes its regression test fail.
- All model calls in these checks were scripted; live-provider acceptance is still open.

## Configurable profile attributes — second batch

- [x] Define shared schema, sampling and report contracts and assign agent ownership.
- [x] Implement and validate the default schema, custom rules and deterministic sampling.
- [x] Apply switches to writer/navigator inputs and track biography freshness.
- [x] Add profile editor, per-segment rules, template import/export and schema-aware profile views.
- [x] Add frozen-schema report dimensions and report/activity filters.
- [x] Guard engine save/run boundaries; verify persistence and immutable run snapshots.
- [x] Integrate, review, run full checks and verify the profile flow in Electron.
- [x] Update roadmap status and record verification evidence.

## Current opinions

- [x] Audit the missing opinion ledger and agree the response/event contract.
- [x] Add structured response validation, changed events and deterministic log folding.
- [x] Show self-reported opinion and evidence links in the inspector; preserve legacy empty state.
- [x] Verify replay, malformed input, unchanged snapshots and integrated Electron behavior.

## Second-batch results — 15 October 2026

- `npm test`: 376 passing tests (286 engine, 44 Gym, 46 app), no failures or skips.
- Full typecheck and production app build passed.
- Main Electron smoke, project-management smoke and `npm run smoke:profiles -w @gnomi/app` passed. All calls were scripted; no provider keys or paid calls were used.
- Profile smoke covers core guards, per-segment custom choices, disabled employer output, native template download/import, invalid-template rejection, card visibility, stale open-edit dismissal, regeneration and report filtering. Reviewed desktop cards, the 720px editor and filtered report screenshots.
- Main smoke verifies current opinion sentiment/confidence/likes/frictions and the source-step link; reviewed the highlighted evidence screenshot.
- Review regressions fixed: mutable run snapshots, private sampled values after rule changes, audience-seed changes, stale open persona edits, custom IDs colliding with omitted defaults, and synthetic invalid-output feelings in report dimensions. A 50-person weighted-choice test checks distinct segment distributions against binomial sampling tolerance.
- M2 remains open for live-provider acceptance and the concurrency budget-overshoot decision; see `docs/roadmap.md`.

## Budget enforcement and live acceptance — third batch

- [x] Audit engine budget behavior, app claims and existing acceptance evidence.
- [x] Resolve the concurrent-call overshoot contract: preserve concurrency, cancel immediately at recorded cap, report uncertain charges.
- [x] Observe every attempt; cancel at the recorded cap and suppress later requests/actions.
- [x] Preserve usage/transcripts and expose unreported usage in live/report costs.
- [x] Add an opt-in acceptance runner with retained evidence and honest criterion statuses.
- [x] Run focused regressions, full checks and Electron verification; review integrated changes.
- [x] Record measured acceptance and remaining live-provider limitations in the roadmap.
- [ ] Run live-provider measurements and review German thoughts/profile adherence once local credentials and a recorded-spend allowance are available. Frozen-fixture browsing does not close live persona-writer quality acceptance. A reduced-scale DeepSeek run is in [the 16 October results](#low-cost-live-acceptance-on-deepseek--16-october-2026); the 50-person time, cost and concurrency targets are still unmeasured.

## Third-batch results — 15 October 2026

- Full suite: 394 tests passed (302 engine, 44 Gym, 48 app), no failures or skips. Final acceptance review added one regression; all five acceptance tests then passed. Full typecheck and production app build passed; the engine typecheck also passed after the final harness changes.
- Main Electron smoke and the new budget smoke passed. Reviewed the stopped-report screenshots at desktop and 720px, including $5.25 recorded against a $5 cap and a missing-usage warning.
- A mutation in a disposable source copy removed the per-attempt budget check; the paid-invalid-response regression failed with two requests instead of one, confirming that it detects the original retry gap.
- Independent review found and fixed SDK zero-filling of missing usage, scripted failures masked as unmeasured live criteria, and shared-allowance cancellation hiding the engine's stop reason. The harness retains an explicit allowance stop cause and accounts for attempts even if an observer fails.
- [Final scripted acceptance evidence](../engine/acceptance-results/verified-20261015/acceptance.json) verified 50 terminal episodes, 150 steps, peak 12 browser contexts, a real German browser environment, and matching reports after reopening both SQLite logs. This local artifact is retained in an ignored output directory. Live performance, cost and thought/profile quality remain `NOT_RUN`; setup model cost is zero because the fixture is authored.
- No paid calls were made. Live measurement remains pending local credentials and a recorded-spend allowance. See [the acceptance guide](../docs/m2-acceptance.md).

## M3 — friction pipeline and report

- [x] Commit the shared signal and survey event contract.
- [x] Gym v2: 25 defects, five visual-only, control mode.
- [x] Objective signal detectors and capture.
- [x] End-of-episode survey.
- [x] Themes: trust, grouping, judge merge, scoring, evidence, suggestions, what went well.
- [x] Export: HTML, JSON, PDF, Markdown.
- [x] Integrate, full checks, Electron verification, roadmap status.
- [ ] Live Gym v2 acceptance (recall, precision, stability, control run) once credentials and a spend allowance exist. Reduced-scale DeepSeek run on 16 October; full scale still open.

## M3 first-batch results — 15 October 2026

- Five worktree sessions (Gym v2, signals, survey, themes, export) merged into `m3-friction-report`. The estimate and lifecycle-test conflicts were resolved by keeping both the survey and the judge/author calls.
- Integration fix: report model calls ran after a projected-cost stop and spent past the cap ($1.10 against $1). Any run stop now skips them; the existing projected-cost regression caught it.
- `npm test`: 462 passing (347 engine, 62 Gym, 53 app), no failures or skips. Typecheck, app build, main smoke (19 stages, including export: HTML 93 KB, PDF 404 KB, JSON 9 KB, Markdown 6 KB for the smoke run), project smoke and profile smoke all passed.
- All model calls were scripted. M3 acceptance (recall, precision, stability, control run, 25 MB export for 50 personas with real screenshots) is unmeasured.

## M4 — social swarm and live graph

- [x] Commit the shared social contract and influence rule.
- [x] Social engine: rounds, follow graph, feed, socialiser, influence, injection.
- [x] Swarm graph and feed in the app.
- [x] Opinion spread report and homogeneity.
- [x] M4 acceptance runner (scripted rehearsal).
- [x] Integrate, full checks, Electron verification, roadmap status.
- [ ] Live M4 acceptance (influence audit, spread over five seeds, graph frame rate) once credentials and a spend allowance exist. Reduced-scale DeepSeek run on 16 October; full scale still open.

## M4 first-batch results — 15 October 2026

- Four worktree sessions (social engine, graph, spread report, acceptance) merged into `m4-social-swarm` without conflicts.
- Integration fixes: the M4 rehearsal now enables social rounds and scripts the socialiser, judge and author; the swarm smoke stage now checks the real scripted swarm run (enabled scrubber, follows in the inspector) instead of assuming no rounds; a readonly fixture type in a scripted-provider test.
- `npm test`: 518 passing (400 engine, 62 Gym, 56 app), no failures or skips. Typecheck, app build, main smoke (20 stages), project, profile and budget smokes passed. `perf:swarm`: 120 fps, p95 frame 9.3 ms, 200 personas, 10 POIs, 5,125 connections.
- Scripted M4 rehearsal: replay PASS; spread and influence audit NOT_RUN (scripted opinions never move); frame rate measured separately. All model calls were scripted.

## Low-cost live acceptance on DeepSeek — 16 October 2026

First live-provider runs, kept small to limit spend: DeepSeek routing (`deepseek-flash` navigator and socialiser, `deepseek-v4-pro` judge and author; text only, no screenshots), a subset of the frozen fixture, fewer seeds. **$0.80 recorded in total** across five runs, including two aborted ones; no attempt lacked usage except the timed-out judge below. Results are in `acceptance-results/2026-10-16-deepseek/` (ignored, local). Every review below was done by Claude (AI), not a human; the verdicts are recorded in each sheet with that label.

Runner additions: `--provider deepseek`, `--personas N` (a per-segment subset of the same fixture), `--seeds N`, and an `--m3` mode (Gym v2 seeds plus a control build, and a theme-mapping sheet). Criteria set for fifty people report their figures as `NOT_RUN` with a "Reduced scale" note.

- **M2, 4 personas plus the German probe ($0.08, 2.3 min).** Execution, population and replay PASS; all four episodes ended (2 reached their goal, 1 hit its patience-based 12-step budget, 1 abandoned at the Candidates placeholder). German browser PASS. German thoughts: the probe and the German recruiter thought entirely in German (AI review: pass). Profile adherence: 4 of 4 consistent with their frozen traits (AI review). Time, cost and 12 browsers: not measurable at 4 personas.
- **M3, 4 personas × 2 seeds plus control ($0.27).** First attempt stopped: the judge call took over the 60 s report timeout merging 48 groups, came back without usage, and the allowance halted the suite. Raised the judge and author timeout to 180 s; the rerun finished all three runs. AI theme mapping against the catalogue: precision 0.71 and 0.67 (target 0.7), high-severity recall 0.4 per seed (0.5 of the eight high defects a text-only model can see; found D03, D04, D13, D18, plus D12), top-ten overlap between the two seeds 0.83 (target 0.6). Evidence links PASS. **Control run FAIL:** 2 confirmed and 1 reported themes on the no-defect build. One confirmed theme was an unchecked checkbox the text-only navigator could not read (the snapshot marks only `[checked]`; the navigator prompt now says markers appear only when true). The other is the Candidates placeholder: the fixture's coordination goal ("review the candidate list") cannot be done in any Gym build, so it will keep producing a control-run theme until the goal or the Gym changes.
- **M4, 8 personas × 2 seeds with social rounds ($0.35, 9.8 min).** Scrubber replay PASS on both seeds. Influence audit: 6 edges sampled (the audit needs 50), 6 of 6 plausible (AI review), all in the injected complaint's thread. Spread reported FAIL (2/5 reach on both seeds), but at 8 personas everyone reaches everyone, so segment sizes decide it; the runner now reports spread as `NOT_RUN` below fifty personas.

Still open for full acceptance: the 50-person M2 targets, M3 at 50 personas and three seeds with a human mapping, M4 spread over five seeds and a 50-edge audit, and visual-only defects with a vision-capable navigator.

## M5 — more points of interest

- [x] Foundation: several typed POIs per project, eligibility, runner registry, assets store, app POI list (#15).
- [x] Gym v3: design frames and pricing copy with seeded defects and controls (#13).
- [x] Figma prototype spike and recommendation (#14).
- [x] Text POI and buyer segment (#19); static-design expectation loop (#16); competitor observe-only mode (#18); Figma frame import (#17).
- [x] M5 acceptance mode, scripted rehearsal (#20).
- [x] Integrate on `m5-more-pois`, full checks, Electron verification, roadmap status.
- [ ] Live M5 acceptance (buyer text on D28, frame mismatch on D26 over five seeds) with a vision-capable navigator once a spend allowance exists; Figma listing against a real file once a token exists.

## M5 first-batch results — 16 October 2026

- Eight worktree sessions in three waves merged into `m5-more-pois`. Conflicts were only in docs/pois.md, one POI test and three smoke files (bridge method list, stage order); no product code collided.
- `npm test`: 661 passing (515 engine, 71 Gym, 75 app). Typecheck passed. All ten app smokes passed: main, audience, projects, profiles, ui, providers, budget, completion, text and Figma (against the fixture API).
- `--m5` scripted rehearsal: finished at $0 with every live criterion NOT_RUN. All model calls were scripted; nothing was run against a live provider or a real Figma file.


## Decision-first simulation — 19 October 2026

- [x] Confirm approved six-part scope, additive contracts, feature branch and agent ownership.
- [x] Intent-first setup, fixed company requirements, canonical generated brief and comparison-aware audience prompts; focused config/form/writer regressions. Explicit apply preserves custom tasks until confirmed. Buyer/owner/workflow intent transitions update purpose or collection, require explicit ownership and preserve tasks/access.
- [x] Shared public research planner, criterion evidence packets and truthful source-review counts; collection/estimate regressions and legacy defaults.
- [x] Coverage-first scheduling, bounded complete-block reservations including one retry, outstanding-review protection and interruption/admission regressions.
- [x] Scoped buyer decisions, alternative conditions, exact outcome causes and at most three deduplicated decision-changing actions; inference and preference-only regressions.
- [x] Compact matrix, deduplicated source claims with complete provenance, and common Markdown/HTML/JSON decision projection; export citation regressions.
- [x] Integrate source-review progress and comparison-aware biography freshness; add `npm run smoke:research -w @gnomi/app` for local fictional sites and scripted models.
- [x] Update `docs/new_simulation.md` with setup, defaults/preservation, report reading, budgeting and limitations.
- [x] Final integrated verification: 848 full-suite tests, 30 final config/form regressions, workspace typechecks, app build, `smoke:research`, `smoke:comparison`, desktop/narrow export screenshots and claim-anchor checks. Independent review findings were fixed with regressions. Shared fixture: 20 saved personas, 4 source reviews, 8 judge calls, 14 total scripted calls; no paid models.

Branch: `codex/decision-first-simulation`. The earlier live-provider acceptance tasks above remain unchanged; scripted implementation checks do not establish live vendor performance or human purchasing validity.
