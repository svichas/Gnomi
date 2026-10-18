# Current simulation: implementation snapshot

**Snapshot:** 18 October 2026, source revision `9e383901046046eb9d6e06853f3a0aaf86504a4b`. **Historical:** this describes the engine before the move; the code now lives under `simulation/` (see [new_simulation.md](new_simulation.md)), so the `engine/` links below name the old locations and revision.

This document describes the implementation at that revision, including its limits. It is the baseline for the proposed [new simulation](new_simulation.md). It does not make the proposed architecture or validation requirements current behavior. Some older sections of [tech.md](tech.md) describe intentions; the source links below are authoritative for this snapshot.

## Purpose and meaning of a result

Gnomi runs synthetic personas against a product, copy, or design, lets those personas exchange experiences, and produces evidence-linked hypotheses about usability and adoption. The model supplies decisions and self-reports; code controls scheduling, allowed actions, budgets, feeds, and persistence.

The simulation combines three processes:

1. **Population construction:** sample configured traits, then ask a model to write individual personas.
2. **Experience and discussion:** alternate product-use slices with social phases, when social mode is enabled.
3. **Analysis:** combine recorded behavior, model reports, and heuristic signals into a report.

A synthetic sentiment, confidence value, completion rate, or influence edge is not a measured human response. The report already labels its findings as hypotheses requiring real-user validation. See [report/build.ts](../engine/src/report/build.ts).

## Existing boundary and dependencies

The simulation already lives principally in the `@gnomi/engine` TypeScript workspace. Electron starts [engine/src/host.ts](../engine/src/host.ts) in a separate `utilityProcess`; the renderer and main process exchange typed request/response messages and events through MessagePorts. The engine has no Electron imports and can also run through its Node CLI.

This is process isolation within the desktop application. It is not an independently deployed service with a versioned network API, durable job queue, or worker recovery protocol. The host also manages projects, audience generation, imported assets, Figma, login sessions, and model credentials. Simulation responsibilities are therefore broader than a small independent service.

| Area | Current owner |
| --- | --- |
| Desktop process launch and engine lifetime | [app/src/main/index.ts](../app/src/main/index.ts) |
| Application-facing commands and events | [protocol.ts](../engine/src/protocol.ts), [host.ts](../engine/src/host.ts) |
| Run scheduling, social phases, stop and budget handling | [run.ts](../engine/src/run.ts) |
| Interchangeable storage, browser and model interfaces | [seams.ts](../engine/src/seams.ts) |
| Web, text and design execution | [poi/index.ts](../engine/src/poi/index.ts) and its runners |
| Shared application/run/event/report data | [types.ts](../engine/src/types.ts) |

The engine currently depends on the Vercel AI SDK and provider adapters, Zod, and Playwright Core. SQLite comes from Node's `node:sqlite`. Graphology and Sigma belong to the application's graph presentation; the social engine uses its own arrays, maps, sampling, and ranking functions. See [engine/package.json](../engine/package.json) and [app/package.json](../app/package.json).

## Audience and persona construction

An audience defines segment shares, population size, seed, trait distributions, and optional profile attributes. Segment eligibility determines which points of interest (POIs) each person encounters. Without an audience, the engine uses one built-in persona and has no social rounds.

Segment allocation and trait sampling happen in code. Stable slot IDs and derived seeds identify personas; FNV-1a and Mulberry32 support seeded sampling. Patience, technical skill, device, language, and other configured attributes are sampled before model-generated prose. Some background distributions are fixed defaults, rather than estimates learned from the target population.

For each new persona, the writer asks for four candidate sketches and model-assigned probabilities, chooses a candidate using its seed, then expands the selected biography. Name repair can add a call. Those probabilities are selection weights produced by the model, not calibrated probabilities that such a person exists in the audience.

Profile signatures preserve unchanged saved personas. Exact-input draft caching includes model, endpoint, prompts, schema, and seed; completed drafts can be reused after generation is interrupted. Generation has its own concurrency setting, defaulting to 32, and reduces concurrency on rate limits. Its setup calls and costs are recorded separately from run calls.

Posting propensity is independently sampled as `round(U³ × 100) / 100`, producing mostly low values. It influences prompt wording, not a Bernoulli event that directly determines whether the persona posts. Older personas without it use `0.2`.

Sources: [audience/index.ts](../engine/src/audience/index.ts), [audience/sample.ts](../engine/src/audience/sample.ts), [audience/write.ts](../engine/src/audience/write.ts), [profile/signature.ts](../engine/src/profile/signature.ts), and [persona-generation.md](persona-generation.md).

## Run setup and lifecycle

The host checks POIs, required assets, model compatibility, current profiles, and required login sessions before starting a run. A run freezes the project, ordered personas, session metadata, seed, settings, and signal thresholds in its configuration. The current `app_version` field is the placeholder `0.0.0`.

The run records `run.started`, optionally calls the configured staging reset hooks, and records each `persona.created` with its follow list when social mode is active. Each persona encounters its eligible POIs sequentially in project order. Different personas may execute concurrently.

The scheduler starts episodes or usage slices, applies social phases, and closes active pages when execution ends. A stopped run still produces a report from the available history. A process crash leaves a run that becomes `interrupted` when its project is next opened; browser/agent execution is not restored from a durable checkpoint.

Default settings are 12 concurrent personas, a $5 recorded-cost budget, a 60-minute execution budget, screenshots enabled, and five social rounds. These are configurable defaults, not guaranteed spend or performance measurements. See [settings.ts](../engine/src/settings.ts), [run.ts](../engine/src/run.ts), and [log/sqlite.ts](../engine/src/log/sqlite.ts).

## How a persona encounters a POI

All POI runners share episode dependencies and produce common events. Patience levels 1–5 map to web step budgets of **12, 20, 30, 45, and 60**. Each POI gets its own budget; step numbers continue across a persona's POIs.

### Web

Each step follows this loop:

1. Read the page snapshot and save a screenshot.
2. Ask the navigator model for structured thought, feeling, action, optional friction, and optional opinion.
3. Validate the answer and execute an allowed browser action.
4. Record the step, inspect objective browser signals, and record any explicit opinion or friction.
5. Continue, finish, abandon, pause for a blocked session/challenge, or stop at an enforced limit.

The prompt retains the six most recent steps in detail and summarizes older steps in code. It can include the current opinion and a short set of recently heard social posts. Disabling screenshot input stops sending screenshots to the model; the web loop still saves evidence screenshots.

Three consecutive failures of the same action/error end the episode as `repeated_failure`. Exhausting patience is recorded separately from the model voluntarily abandoning. Login expiry or CAPTCHA pauses the persona; the default resume timeout is ten minutes. Each persona has its own browser context/page, but simultaneous personas can still modify shared server-side staging data.

Host allowlists, blocked production domains, production-payment tripwires, and observe-only policies constrain browser execution. These controls are operational containment, not a model of human behavior.

Sources: [agent/loop.ts](../engine/src/agent/loop.ts), [agent/prompt.ts](../engine/src/agent/prompt.ts), [browser/pool.ts](../engine/src/browser/pool.ts), and [safety.ts](../engine/src/safety.ts).

### Text and static designs

| POI | Current execution |
| --- | --- |
| Text | Reads parts of at most 48,000 characters, preferring natural breakpoints. Its budget is `ceil(web patience budget / 15)`: 1–4 parts. Each successful read uses one navigator call, returning comprehension, confusions, and opinion. |
| Design | Reads frames in sequence, using one navigator call per frame. Each call sees the current frame and, where available, the previous frame and previous answer. The budget is the smaller of patience budget and frame count. |

Text confusion quotes are checked against the content already read. An unlocatable quote loses its passage link but does not erase the reported confusion. A design expectation mismatch becomes a friction on the relevant frame. Neither runner supplies the browser signals available for a web POI.

Text content has a shared model-prompt prefix across personas. Design images have a bounded in-memory cache of downscaled representations. Static-design preflight currently accepts Anthropic, OpenAI, and Google navigator routes and rejects DeepSeek and unverified local endpoints.

Sources: [poi/text.ts](../engine/src/poi/text.ts), [poi/text-prompt.ts](../engine/src/poi/text-prompt.ts), [poi/design.ts](../engine/src/poi/design.ts), and [poi/frames.ts](../engine/src/poi/frames.ts).

### Surveys

After an episode ends, a navigator call asks for a structured survey; buyer segments receive a buying survey instead. Blocked or stopped episodes skip it, as does an exhausted run budget. Survey sentiment and certainty remain model self-reports. They are distinct from the evolving opinion events produced during steps and social phases.

Sources: [run.ts](../engine/src/run.ts), [agent/buyer.ts](../engine/src/agent/buyer.ts), and [poi/compare.ts](../engine/src/poi/compare.ts).

## Rounds and scheduling

Social mode requires an audience. The configured round count is clamped to 1–10; otherwise the run performs one uninterrupted usage phase without social rounds.

For a persona with total eligible-POI budget `B` and `R` rounds, a usage slice allows `ceil(B / R)` steps across its POIs. Pages and in-memory episode state remain open between slices. A round contains a usage phase followed by a social phase, bracketed by `run.round_started` and `run.round_ended`.

A social phase takes one snapshot of prior events after that round's usage. Every selected persona sees feeds derived from this same snapshot. Posts and reactions produced during the phase affect subsequent rounds, not peers already being processed in that phase. Acceptance-harness injected posts are inserted before the snapshot and can be read immediately.

The engine requests a social response only when a persona has an unseen feed post, or has taken steps since its last feed view and a later round remains to read what it might write. A single-person population gets no socialiser calls. Finished personas can continue participating while there are posts to read. Execution can end before the configured final round when no episodes, current-round injections, or social work remain.

The scheduler iterates personas in population order while limiting active tasks. The phase snapshot limits completion-order effects in discussion, but browser activity, response timing, event sequencing, and shared staging state remain execution-dependent. Rounds represent scheduling slices; they have no calibrated duration in real social time.

Source: [run.ts](../engine/src/run.ts).

## Social network and feed selection

The directed follow graph is created once per run from population order and run seed. It remains fixed throughout the run.

| Rule | Implemented value or behavior |
| --- | --- |
| Follow count | Uniform integer draw from 6 through 12, capped at population size minus one; no self-following. |
| Same-segment preference | Target 70% of follow choices, rounded; unused quota moves between pools when a segment is too small. |
| Hubs | Select `round(population × 0.1)` seeded hub personas. |
| Hub sampling weight | Weight 3 versus 1 for others, sampled without replacement. This does not guarantee three times the realized followers. |
| Candidate posts | Exclude the persona's own posts and anything it has already been shown. |
| Ranking | Relevant POI or no POI first; then total agree plus disagree reactions; then latest event sequence. |
| Followed portion | Up to 10 ranked unseen posts from followed authors. |
| Trending portion | Up to 2 ranked remaining unseen posts from anyone, including followed authors not already selected. |
| Feed limits | At most 12 posts, with a 2,500-token estimate using `ceil((text.length + 100) / 4)` per post. |

The feed considers both agreement and disagreement as engagement. The two trending slots are a fixed allocation; unused followed slots are not filled by more trending posts. Oversize candidates are skipped rather than truncated.

The token limit is a heuristic for selected posts, not a bound on the entire social prompt, parent excerpts, persona profile, or provider tokenizer. There is no learned recommendation model, evolving trust weight, community detection, or calibrated exposure probability in this implementation.

Every phase reconstructs board, seen-post sets, and opinions from accumulated events. Feed selection scans and sorts posts for each persona. These are straightforward replayable functions, but repeat work as histories and populations grow.

Sources: [social/graph.ts](../engine/src/social/graph.ts) and [social/feed.ts](../engine/src/social/feed.ts).

## Social actions, opinions, and influence

Each eligible social turn makes one structured socialiser call. Its prompt includes persona and task, episode status, recent thoughts, up to five recent frictions, current POI opinions, up to three previous authored posts, and the selected feed. Instructions encourage silence, individual voice, and treating posts as claims rather than orders.

The allowed action is `nothing`, `post`, `reply`, or `react`. A persona writes at most one post/reply per round, or reacts to one shown post with agree/disagree. Post text is limited to 500 characters. Reply targets and cited post IDs must belong to the feed shown; opinion updates can target only assigned POIs.

Opinion state is explicit structured data: integer sentiment from −2 to +2, confidence from 0 to 1, and up to five likes and five frictions, each at most 500 characters. A change records the full before/after values and source event references. Equal opinions produce no change event.

The schema permits an empty `post_ids` list on a social opinion update even though the prompt requests the posts that changed the view. It validates referenced IDs, not whether a post logically supports the explanation or the strength of the change. Confidence is the persona's stated certainty, not a statistical uncertainty interval.

Up to five feed posts are also passed to the next usage step, where displayed text is clipped to 300 characters per post. This lets discussion affect subsequent product use. These summaries carry author/text/POI name, not post IDs. Opinion changes recorded by POI runners cite their step event only, so later effects of heard posts are not fully attributed as social influence.

The graph/report derives an **influence edge** when an opinion event cites another persona's post about the same POI and the absolute sentiment change is at least 0.5. With integer sentiments, a qualifying nonzero movement is at least one point. A first opinion is compared with neutral zero. Confidence-only changes, uncited changes, self-citations, and cross-POI citations do not yield edges.

An edge is therefore recorded model attribution plus a heuristic filter. It is not an experimentally identified causal effect, and its delta is not apportioned when several posts are cited. Feed exposure establishes what was supplied to the model, not what a human would notice, remember, or believe.

Sources: [agent/prompt.ts](../engine/src/agent/prompt.ts), [opinion/index.ts](../engine/src/opinion/index.ts), [social/influence.ts](../engine/src/social/influence.ts), and [run.ts](../engine/src/run.ts).

## Model-call efficiency and accounting

The gateway routes five roles independently: navigator, socialiser, persona writer, judge, and author. It uses schema validation for every provider, including local validation when a provider only supports JSON mode. Provider defaults and price tables are repository configuration, not dynamically verified service capabilities or invoices.

Existing efficiency controls include skipped idle social turns, bounded feed/history context, shared text prompts, provider prompt caching, persona-draft reuse, image reuse, per-role reasoning settings, and concurrency limits. Social calls currently do not supply the gateway's separate shared prefix: their stable system prompt begins with the individual persona.

Transient provider errors can receive up to three retries after the first attempt, with backoff/jitter and supported `Retry-After` headers. A wait longer than 60 seconds is not retried. Invalid structured output gets one corrective retry; the second invalid answer raises `InvalidOutputError`. Every dispatched attempt is recorded, including failed or invalid attempts and their reported usage.

Failure handling differs by caller: invalid web/design output becomes a failed step; invalid text output ends the run; invalid social output leaves the persona silent that phase. Invalid or timed-out surveys can be omitted. Report-model failures fall back to deterministic report content.

Request and estimated-input-token buckets operate per provider/gateway. Their limits are fixed configuration, with some values explicitly marked as guesses in source; they do not adapt to account tiers or response quota headers. DeepSeek and local endpoints have no token bucket. Token estimation uses text length and a fixed image allowance, not model tokenizers.

A run rate limit halves persona concurrency down to two, at most once per five-second burst; concurrency does not subsequently rise. Paused personas retain their slots. This scheduler limit covers usage and social work, not report calls, which use separate `Promise.all` batching.

Recorded-cost enforcement includes retries. Before admitting work, an average-cost projection can stop new steps; reaching the recorded cap cancels model work. Already dispatched requests can still be billed, so this is not a strict invoice cap. Provider usage completeness is logged; missing usage means cost is uncertain. The acceptance runner adds a stop on missing usage, which should not be confused with the ordinary run's recorded-cost guard.

The wall-clock timer stops admission to execution but is cleared before report-model generation. Report calls have their own 180-second request deadlines and still use the budgeted gateway. Persona setup calls use separate accounting and do not spend against a later run's budget.

Sources: [llm/gateway.ts](../engine/src/llm/gateway.ts), [llm/limiter.ts](../engine/src/llm/limiter.ts), [llm/prices.ts](../engine/src/llm/prices.ts), [report/models.ts](../engine/src/report/models.ts), and [run.ts](../engine/src/run.ts).

## Persistence, replay, and repeatability

SQLite stores project settings, saved personas, run snapshots, ordered events, model transcripts, setup attempts, and draft cache entries. Screenshots, imported content, and report files live in the project filesystem. Session secrets use separate encrypted storage.

Events have per-run sequence numbers; the recorder appends before broadcasting to the UI. SQLite uses WAL with `synchronous=NORMAL` and currently commits each event individually. A model transcript is saved separately after its event append. This is an audit history, not a transactional checkpoint of browser and agent state.

Reports, current opinions, social boards, and visual graph state are reconstructed from events. Replaying a saved log can reproduce those projections without model calls. Re-running the experiment performs fresh browser actions and model requests and need not reproduce the log, even with the same seed.

Seeds cover defined sampling functions, not the entire execution. The gateway does not set a provider sampling seed or temperature; provider behavior, model revisions, timing, retry jitter, and target state can vary. Ordinary run snapshots also lack the full source/runtime/price manifest that the acceptance harness writes.

Sources: [log/sqlite.ts](../engine/src/log/sqlite.ts), [log/blobs.ts](../engine/src/log/blobs.ts), [sessions.ts](../engine/src/sessions.ts), [llm/gateway.ts](../engine/src/llm/gateway.ts), and [acceptance/run.ts](../engine/src/acceptance/run.ts).

## Reports and current validation

The report pipeline combines self-reported friction, survey items, abandonment, and browser signals. It groups evidence deterministically and labels trust as `confirmed`, `observed`, or `reported`. These mean corroboration within the simulation; they do not mean confirmed human problems. Report ranking uses explicit heuristic trust weights.

After normal execution, judge calls merge/name groups and can tag social posts. Author calls suggest changes in batches of three themes. Their outputs become events, so later report replay does not ask the models again. The report includes outcomes, segment/attribute breakdowns, sentiment, buyers, comparisons, themes, and social spread where available.

Existing acceptance infrastructure is valuable but has a narrower purpose than external scientific validation:

| Suite | What it checks |
| --- | --- |
| [M2](m2-acceptance.md) | Frozen-population execution, locale, runtime, recorded cost, profile adherence review, and report replay. |
| [M3](m3-acceptance.md) | Seeded Gym defects and a control build; reviewed recall/precision, across-seed theme stability, and evidence links. |
| [M4](m4-acceptance.md) | Injected complaint across five seeds; same/cross-segment reach, an influence plausibility audit, and round replay. |
| [M5](m5-acceptance.md) | Text contradiction, design expectation mismatch, controls, and input-specific reporting checks. |

The M4 spread rule compares raw reached-person counts in the author's segment and all other segments combined; it is not normalized by the available population. Reach includes feed exposure, thread replies, or eligible influence edges. Its network already favors same-segment follows, so a passing result cannot independently validate that assumption.

Scripted rehearsals test mechanics and preserve `NOT_RUN` for claims requiring live models. Frozen populations do not evaluate live persona-generation validity. The [roadmap](roadmap.md) records incomplete live criteria and reduced-scale runs; creating this snapshot did not run or certify new acceptance results.

The current system does not provide a general experiment protocol, separate human calibration and validation datasets, identifiable causal model, systematic ablation suite, or uncertainty estimates across independent populations and model runs. Seeded synthetic-network comparisons and plausibility reviews help diagnose behavior, but do not establish population representativeness or predictive accuracy.

The next design should preserve evidence capture, structured interfaces, containment, and replay while making those scientific and operational limits explicit. [new_simulation.md](new_simulation.md) defines the proposed replacement and its validation requirements.
