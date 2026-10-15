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
- [ ] Run live-provider measurements and review German thoughts/profile adherence once local credentials and a recorded-spend allowance are available. Frozen-fixture browsing does not close live persona-writer quality acceptance.

## Third-batch results — 15 October 2026

- Full suite: 394 tests passed (302 engine, 44 Gym, 48 app), no failures or skips. Final acceptance review added one regression; all five acceptance tests then passed. Full typecheck and production app build passed; the engine typecheck also passed after the final harness changes.
- Main Electron smoke and the new budget smoke passed. Reviewed the stopped-report screenshots at desktop and 720px, including $5.25 recorded against a $5 cap and a missing-usage warning.
- A mutation in a disposable source copy removed the per-attempt budget check; the paid-invalid-response regression failed with two requests instead of one, confirming that it detects the original retry gap.
- Independent review found and fixed SDK zero-filling of missing usage, scripted failures masked as unmeasured live criteria, and shared-allowance cancellation hiding the engine's stop reason. The harness retains an explicit allowance stop cause and accounts for attempts even if an observer fails.
- [Final scripted acceptance evidence](../engine/acceptance-results/verified-20261015/acceptance.json) verified 50 terminal episodes, 150 steps, peak 12 browser contexts, a real German browser environment, and matching reports after reopening both SQLite logs. This local artifact is retained in an ignored output directory. Live performance, cost and thought/profile quality remain `NOT_RUN`; setup model cost is zero because the fixture is authored.
- No paid calls were made. Live measurement remains pending local credentials and a recorded-spend allowance. See [the acceptance guide](../docs/m2-acceptance.md).

## M3 — friction pipeline and report

- [x] Commit the shared signal and survey event contract.
- [ ] Gym v2: 25 defects, five visual-only, control mode.
- [ ] Objective signal detectors and capture.
- [ ] End-of-episode survey.
- [ ] Themes: trust, grouping, judge merge, scoring, evidence, suggestions, what went well.
- [ ] Export: HTML, JSON, PDF, Markdown.
- [ ] Integrate, full checks, Electron verification, roadmap status.
- [ ] Live Gym v2 acceptance (recall, precision, stability, control run) once credentials and a spend allowance exist.
