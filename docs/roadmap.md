# Gnomi — roadmap

*Status: founding draft, 2026-10-15. Companion documents: [idea.md](idea.md) (what and why) and [tech.md](tech.md) (how).*

## Principles

- **Thin vertical slices.** Every milestone is usable on its own and ends with a demo a designer can run. No milestone is "infrastructure only".
- **The first slice proves the core value.** One persona, one web POI, one goal, one real friction found on a demo app with a known defect.
- **Measure Gnomi as we build it.** The seeded-defect demo app ("the Gym") is built alongside the product from milestone 0, and every milestone adds defects to it and reports detection numbers.
- **Boring choices, few moving parts.** See the options tables in [tech.md](tech.md). The stack does not change between milestones; it is extended.
- **Sizing.** Design for 20–200 personas per run, 50 by default, and up to ~100k events per run. Nothing in the plan needs a server, a queue or a database beyond SQLite.
- **Reproducible means conditions, not actions.** Seeds fix the population, the goals and the settings, and the event log records everything; the models themselves are not deterministic (current Claude models expose no seed or temperature at all), so "the same run again" is measured as overlap, never asserted as identity.

Effort figures assume **two engineers** (one strong on TypeScript/Node and Playwright, one strong on React and data visualisation) plus a part-time designer. They are rough and include the Gym work and testing.

## Milestone map

```
M0 Walking skeleton ──► M1 Real staging apps ──► M2 Audience ──► M3 Friction pipeline & report ──► M4 Social swarm & graph
                                                      │                      │                              │
                                                      └──► M5 More POI types ◄┘                              │
                                                                               └──► M6 Reproducible runs & compare ◄┘
                                                                                                  │
                                                                                                  └──► M7 Ship to designers
```

| Milestone | Goal in one line | Effort (2 engineers) | Depends on |
|---|---|---|---|
| M0 | One persona finds one real friction on a demo app, end to end, in the app | 3 weeks | — |
| M1 | Works on the team's own staging app: login recorder, containment, tripwires | 3 weeks | M0 |
| M2 | A whole audience: segments, sampled personas, concurrency, cost meter | 4 weeks | M1 |
| M3 | Trustworthy report: objective signals, clustering, ranking, evidence, export | 4 weeks | M2 |
| M4 | The swarm: shared feed, social rounds, influence, live graph | 4 weeks | M3 |
| M5 | Text, static-design, competitor and Figma-frame POIs; buyer segment | 3 weeks | M2, M3 |
| M6 | Reproducible runs, before/after comparison, replay mode, email sink | 3 weeks | M3 (M4 for spread comparison) |
| M7 | Installers, signing, auto-update, first-run, onboarding; developer-product POI; published evaluation | 3 weeks | all |

Total: about 27 weeks of calendar time with two engineers, roughly seven months to a shippable 1.0. M5 can run in parallel with M4 if a third engineer joins.

## Implementation status — 15 October 2026

M0/M1 and the core M2 audience, concurrency, routing and segment-report flows are implemented. **M2 remains in progress; M3 has not started.** The current gap-closure work is tracked in [the implementation plan](../tasks/plan.md) and [task checklist](../tasks/todo.md).

The first M2 gap-closure batch adds:

- Country mixes and optional per-segment employer lists, deterministic sampling, and country/city/timezone/language/employer displays on persona cards and in the inspector.
- Persona-specific browser locale, timezone, ordered language preferences and `Accept-Language`; the navigator prompt requires thoughts in the persona's first language. The Gym's `/locale` page and a real-browser regression cover Germany → `de-DE`, `Europe/Berlin` and German-first language preferences.
- A local project home with create, open, rename, duplicate, delete to Trash and folder export. Duplicates carry configuration and personas; exports also carry run history and screenshots. Neither includes recorded logins or provider keys. Project switches refuse active runs, recording and pending project work; unsaved edits require Save, Discard or Cancel.

Country sampling currently uses one reference city per supported country (14 countries), not a demographic distribution within countries. Legacy personas retain their language and use UTC when no timezone was stored. Folder export is available; ZIP packaging and import remain M6.

The second gap-closure batch adds:

- A versioned profile schema and editor with protected core attributes, independent card/prompt/report switches, custom text/number/choice/boolean/list attributes, per-segment sampling rules and validated JSON templates. The shipped schema covers all eight profile groups, including decision role, tools and prior tools, work context and psychology; defaults are editable assumptions.
- Deterministic attribute sampling and biography freshness checks. Changed model inputs require refreshed prose; display-only edits reuse biographies, and private sampled fields refresh without a writer call. Disabled fields are excluded from profile output and model input. New runs freeze the schema and population; legacy logs remain readable.
- Profile dimensions in reports and Markdown, with completion, friction share and mean latest feeling by exact attribute value. Shared filters narrow report evidence, the persona roster and activity while keeping full-run totals explicitly labelled.
- Structured current opinions in the inspector: sentiment, self-reported confidence, likes, frictions and a link to the source step. The engine records changed snapshots from the existing navigator response, without an additional model call; old runs without opinions show an empty state.

The third batch adds:

- A recorded-cost check after every model attempt, including paid invalid outputs. At the cap, the engine cancels outstanding requests, suppresses retries and discards late answers before browser action dispatch. Already-started actions and late returned usage remain in the report.
- Recorded-cost labels and missing-usage notices in the live meter, report and Markdown export. Provider SDK defaults do not turn missing usage into a known zero charge. Unpriced models are blocked in preflight.
- An opt-in [M2 acceptance runner](m2-acceptance.md) with a frozen 50-person population, all Gym v1 defects, a German locale probe, retained transcripts/screenshots, report replay checks and evidence review sheets. Scripted rehearsals verify execution; they cannot pass live-provider criteria. The fixture excludes live persona-generation cost and quality.

The no-cost rehearsal verified 50 terminal episodes at peak concurrency 12, the actual German browser environment, and both report replays. All live-model criteria remain `NOT_RUN`; no paid calls were made. Verification details are in [the task results](../tasks/todo.md#third-batch-results--15-october-2026).

**Still required for M2:** live-provider acceptance measurements. On 15 October the user chose to preserve concurrency and stop immediately at the recorded cost cap: cancel outstanding requests and dispatch no further requests, retries or browser actions. Already-started browser actions may finish, and already-billable provider calls may exceed the cap. Late returned usage belongs in the report; calls without complete usage must be flagged as uncertain charges. This replaces the original ambiguous “within one step” budget rule below.

Scripted tests establish execution and persistence, not live-model detection quality, cost, completion time, profile adherence or language compliance. Default prior-tool lists are empty until configured, and language values represent ordered preferences rather than proficiency scores.

**M3 is in progress** on branch `m3-friction-report`, in parallel with the open M2 live measurements (deferred by the user on 15 October). The first batch adds:

- Objective signals (failed action, loop, backtrack, console/page/HTTP error, visible validation error, small mobile target) detected after every step and written to the log, with thresholds frozen in the run snapshot.
- An end-of-episode survey per persona and POI (sentiment, confidence, likes, frictions, would continue), answered by the navigator model, admitted like a step so stops and the cost cap prevent it, and shown in the inspector.
- The friction pipeline: candidates from self-reports, abandon reasons, survey frictions and signals; trust levels; deterministic grouping; a judge pass that merges and names themes, validated against group ids with deterministic fallback; segment-weighted scoring; evidence; labelled author suggestions; sentiment by segment; what went well; methods additions. Judge and author answers are logged, so the report still rebuilds from the log alone. Any run stop skips the report model calls.
- Report export as single-file HTML rendered from the report component with inlined thumbnails, PDF printed from that HTML, JSON and Markdown.
- Gym v2: D13–D25, five of them visual-only, with `v1` (D01–D12) and `none` (control) selections.

All M3 acceptance criteria (recall, precision, stability, control-run false positives) need live runs on Gym v2 and human theme mapping; none has been measured.

**M4 is in progress** on branch `m4-social-swarm`, stacked on M3. The first batch adds:

- Social rounds (off by default, a run setting with R rounds, default 5): usage slices that resume each episode, then a social phase. Also a seeded follow graph (6–12 follows, 70% within segment, 10% hubs), feeds of unseen followed posts plus two trending posts, one socialiser call per persona and phase (post, reply, react or stay silent) with opinion updates that cite feed posts, and harness-injected posts.
- A live swarm tab: Sigma 4 + Graphology with ForceAtlas2 in a worker, used/talked/influenced/friction edges coloured by segment, edge-type and round filters, a time scrubber rebuilt from the log, click-to-inspect, feed threads and social memory in the inspector. The frame-rate check measured 120 fps with 200 personas, 10 POIs and 5,125 connections under live inserts on a development Mac.
- Opinion spread in the report: posts tagged to themes in the judge call, seed posts, repeats, segments crossed, influence edges, sentiment by round, first-hand versus second-hand frictions, and post/narrative homogeneity in the methods appendix. Markdown and the HTML/PDF export include it.
- An M4 acceptance mode ([guide](m4-acceptance.md)): an injected complaint over five seeds, same- versus cross-segment spread, an influence audit sheet and a replay check. The scripted rehearsal passes replay; spread and the influence audit need live runs and stay `NOT_RUN`.

Live spread, influence plausibility and graph frame rate on a typical designer laptop are unmeasured.

---

## M0 — Walking skeleton: one persona finds one friction

**Goal.** Prove the core loop in the real app shell: a non-technical user adds a URL, a goal and a key, presses Start, watches a persona use the site, and reads a report that names a real friction.

**Scope.**

- Electron app with one window and three screens: Settings (one provider key, "Test key" button, key stored via the OS keychain), Project (one web POI by URL with a start page; one goal; one built-in persona profile), Run (live activity panel showing each step as an action line and a think-aloud line, Stop button, a minimal report at the end).
- Run engine as a library in a child process: Playwright launches the user's installed Chrome or Edge if present, otherwise a bundled Chromium; one browser context; the step loop (accessibility snapshot → structured action → execute → record event) with a 40-step budget.
- Actions: navigate, click, type, select, scroll, back, read, think-aloud, report friction, give up, done.
- SQLite event log (one project file), screenshots per step on disk.
- Report: list of self-reported frictions with step number, screenshot and quote; cost and duration.
- Gym v0: a small demo "ATS-like" web app with three catalogued defects (a mislabelled primary button, a required field with no error message, a dead link in the main navigation) and a defect catalogue file.
- Automated check that the LLM transcript never contains the strings used in the Gym's login (there is no login in M0, so this is the harness only).
- Engine seams for a future cloud runner, cheap now and expensive later: the secrets store, blob store and transport behind interfaces, no Electron imports in the engine (enforced by a lint rule), and the headless entry point stubbed. See [tech.md](tech.md#16-cloud-readiness).

**Out of scope.** Segments and multiple personas, social feed, graph, login recorder, containment, objective friction signals, export, installers.

**Acceptance criteria.**

- From a dev build, a designer goes from launch to report without a terminal, config file or code.
- On Gym v0, the persona reports at least one of the three seeded defects in at least four of five runs with the default cheap model.
- A run of 40 steps costs under $0.50 and finishes in under 5 minutes on a laptop.
- The activity panel shows each step within one second of it happening.
- Every event in the run is in the SQLite log and the report is generated only from the log (deleting the in-memory state and regenerating gives the same report).

**Demo script.** Open Gnomi → Settings → paste a key → Test (green) → New project "Gym" → paste the Gym URL, mark start page → goal "Post a job for a backend engineer" → Start → watch the persona navigate, type, hit the field with no error message, report friction → read the report with the screenshot.

**Risks.** The step loop quality with a cheap model (mitigated by pruning the snapshot and giving the model element references). Electron plus Playwright packaging surprises (mitigated by spiking the packaging in week 1, not week 3).

---

## M1 — Real staging apps: login recorder and containment

**Goal.** Run safely against the team's own staging app, with roles, without Gnomi ever seeing a password and without anything leaking out of staging.

**Scope.**

- Login recorder: Gnomi opens the site in a visible, persistent browser context; the user logs in by hand (including SSO, MFA and any CAPTCHA), marks the start page, and Gnomi saves the session state per role, encrypted on disk. Sessions show their last-verified time; "Re-record" is one click.
- Session check before a run (loads the start page, confirms it is not redirected to a login page) and mid-run expiry detection (redirect to login, or a 401/403 pattern) which pauses the affected personas and asks the user to re-record.
- CAPTCHA and bot-protection detection during a run: the step fails with a `blocked` event, the persona pauses, the user is told. No bypass attempts, ever.
- Credential guards: password values stripped from snapshots, password fields masked in screenshots, and typing into a password field refused by the action layer.
- Containment: per-POI allowed hosts (the POI origin plus the hosts the user ticks from a list Gnomi builds by observing the recorder session); every other request is blocked at the browser and logged; the pre-run summary shows the list; the report's methods appendix lists blocked requests.
- Production tripwires: a confirmation is required when the host has no staging-like marker; a run is halted when a page contains a live payment-provider key pattern or when the host matches a domain the user listed as production.
- Reset hook: an optional URL the engineer provides that Gnomi calls before each run (with a confirmation in the UI) to reset staging data.
- Per-persona browser contexts (cookie isolation) from the recorded session.

**Out of scope.** Multiple personas per role beyond cookie isolation, email sinks, HAR replay, payments test-mode helpers.

**Acceptance criteria.**

- A run against a real staging app behind login and SSO completes using recorded sessions, with no credential ever present in the LLM request log (automated check over the stored request/response log for the strings entered during recording: the recorder never sees them either, because the human types into the browser, not into Gnomi; the check is a belt-and-braces test).
- A HAR of the run contains zero requests to hosts outside the allowed list.
- Expiring a session mid-run (delete the cookie in the staging app) pauses the persona and shows the re-record prompt; after re-recording, the persona resumes.
- A page containing `pk_live_` halts the run with an explanation.

**Demo script.** Add the team's staging URL → recorder opens → log in via Google SSO with MFA → mark start page → Gnomi lists observed hosts, user ticks the CDN → Start → the persona works inside the logged-in app → open Methods: blocked requests to the analytics and email providers are listed.

**Risks.** Apps that bind sessions to device fingerprints or rotate tokens aggressively (document as a known limitation; the pause-and-re-record flow is the fallback). Staging sites behind bot protection that blocks headless-looking browsers (use headed browsers and the user's own Chrome channel; still never bypass).

---

## M2 — Audience: segments, personas, concurrency, cost

**Goal.** Run a realistic population, in proportions the team controls, and see what it costs.

**Scope.**

- Audience builder: one product sentence plus the POIs → proposed segment cards with share sliders that renormalise to 100%, role mapping to recorded sessions, frequency, device mix, patience and tech-skill ranges, account state, typical goals, goal override, and an optional employer list the segment's personas are spread across.
- Project home with any number of projects (create, open, rename, duplicate, export, delete), each its own folder.
- Persona sampling: a seeded random generator draws the complete profile from segment ranges (identity with country, city, timezone and languages from the country mix; work with employer and decision role; capability with prior tools; context; psychology; intent); model calls write the biography, voice and goal interpretation; persona cards with edit, regenerate, add, remove; 1–200 personas per run, preferring three per active segment when the requested total allows it. See [persona generation](persona-generation.md) for the current call flow.
- Each persona's browser context is created with its locale, timezone, languages and device, so the product under test behaves as it would for a user in that country.
- Profile-attributes editor: the default schema with attributes that can be switched off (except the core the engine needs), custom attributes with a type, description, per-segment sampling rule and the prompt and report-dimension flags, and save or load as a template.
- Concurrency: 8–16 personas in flight with a browser context each; a scheduler that keeps the cost meter and budget authoritative.
- Cost meter and budgets: live spend from provider usage fields; pre-run estimate; stop rules (budget, wall clock, per-persona step budget).
- Persona inspector: profile, step timeline with screenshots, current opinions.
- Report: per-segment completion and self-reported frictions, weighted by share.
- Model routing settings: navigator, socialiser, persona writer, judge and author roles, with provider defaults; support for Anthropic, OpenAI, Google and any OpenAI-compatible local endpoint.
- Gym v1: 12 catalogued defects, each tagged with the segments it should affect and a severity.

**Out of scope.** Social rounds, graph, objective friction signals, clustering.

**Acceptance criteria.**

- 50 personas complete a Gym v1 run in under 30 minutes with 12 concurrent browsers and under $5 on the default routing (the cost model in [tech.md](tech.md#104-cost-model) puts the reference run at about $3.60 without caching and about 20–25 minutes at this concurrency).
- Regenerating the audience with the same seed gives the same personas; changing a share changes the persona counts and the weighted report.
- Sampled populations are diverse: no two personas share name and background; the diversity check reports pairwise similarity and warns above a threshold.
- A persona with country Germany reaches the Gym's locale echo page with a German locale, Berlin time and German first in `Accept-Language`, and its thoughts in the activity panel are in German.
- Switching an attribute off removes it from cards, prompts and the report; adding a custom choice attribute with per-segment shares produces those shares across 50 personas within sampling error, and it appears as a filter in the report.
- As soon as recorded spend reaches the cost cap, the run cancels outstanding model requests and starts no further requests, retries or browser actions. Already-started browser actions may finish. The run still produces a report containing all returned usage and flags calls with incomplete usage; the cap is a cancellation threshold, not a guarantee of final provider charges under concurrency.

**Demo script.** Type "An ATS for 50–2,000-employee companies" → five segment cards appear → drag recruiters to 60% → open Hiring managers → regenerate one persona → Start → watch 12 personas in parallel → the cost meter climbs → open a persona mid-run.

**Risks.** Provider rate limits at 12–16 concurrent agents (mitigated by a token-bucket limiter per provider and an adaptive concurrency setting). Persona homogeneity even with sampling (mitigated by the diversity check and by writing voices from sampled traits).

---

## M3 — Friction pipeline and a report worth sharing

**Goal.** Turn raw events into a ranked, evidenced, exportable report that a designer would paste into a design review.

**Scope.**

- Objective signals computed from the event log: failed actions (element missing, click with no effect), loops (same page state revisited), backtracking (repeated back navigation), step and time budget exhaustion, console and HTTP errors, visible validation errors.
- Trust levels (confirmed, observed, reported) from combining self-reports and signals.
- End-of-episode survey per POI (structured: sentiment, confidence, top likes, top frictions, "would you continue using this").
- Clustering of frictions into themes (deterministic grouping by POI, page and element first, then a model pass to merge and name themes), ranking by segment-weighted affected share × severity × trust.
- Evidence attachment: step, screenshot, quote, personas affected by segment.
- Suggested change and possible solution per theme, generated by the report model and labelled as suggestions.
- "What went well" section, methods appendix, hypothesis banner.
- Export: self-contained HTML, Markdown, JSON; PDF via the browser's print-to-PDF.
- Gym v2: 25 catalogued defects, including five visual-only defects (contrast, hidden affordance) that need the screenshot path.

**Out of scope.** Social spread section, comparison between runs.

**Acceptance criteria.**

- On Gym v2, with 50 personas and three seeds: recall of high-severity defects ≥ 0.6, precision of reported themes ≥ 0.7 (a theme is a true positive when a human maps it to a catalogued defect), test-retest overlap of the top ten themes across seeds ≥ 0.6 (Jaccard).
- A control run on the Gym with all defects switched off produces no "confirmed" themes and at most two "reported" ones.
- The HTML export opens offline, with screenshots, in any browser, and is under 25 MB for a 50-persona run.
- Every theme in the report links to at least one event in the log.

**Demo script.** Run Gym v2 → open the report → top friction shows trust "confirmed", two screenshots, three quotes, the affected share by segment → export HTML → open the file on another machine.

**Risks.** Theme clustering that merges distinct problems or splits one (mitigated by the deterministic first pass and by showing the member frictions). Over-confident suggested changes (labelled, and evaluated for usefulness in the evaluation plan).

---

## M4 — The social swarm and the live graph

**Goal.** Make opinions spread, show it live, and report what travelled and what stayed local.

**Scope.**

- Swarm feed: posts, replies and reactions; one feed per run; threads.
- Follow graph sampled per run: mostly within segment, some cross-segment, a few hubs; deterministic from the run seed.
- Social round after each episode slice: each persona reads a bounded view of the feed (followed personas plus trending) and posts, replies, reacts or stays silent, with silence being common.
- Influence attribution: after reading, a persona updates its opinion record and cites the posts that changed it; an influence edge is created only when the opinion actually changed.
- Swarm graph: live force-directed view with persona and POI nodes, used/talked/influenced/friction edges, colour by segment, filter by edge type and round, time scrubber, click-to-inspect.
- Report section "opinion spread" per POI: seed posts, repeat counts, segments crossed, round-by-round sentiment line; first-hand versus second-hand frictions.
- Homogeneity metric for the run (how similar the posts are) shown in the methods appendix.

**Out of scope.** Direct messages, personas following the team's real social accounts, multi-run social memory.

**Acceptance criteria.**

- The graph stays interactive (pan and zoom above 30 frames per second) with 200 personas, 10 POIs and 5,000 edges while a run is live.
- In a judge audit of 50 sampled influence edges, at least 80% are plausibly attributed to the cited post.
- A seeded "complaint" post injected by the test harness spreads to more personas in the same segment than in other segments, in at least four of five seeds.
- The time scrubber replays any round from the event log alone.

**Demo script.** Start a 50-persona run → the graph fills by segment colour → a recruiter's complaint thread appears in the feed → influence edges fan out from that persona → scrub back to round 1 and forward → open the report's spread section.

**Risks.** Herding: the swarm converging on one opinion (mitigated by the sparse graph, silence as a default, and showing influence explicitly). Graph performance with live updates (mitigated by batching events into the graph every 250 ms and using WebGL rendering).

---

## M5 — More points of interest

**Goal.** Judge things that are not yet a web app: copy, static designs, Figma frames and competitor sites, and add the buyer segment.

**Scope.**

- Text POI: paste or drop; read-and-rate flow; buyer segment (perception-only personas with their own survey).
- Static-design POI: single image or ordered frame sequence; the "expectation" loop (what do you see, what would you do, now see the next frame, did it match); needs a vision-capable model; evidence is the frame plus the quote.
- Competitor POI: a web POI in observe-only mode (no form submission, rate-limited, `robots.txt` respected), compared in the survey.
- Figma frames: file or frame link plus a personal access token (Dev or Full seat) in settings; frames exported as images into a static-design POI.
- Spike: a simulated Figma prototype rebuilt from the file's interaction data (starting points, hotspots, destinations), to decide whether it ships in M7. Figma's own prototype viewer is never automated.
- Gym v3: a set of design frames with seeded defects (an ambiguous icon, a step that does not follow from the previous one) and a copy sample with a seeded contradiction between pricing tiers.

**Out of scope.** Shipping the simulated Figma prototype (spike only), developer-product POIs, native mobile.

**Acceptance criteria.**

- A pricing-page run with a buyer segment produces a per-segment sentiment and a ranked list of confusions with quotes.
- A frame-sequence run catches the seeded expectation mismatch in at least four of five seeds.
- Figma import lists frames within ten seconds for a file with 50 frames and handles token errors with a clear message.

**Demo script.** Drop six PNGs of a checkout flow → order them → Start with 20 personas → open the report: frame 4 has "expected a confirmation, saw a login prompt" from 14 personas.

**Risks.** Vision-model cost per frame (mitigated by downscaling and by only sending the current and previous frame). Figma API rate limits and seat requirements (documented in the setup screen) and a Developer Terms clause that needs a legal read before commercial release.

---

## M6 — Reproducible runs, comparison, replay mode

**Goal.** Compare before and after a change, share a project, and test front ends whose backend the team does not control.

**Scope.**

- Run history per project; duplicate a run (same personas, seeds, goals, models) against a new build; "rerun this persona" from the inspector.
- Compare view between two runs: themes fixed, new, unchanged; sentiment deltas by segment; spread deltas.
- Project export and import as a zip (database, screenshots, settings minus keys).
- Replay mode: record a human session through the recorder as a HAR, then run personas with network replay; unmatched requests are reported; the report marks the run as replayed.
- Observe-only mode for any web POI.
- Email sink integration: configure a Mailpit URL; personas with a sink address can complete email-verification steps by Gnomi fetching the link from the sink; the link is visited by the browser, not read into the prompt beyond what the persona needs.

**Out of scope.** Hosted sharing, CI integration, automatic staging reset beyond the reset hook.

**Acceptance criteria.**

- Duplicating a run and executing it on the same build gives the same personas and a top-ten theme overlap of at least 0.6 (model nondeterminism bounds this; the figure is revisited with evidence).
- The compare view on Gym v2 with three defects fixed shows exactly those three as fixed.
- Replay mode runs a persona through a recorded flow with zero outbound requests to the real backend.
- A zipped project imports on another machine and opens the report without network access.

**Demo script.** Fix a defect in the Gym → deploy → duplicate the last run → Start → Compare: the defect is listed as fixed; a new one appears because the fix moved a button.

**Risks.** Non-deterministic backends and anti-replay tokens breaking HAR replay (documented; replay mode is labelled as limited). Model nondeterminism making "reproducible" a range rather than a point (addressed by seeds, low temperature for navigation, and reporting the overlap).

---

## M7 — Ship to designers

**Goal.** A signed, auto-updating app a designer installs in two minutes, plus the developer-product POI and a published evaluation.

**Scope.**

- Installers for macOS (signed and notarized) and Windows (signed); Linux AppImage without signing; auto-update channel; first-run flow (detect installed Chrome or Edge, otherwise download Chromium with progress); crash reporting opt-in only.
- Onboarding: a sample project (the Gym) preloaded so the first run needs only a key.
- Developer-product POI: OpenAPI spec, README or docs, optional sandbox base URL; technical personas plan and make sample calls through the containment layer; developer-experience survey.
- Performance and robustness pass: 200-persona runs, long-run memory, resume after app restart.
- Published evaluation: detection numbers on the Gym by model tier, and the human-agreement study results.

**Out of scope.** Hosted features, native mobile, the simulated Figma prototype (unless the M5 spike succeeded), CI mode.

**Acceptance criteria.**

- A new user on a clean machine installs, adds a key, and gets the Gym report in under 15 minutes without help.
- Auto-update delivers a new version without reinstalling.
- A 200-persona run completes and the app's memory stays under a set budget; killing the app mid-run and reopening resumes or finalises the run from the event log.
- The evaluation page reports recall, precision, stability and human agreement with dates and model versions.

**Demo script.** Download → install → open → paste key → Run the sample → report in under 15 minutes.

**Risks.** Code-signing lead time (start the developer accounts in M0). Chromium download size on slow connections (prefer the installed browser).

---

## Deliberately deferred

| Item | Why deferred | Earliest |
|---|---|---|
| Native mobile apps as POIs | Needs a simulator-driving stack and a different perception model; most early users test web flows | after 1.0 |
| Simulated Figma prototype (rebuilt from the file's interaction data) | Frame export covers most of the value; the interaction rebuild needs a spike | M5 spike, ship in M7 if it works |
| Driving Figma's prototype viewer live | Not planned: Figma's terms do not permit programmatic access and the viewer has no accessibility tree | never |
| Headless/CLI and CI integration | Engine is a library from M0 so this is cheap later; designers come first | after 1.0 |
| Hosted report sharing | Conflicts with local-first; zip export covers teams for now | after 1.0 |
| Cloud runner: the same engine in a container job, WebSocket transport, run folders in object storage, per-run key injection, a tunnel client for private staging, egress proxy per job | Local-first is the wedge and needs no server; the M0 seams make this additive rather than a rewrite; sharding across machines waits until one job is not enough ([tech.md](tech.md#16-cloud-readiness)) | after 1.0; about 4–6 weeks for a single-job runner, several months for a multi-tenant service || Per-persona accounts created automatically | Needs app-specific sign-up automation; namespacing created objects within a shared role account covers v1 | after 1.0 |
| Screenshot PII redaction | Staging data is the team's; add when teams ask | after 1.0 |
| Local models tuning | Supported via OpenAI-compatible endpoints from M2, but navigation quality with small local models is unproven | ongoing |
| Multi-language UI | Personas already speak the user's languages; the app UI is English first | after 1.0 |
| "Launch recipes" to start an app from source | Users never see code; pointing at a running app is enough for v1 | after 1.0 |

## Success metrics for Gnomi

Product metrics (measured in the app, opt-in, or in interviews):

- **Time to first report** for a new user: under 30 minutes with a staging app, under 15 with the sample.
- **Runs per project per month**: teams that iterate (duplicate and compare) are the ones getting value; target a median of 4.
- **Confirmed findings**: in follow-up interviews, the share of a report's top five frictions the team confirmed with real users or fixed; target 50% confirmed, under 20% judged wrong.
- **Cost per run** on the default routing: under $5 for 50 personas, under $20 for 200.
- **Setup friction**: share of projects that reach a first run after adding a web POI; target 80%.

Quality metrics (measured on the Gym, every release):

- **Recall** of catalogued high-severity defects, per model tier.
- **Precision** of reported themes.
- **Segment attribution accuracy**: a defect tagged for hiring managers is reported mainly by hiring-manager personas.
- **Stability**: top-ten overlap across three seeds.
- **False-positive rate** on the no-defect control run.
- **Human agreement**: overlap with a real usability study on the same build.

## Evaluation plan

**The Gym.** A deliberately flawed demo ATS, built alongside Gnomi, with a defect catalogue:

```yaml
- id: D07
  title: Assigning a non-user hiring manager leaves the job form and loses the draft
  type: flow        # flow | label | affordance | error-handling | performance | visual | content
  severity: high
  pages: [jobs/new, settings/users]
  affects: [recruiter, admin]
  visual_only: false
  toggle: FLAG_D07
```

Every defect has a feature flag, so the same app can run with any subset of defects on, including none (the control run). Defects are added in each milestone (3 → 12 → 25 → 25 plus design frames and copy). The recipe follows the one public seeded-defect usability benchmark, uxWeb ([arXiv 2604.26020](https://arxiv.org/abs/2604.26020)): inject violations of one design principle per variant, keep the plain build as the control, and score detection as a classifier. Its reported numbers set expectations: frontier models reached a known-defect AUC of about 0.44–0.52 and a verified critique precision near 70%, and designers themselves agreed only weakly on severity (Krippendorff's α ≈ 0.31), so Gnomi's human-agreement figures will have a low ceiling and should be read against it.

**Metrics.**

- A report theme is a *true positive* when a human rater maps it to a catalogued defect that is switched on, a *false positive* otherwise; a defect is *found* when at least one theme maps to it with trust "confirmed" or "observed".
- Recall = found defects ÷ switched-on defects, reported overall and for high severity.
- Precision = true-positive themes ÷ all themes in the report's top 20.
- Stability = Jaccard overlap of top-ten theme sets across three seeds with everything else fixed.
- Segment attribution = share of a defect's affected personas that belong to its tagged segments.
- False-positive rate = themes in the control run with trust confirmed or observed; also reported as the false-discovery rate (control-run themes ÷ all themes across control and defect runs).
- Discrimination = AUC of a run's overall friction score at separating defect-on from defect-off builds, the uxWeb headline metric.
- Abandonment rate per segment and per task, because "never walks away" is the best-documented failure of simulated users.
- Repair lift (optional, from UXBench): whether a fixed repair prompt applied to the Gym with a theme's suggested change improves the next run's score for that defect.
- Cost and time per run are recorded with each number.

**Judge calibration.** Where a model maps themes to defects or rates severity, a different model family from the one that ran the personas is used, pairwise comparisons are run in both orders and only consistent verdicts accepted, and the judge is calibrated once per release against a 100-item human-labelled set with Cohen's κ reported before its numbers are trusted.

**Human agreement.** Once per major release, run a small moderated usability study (five to eight participants per key segment) on the Gym build and on one partner team's staging app, and report the overlap between human findings and Gnomi's top ten. This is the only metric that tests the central assumption, so it is funded as product work, not as a side project.

**Model matrix.** Each release's numbers are reported for the default cheap navigation model, the default strong judgement model, and one local model, so users can see what they trade off when they change routing.

**Regression.** The Gym runs in continuous integration on every merge with a fixed seed and a small population (10 personas); a drop in recall or a rise in false positives beyond a threshold blocks the release. Because the system is non-deterministic, the gate is a rolling window over three runs, not a single run.
