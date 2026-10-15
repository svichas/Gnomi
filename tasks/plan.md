# M2 roadmap gap closure — first implementation batch

The existing M0–M2 implementation covers the core run loop, login containment, audience generation, concurrency, costs and segment reports. This batch closes two missing M2 user flows before starting M3: country-aware personas and multiple projects.

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
