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

# M3 — friction pipeline and report

M2 stays open only for live-provider measurements, which need local credentials and a spending allowance. M3 starts in parallel on branch `m3-friction-report`. The shared event contract (`signal.*` payloads with `SignalBase`, `persona.survey`) is committed first in `engine/src/types.ts`; each agent works in its own worktree cut from that commit, and the coordinator merges.

## Agent ownership

1. Gym v2 agent (`gym/`): 25 catalogued defects including five visual-only ones, every defect behind a flag, all-off control mode.
2. Signals agent (`engine/src/signals/`, browser capture, step hook): detectors from tech.md §8.1 written synchronously after each step, thresholds frozen in the run snapshot.
3. Survey agent (episode end, prompt, estimate, inspector): one structured `persona.survey` per persona and POI after the episode.
4. Themes agent (`engine/src/report/`, report UI): candidates, trust, deterministic grouping, judge merge, scoring, evidence, author suggestions, what went well, methods appendix.
5. Export agent (app main process, export module): single-file HTML from the report components, JSON, PDF via `printToPDF`, Markdown.

Overlaps to expect at merge: `agent/loop.ts` (2, 3), `llm` estimates (3, 4), `Report.tsx` (4, 5). Live recall/precision/stability acceptance needs paid runs; scripted and pure-function tests establish behaviour only.

# M4 — social swarm and live graph

M4 builds on the M3 branch (PR #3) as branch `m4-social-swarm`. The shared contract is committed first: `run.round_started|ended` (the envelope's `round`), `social.feed_viewed`, `social.post` (a reply is a post with `parent_id`, unlike tech.md's separate `social.reply`; `injected` marks harness posts), `social.reaction` (agree | disagree), `persona.created.follows`, `Persona.posting_propensity`, `RunConfig.injected_posts`, and the shared influence rule `engine/src/social/influence.ts`.

## Agent ownership

1. Social engine agent (`run.ts`, `agent/`, `engine/src/social/` except `influence.ts`, settings, estimate, scripted provider): rounds of usage slices and social phases, follow graph, feed selection, socialiser prompt and schema, opinion updates with cited posts, injected posts, cost/stop behaviour.
2. Graph agent (app swarm tab, `engine/src/graph/`): projection, Sigma/Graphology live view, filters, scrubber, click-to-inspect, feed threads, social memory in the inspector, a 200-persona performance check.
3. Spread report agent (`engine/src/report/`, `Report.tsx`): opinion spread per POI, posts tagged to themes in the judge call, first-hand versus second-hand frictions, homogeneity in the methods appendix.
4. Acceptance agent (`engine/src/acceptance/`, docs): M4 mode with an injected complaint over five seeds, within- versus cross-segment spread, influence-edge audit sheet, scrubber replay check; scripted rehearsal only.

Overlaps to expect at merge: the scripted provider (1, 3), `Report.tsx`/`App.tsx` navigation (2, 3), estimate (1, 3). Live acceptance (influence audit, spread over seeds) needs paid runs.
