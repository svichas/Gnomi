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
