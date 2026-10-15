# M2 roadmap gap closure

The existing M0–M2 implementation covers the core run loop, login containment, audience generation, concurrency, costs and segment reports. The first batch closed two missing M2 user flows before starting M3: country-aware personas and multiple projects. Subsequent slices below cover configurable profiles and current opinions.

## Decisions

- Extend the saved profile and audience additively. Existing projects and event logs remain readable; country sampling is opt-in for legacy audiences.
- Country choices determine city, timezone and ordered browser languages. Separate seeded draws preserve existing trait sampling. The navigator is instructed to think in the persona's first language.
- Keep project folders local, provider keys outside them, and recorded logins out of duplicates and exported copies. Project actions are unavailable during work that could write into the wrong project.
- Use existing React components and the current Electron/engine boundary. No new framework or server.
- Export a portable project folder in this batch. ZIP import/export is still M6 work.

## Agent ownership and order

1. Engine agent: shared locale types, deterministic sampling, writer/prompt integration, browser options and focused tests.
2. App agent: project home, bounded main-process project operations, bridge and tests.
3. Verification agent: Gym locale echo and real-browser German locale regression.
4. Coordinator: country/employer controls, persona cards/inspector, integration, smoke checks, review and roadmap status.

The engine contract precedes profile UI integration. Project operations are independent of locale work. Integrated checks follow both implementations.

## Acceptance and verification

- A saved audience can select a country mix and per-segment employers; sampled profiles remain deterministic and appear in cards and inspector.
- A German persona reaches the Gym with German locale and Accept-Language, Berlin timezone and German first in browser languages. The prompt asks for German thoughts; scripted tests do not claim live-model compliance.
- Users can create, open, rename, duplicate, delete and export local projects without mixing project data or copying recorded credentials.
- Focused tests, `npm test`, `npm run typecheck`, app build and the scripted Electron smoke pass. No paid model calls are required.

## Remaining M2 work after this batch

- Configurable profile schema, custom attribute sampling, templates, report dimensions, and remaining full-profile traits.
- Structured current opinions in the inspector.
- Live-provider quality, cost/time and native-language acceptance measurements; reconcile the budget overshoot acceptance with concurrent in-flight calls.

See `tasks/todo.md` for progress and `docs/roadmap.md` for the product roadmap.

## Second batch — configurable profile attributes

The next slice adds a versioned, saved profile schema, preserving legacy projects and event logs. Core engine attributes cannot be disabled; every other attribute has independent card, model-input and report-dimension switches. Custom text, number, choice, boolean and list values use validated fixed, range or weighted-choice rules, with segment overrides and independent seeded sampling. JSON templates travel through the browser file picker and download flow.

The engine agent owns schema defaults/validation/projections, sampling, biography freshness and model prompts. The app agent owns the editor, templates, cards and inspector. The report agent owns frozen-schema aggregation and filters across reports and activity. The coordinator owns shared types, engine save/run boundaries, immutable run snapshots, persistence checks and integration review.

Model-input changes require refreshed biographies before a run. Card/report-only edits do not spend another writer call. New runs freeze a complete schema alongside their population; old logs without a schema keep their previous report shape. Disabled fields are excluded from profile views and model inputs, and stale prose is hidden until generation is refreshed.

Acceptance: valid templates round-trip; malformed templates and weakened core fields are rejected; 50 seeded personas follow custom per-segment choice shares within sampling error; disabled defaults disappear from cards/inspector/prompts/reports; custom dimensions filter persona and friction evidence; later project edits do not change an existing run. Focused regressions, full tests/typecheck/build and Electron profile smoke verify the integrated slice without paid calls.

## Following slice — current opinions

Add a bounded optional opinion snapshot to the existing navigator response: sentiment, confidence, likes and frictions. When it changes, record `persona.opinion_changed` with the prior value and a causal step sequence. Fold the log to display the current opinion for each POI in the inspector, with a link back to the evidence. Legacy responses/logs remain readable; absent opinions are shown as absent, never inferred from step feeling. This adds no model call. Social influence and the end-of-episode survey remain M4 and M3 respectively.

## Third batch — budget enforcement and live acceptance

The user selected finishing M2 before M3 and explicitly chose to retain concurrency: cancel immediately at the recorded cap and report uncertain in-flight charges. Check recorded spend after every provider attempt, including invalid outputs, and prevent further requests, retries or browser actions once the budget stop is raised. Already-started browser actions may settle and remain logged. Preserve late usage in the final report and distinguish recorded cost from incomplete provider usage; the threshold does not promise a strict final provider bill.

The engine agent owns gateway/scripted per-attempt notifications, cancellation, scheduler integration and regressions. The app agent owns recorded-cost presentation and missing-usage aggregation/export. The acceptance agent owns a dedicated opt-in runner and evidence checks. The coordinator owns shared interfaces, documentation, integration review and full validation.

The acceptance runner retains its manifest, project/event log, report and evidence. Scripted runs verify the harness but cannot satisfy live-model criteria. Setup and navigation costs/times are separated. Language/profile compliance and defect recall require evidence review. Live execution requires configured local credentials and an explicit spending allowance; available environment keys are currently absent.
