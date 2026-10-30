# ODD description of the behavioural model

This describes the model as implemented on branch `claude/simulation-workspace`, in the structure of [new_simulation.md §3](new_simulation.md#3-define-the-model-before-running-it). ODD is a reporting structure, not evidence that the behaviour matches humans. The model is unvalidated (`NOT_VALIDATED`); every parameter below is **assumed** unless the Status column says otherwise, and none is measured or calibrated against human data. Values are read from the source files named in each section.

## 1. Purpose and patterns

**Question.** Where do synthetic personas get stuck in a product, text or design, what do they tell each other about it, and how does that talk change what they report? The output is evidence-linked hypotheses for human follow-up, never a measure of real users.

**Intended population and environment.** A frozen audience of personas, grouped in segments, using web apps in a contained browser, reading texts and looking through static design frames (POIs), with social rounds in between.

**Patterns it should reproduce (checks, not claims).** Same-segment spread of a complaint exceeds cross-segment spread under the legacy network (the M4 regression check, [m4-acceptance.md](m4-acceptance.md)); budgets stop a persona within one step; for a run that is not stopped, recorded answers replay to the same state whatever the response timing (a stop cuts the log where the timing of calls in flight put it).

**Known limits.** Personas are language-model outputs and share model bias; the follow graph is imposed, not observed; opinion transitions are the model's own proposal; influence edges are provenance, not causal effects; a synthetic interval describes this simulator, not the human population.

## 2. Entities, state variables and scales

| Entity | State |
| --- | --- |
| Persona | `segment_id`, `device`, `patience` 1-5, `tech_skill`, `familiarity_with_category`, `language`, `posting_propensity` 0-1, biography and voice (written by the persona writer); fixed for a run. |
| Segment | Sampling ranges for the traits above, `kind` (`user` or `buyer`), POI eligibility. |
| POI | `web`, `text` or `design`; sets the step budget rule. |
| Follow edge | Directed, unweighted: follower to followed; realized once per run from the seed and persisted as the graph. |
| Post | `post_id`, author, `parent_id`, text, `about_poi_id`, event `seq`, running `agree` and `disagree` counts. |
| Opinion | Per persona and POI: `sentiment` integer -2 to 2, `confidence` 0-1, up to 5 likes and 5 frictions (500 characters each). |
| Influence edge | `from` author, `to` persona, POI, post, `delta`, `kind` `influence`, `formed` or `heard`. |
| Event | Append-only log with `seq`, `round`, persona and POI; all state is a fold of the log. |

**Scales.** Time is logical: a *step* is one model decision of one persona on one POI; a *round* is one usage slice followed by one social phase. A round is not a claim about elapsed human time. The run has 0 rounds (social off, or no audience) or 1 to 10.

## 3. Process overview and scheduling

For each round `1..R` (`run.ts`, `schedule`):

1. **Usage slice.** Every persona still using a POI takes up to `ceil(sum of its POI budgets / R)` steps, personas in parallel up to `concurrency`, steps within a persona sequential. Personas start in a seeded order that mixes segments (`order/<seed>/<persona>`), so a stop part-way does not cut the population by segment. A persona that heard posts gets them in its next step prompt only.
2. **Social phase.**
   1. Harness-injected posts are recorded first.
   2. One snapshot of the log is folded into the board (posts, reactions, per-persona seen sets). Nothing written in this phase is visible in it.
   3. Each persona with more than one persona in the run is *due* if its feed is non-empty, or if it took a step since it last read the feed and a later round remains. Everyone else is skipped.
   4. Due personas make one independent `socialiser` call concurrently.
   5. After every call has settled, validated answers are applied **in population order**, so response speed cannot decide whose post is newest. After a stop, late answers are logged as `llm.call` but not applied.
3. The loop ends early when nobody is using a POI, nothing is injected and nobody is due. Before each usage slice and social phase, or once at the start of a run without social rounds, the whole cohort's steps are projected at the average cost so far and the cohort is admitted whole or the run stops, so response timing cannot choose which personas get steps. A hard stop (user, tripwire, recorded cost, error) cancels model calls in flight; the wall clock and the projected cost are soft stops: nothing new starts and calls in flight finish. Either ends the run with partial results.

A persona writes at most one post per round. Silence is a valid action; a failed call is a different outcome.

## 4. Design concepts

- **Imposed, not emergent.** The follow graph, the feed policy, the step budgets and the round count are imposed. Emergent, if anything: which complaints spread, who forms or changes an opinion, and when personas give up.
- **Attention.** Exposure is explicit: a persona sees only posts the feed policy selected for it, and `social.feed_viewed` records which (ids and order). A follow edge alone never counts as exposure. Reading is not tied to posting propensity.
- **Heterogeneity.** Persona traits are sampled per segment from seeded streams; the biography is written by a model from the sampled traits.
- **Adaptation and learning.** None beyond bounded memory: the last 6 step memories, the last 5 frictions and the last 3 own posts are in the prompt (`agent/prompt.ts`).
- **Interaction.** Posts, replies and agree/disagree reactions through the feed. No private messages.
- **Decision.** One structured model response per step or social turn, validated against a schema. The engine, not the prompt, enforces budgets.
- **Opinion.** The model proposes a full opinion snapshot; code records it only when it differs from the previous one. Popularity is never converted into belief and convergence is not forced.
- **Stochasticity.** Application randomness comes from named streams (`fnv1a` of a key, then `mulberry32`): `follows/<seed>`, `rewire/<seed>`, `<policy>/<seed>`, `posting/<seed>`, `traits/<seed>`, `feed/<seed>/<persona>/<round>`. Model sampling is the declared temperature and, where supported, a provider seed (section 8).
- **Observation.** Every action, exposure, opinion change and model call (with temperature, seed and the model the provider reports) is an event.

## 5. Initialization

- **Population.** Personas come from the frozen audience: traits from `sampleTraits` (`audience/sample.ts`), one draw per trait in a fixed order; `patience` is uniform over the segment's integer range, clamped to 1-5; `posting_propensity` is `round(u^3, 2)` from its own stream, so it is mostly low (the median draw is 0.13).
- **Graph.** Built once from `networkGraph(policy, personas, seed)` before round 1 (`social/graph.ts`) and a function of the seed and population order only.
- **Opinions.** None at the start; a first opinion after reading counts as `formed`, not `influence`.
- **Board.** Empty, plus harness-injected posts at their round.
- **Randomness.** Streams are allocated by stable identity (above), not consumed in completion order.

## 6. Input data

| Input | Provenance |
| --- | --- |
| Audience, segments, goals | Authored by the user or proposed by a model; synthetic input, not an observed human record. |
| Analytics export (optional) | A CSV the team imports for a segment: counts become segment shares, phone shares, countries and languages, which sampling reads as usual. Values Gnomi cannot map are skipped and listed. The file is read once; its name and hash stay with the segment. |
| Research notes (optional) | Interview notes or support tickets the team adds for a segment. Emails and phone numbers are removed in code, then the `persona_writer` model condenses them into a digest of at most 8 facts and 5 remarks. A remark is kept only if it is word for word in the redacted text. The digest shapes the fictional personas of that segment, and each persona's prompt quotes up to three remarks, picked by its seed; nothing is fitted to their behaviour. The files are read once; their names and hashes stay with the segment. |
| Which data shaped a run | A report's methods name each grounded segment with its file names and its counts of facts and remarks, as the run froze them. Grounded personas are still fictional, and their findings are still hypotheses. |
| Products, texts, designs | The user's own web app, pasted or uploaded text, Figma frames or images; hashes are stored with the run. |
| Prices | A bundled price table for cost accounting (`llm/prices.ts`). |
| Human reference data | None for validation. Analytics and research notes shape personas when a team adds them, but no parameter is fitted to observed behaviour, and data used to write personas cannot also test them. |

## 7. Submodels

**Follow graph, `legacy` (`followGraph`).** Each persona follows a count drawn uniformly from 6-12, capped at the population minus one. 70% of its follows come from its own segment and 30% from other segments (a pool too small for its share hands the rest to the other). 10% of personas, chosen by seeded order, are hubs drawn with weight 3 in weighted sampling without replacement (Efraimidis-Spirakis: the k largest `u^(1/w)`). Nobody follows themselves.

**Network policies (`networkGraph`).** `legacy` as above. `rewired` swaps the targets of random follow pairs for `10 x edges` attempts, rejecting a swap that would create a self-follow or duplicate, so every out-degree and in-degree is kept and segment is ignored: the primary null for "does segment homophily drive spread". `random` is a graphology Erdos-Renyi digraph with mean out-degree about 9, trimmed to 12 and topped up to 6 follows each. `clustered` keeps each persona's legacy follow count and draws 90% of its follows uniformly from its own segment and the rest from others, with no hubs, so it differs from `legacy` only in how segment-bound the follows are. A population of one persona uses `legacy`. `graphMetrics` reports `segment_modularity` (directed modularity of the segment partition), mean in-degree, and the share of follows received by the top tenth by in-degree.

**Feed (`selectFeed`).** Posts the persona has not seen and did not write. `ranked`: posts by followed personas first rank (relevance to the persona's own POIs, then reactions `agree + disagree` descending, then a seeded per-persona, per-round shuffle), the top 10 are kept; then 2 trending posts ranked the same way from anyone, followed or not. At most 12 posts and about 2,500 tokens, estimated as `ceil((chars + 100) / 4)`; a post that does not fit is skipped and a smaller later one may still fit. `chronological`: followed posts in event order, up to 12 and the same token cap, no ranking and no trending. Order of the list is the position shown and is logged. Ties never fall back to event sequence.

**Posting.** The model decides `nothing`, `post`, `reply` or `react` each turn. `posting_propensity` does not gate an action in code: it picks one of four sentences in the system prompt (below 0.15 "almost never posts", below 0.35 "rarely", below 0.6 "now and then", else "more readily than most"). The prompt states that doing nothing is the usual answer. Personas written before the field existed use 0.2.

**Step budgets (`stepBudget`, `poiBudget`).** Patience 1 to 5 gives 12, 20, 30, 45 or 60 steps; outside the range 30. Web POIs use the budget as is; text POIs use `ceil(budget / 15)` (1-4 parts); design POIs use `min(budget, frames)`; every POI gets at least 1. Exhaustion ends the episode with `signal.budget_exceeded` and is reported, not silent.

**Opinion (`opinion/index.ts`).** Sentiment is an integer -2 to 2 (very negative to very positive); confidence 0-1 is the persona's own certainty, not a statistical quantity. `sameOpinion` suppresses unchanged snapshots. `foldOpinions` keeps the latest per run, persona and POI by `seq`.

**Influence and formed edges (`influenceEdges`).** For a `persona.opinion_changed` event citing post ids: `delta = after.sentiment - before.sentiment`, with a missing prior opinion counted from 0. A change with `|delta| < 0.5` draws nothing; with integer sentiment a change of a prior opinion always clears it, but a neutral first opinion (delta 0) does not, so the threshold binds for would-be `formed` edges. For each distinct cited post by another persona and about the same POI, one edge; a reply with no POI of its own takes its parent's, and a post with none in a one-POI project is about that POI. The kind is `formed` when there was no prior opinion and `influence` otherwise; only `influence` edges are counted as influence. Uncited changes, self-citations and cross-POI citations draw no edge. Product steps record the heard post ids on the step and friction events; a change that cites steps instead of posts draws a `heard` edge from each post handed to one of those steps. `formed` edges appear in the engine's live graph (kept apart from `influence` edges); the report's spread section leaves them out and shows `heard` edges, which the live graph does not.

**Echo handling in findings.** The call is made per persona, not per friction. A persona is first-hand on a theme when any of its reports on the theme precedes its first exposure to a post the judge tagged with the theme (a feed that showed a reply also counts as showing its quoted parent), or when any of its reports is backed by a browser signal other than the accessibility scan, whose step can be anyone's and so says nothing about what this persona had read; otherwise it is *heard first* and is kept out of k and ranking. The heard ids are checked whether or not the judge tagged posts: a reported friction logged at a step whose heard post ids include a post by a persona already counted in the theme is heard first; with neither tags nor heard ids, the report says echoes could not be separated ([new_simulation.md §4](new_simulation.md#social-echo-in-finding-counts)).

**Episode outcomes (`report/build.ts`).** Each persona ends per POI as `done`, `abandoned`, `budget_exceeded`, `repeated_failure`, `model_failed` (three invalid model answers in a row), `blocked`, `incomplete` or `not_started` (the run never reached it); a persona is done only when it is done on every POI it was given, else it takes its worst. `not_started` and `model_failed` say nothing about the product, so they are left out of the completion and friction rates and counted apart.

**Theme trust, ranking and prevalence (`report/themes.ts`).** A theme made only of weak signals (`small_target`, `backtrack`) is left out of the report: it is not ranked and does not count towards the friction rate. The log and the group ids are unchanged, and undersized targets go to the methods appendix as an audit. A theme's trust is scored by the mix of its members (each persona at its best trust, averaged), not by its maximum, and the report shows the counts. Themes rank by severity tier (the rounded median of each persona's worst severity), then by the lower bound of the Wilson interval times that trust weight. The prevalence denominator is the personas who reached the theme's pages (page reach), or for buyer objections the buyers surveyed on the POI; k is the first-hand personas.

**Suggested priority (`report/themes.ts`).** `priorityOf` labels a friction theme for the reader and changes nothing else: not the rank, the score or any count. Fix now is severity at least 3 (rounded, as in the ranking) with strong evidence. Next is severity at least 3 with some evidence, strong evidence at a lower severity, or severity at least 3 with single evidence and confirmed or observed trust. Everything else is Later, including a theme with no prevalence. An objection has no label, and neither does a competitor's theme.

**Evidence check (`report/models.ts`, `report/themes.ts`).** Off unless `finding_check` is set or `gnomi rejudge --check` asks for it. A model reads each top friction theme's evidence and answers `product`, `agent_mistake`, `environment` or `unclear`. A theme with `agent_mistake` or `environment` leaves the ranking and the friction rate and the ranks close up; `product` and `unclear` change nothing but the theme's `check` field. Prevalence and scores do not change, and the persona's posts about it still count as first-hand in the spread. The check can reject a real defect and can share bias with the personas, which is why results stay visible and `check_model` can name another family. Its effect has not been measured.

**Accessibility scan and perception limits (`signals/index.ts`, `agent/prompt.ts`, `report/friction.ts`).** Off unless `accessibility_checks` is set. Each page state of a full-mode POI is scanned once per run with axe-core, and critical and serious violations signal once per rule and page pattern, on the step of whichever persona got there first, which is arbitrary. So a scan's signal counts towards no persona, in k, severity or the trust weight: a theme of nothing else has trust `observed`, prevalence 0 and evidence `none`, and says it was found by the scan. It confirms a self-report by any persona on the same page, only when the complaint's words fit the rule's category, and a report only a scan confirms can still be heard first. Moderate and minor violations go to the methods appendix. `colour_blind` and `low_vision` personas browse under Chromium's vision emulation, and `screen_reader` personas get no screenshots. The prompt's words stay as they were. Its effect on recall has not been measured.

**Round count and clamp (`socialRounds`).** `R = min(10, max(1, floor(rounds ?? 5)))` when social is on and an audience exists, else 0.

**Model sampling (`llm/gateway.ts`).** Per-role temperature is requested unless the route has reasoning on, in which case none is sent. A provider seed is passed to Google, DeepSeek and OpenAI-compatible routes only, derived from run, persona, round and purpose (31 bits). The temperature and seed sent, less any the provider reports it ignored, and the model the provider reports, are recorded on each `llm.call`.

## 8. Parameter table

Status for every row is **assumed**, except where the Provenance column cites a source. "Provenance" names what the value rests on; none is a fit to human data.

### Follow graph and network policies

| Name | Unit or range | Value | Rationale | Provenance | Status |
| --- | --- | --- | --- | --- | --- |
| `MIN_FOLLOWS` | follows per persona | 6 | A small feed-sized neighbourhood. | `social/graph.ts`; tech.md §6.6 | assumed |
| `MAX_FOLLOWS` | follows per persona | 12 | Same; keeps an average persona near a dozen sources. | `social/graph.ts`; tech.md §6.6 | assumed |
| `OWN_SHARE` | share 0-1 | 0.7 | Segment-biased ties, so homophily is present to test against the null. | `social/graph.ts` | assumed |
| `CLUSTER_OWN_SHARE` | share 0-1 | 0.9 | The `clustered` control is more segment-bound than `legacy`, with no hubs. | `social/graph.ts` | assumed |
| `HUB_SHARE` | share of personas | 0.1 | A few accounts attract most follows (`legacy` only). | `social/graph.ts` | assumed |
| `HUB_WEIGHT` | sampling weight | 3 | Hubs gain about three times the followers. | `social/graph.ts` | assumed |
| `network_policy` | `legacy`, `rewired`, `random`, `clustered` | `legacy` | Legacy is the baseline; the others are controls. | `settings.ts` | assumed |
| rewire attempts | swaps per edge | 10 | Enough mixing for a degree-preserving null. | `rewireAcrossSegments` | assumed |
| `random` mean out-degree | follows | about 9 | Midpoint of 6-12. | `networkGraph` | assumed |

### Feed

| Name | Unit or range | Value | Rationale | Provenance | Status |
| --- | --- | --- | --- | --- | --- |
| `FEED_POSTS` | posts per read | 12 | Bounded context. | `social/feed.ts` | assumed |
| `HEARD_POSTS` | posts | 5 | The number of feed posts handed to the next product step. | `agent/prompt.ts` | assumed |
| `TRENDING` | slots, from anyone | 2 | Some exposure beyond the follow graph. | `social/feed.ts` | assumed |
| `FEED_TOKENS` | estimated tokens | 2,500 | Prompt size cap. | `social/feed.ts` | assumed |
| token estimate | `ceil((chars + 100) / 4)` | 4 chars per token plus 100 chars of line overhead | Estimates gate the cap only; no tokenizer. | `social/feed.ts` (marked `shortcut:`) | assumed |
| `feed_policy` | `ranked`, `chronological` | `ranked` | Chronological is the no-ranking, no-trending control. | `settings.ts` | assumed |
| rank order | relevance, reactions, shuffle | fixed | Popularity and position reinforce each other (see new_simulation.md §4), so equal ranks are shuffled. | `social/feed.ts` | assumed |
| tie-break stream | seed `feed/<run seed>/<persona>/<round>` | per persona and round | Response timing must not choose the winner. | `run.ts`, new_simulation.md §5 | assumed |

### Persona traits and posting

| Name | Unit or range | Value | Rationale | Provenance | Status |
| --- | --- | --- | --- | --- | --- |
| `posting_propensity` | 0-1 | `round(u^3, 2)`, `u` uniform | Most people read and do not write. | `audience/sample.ts` | assumed |
| `DEFAULT_POSTING_PROPENSITY` | 0-1 | 0.2 | For personas written before the field existed. | `agent/social.ts` | assumed |
| propensity wording cut-offs | 0-1 | 0.15, 0.35, 0.6 | Four prompt phrasings; not a probability. | `agent/social.ts` | assumed |
| `patience` | integer 1-5 | uniform in the segment range | Authored per segment. | `audience/sample.ts` | assumed |
| `motivation` | 1-5 | 10, 25, 35, 20, 10 percent | Most people meet a work tool as a chore. | `audience/sample.ts` | assumed |
| `seniority` | junior, mid, senior, lead | 25, 40, 25, 10 percent | An organisation pyramid. | `audience/sample.ts` | assumed |
| `pronouns` | she, he, they | 48, 48, 4 percent | No binary assumption in prompts. | `audience/sample.ts` | assumed |
| `MAX_FACTS` | facts per segment | 8 | Enough for goals, vocabulary, objections and tools without crowding the writer's prompt. | `engine/src/audience/ground.ts` | assumed |
| `MAX_REMARKS` | remarks per segment | 5 | A few voices, so three per persona still vary across a segment. | `engine/src/audience/ground.ts` | assumed |
| `MAX_REMARK_CHARS` | characters | 280 | Longer verbatim passages are dropped, because each remark rides in the cached prefix. | `engine/src/audience/ground.ts` | assumed |
| `REMARKS_SHOWN` | remarks per persona | 3 | Real examples of how a segment talks, picked by seed, not a script to follow. | `agent/prompt.ts` | assumed |

### Patience and step budgets

| Name | Unit or range | Value | Rationale | Provenance | Status |
| --- | --- | --- | --- | --- | --- |
| web budget by patience 1 to 5 | steps | 12, 20, 30, 45, 60 | Engine-enforced because telling simulated users they may quit barely changes behaviour. | `agent/loop.ts`; tech.md, the table citing Sim2Real and Lost in Simulation | assumed |
| fallback budget | steps | 30 | Out-of-range patience. | `agent/loop.ts` | assumed |
| text budget | parts | `ceil(budget / 15)`, 1 to 4 | A few parts from patience are plenty. | `poi/text.ts` | assumed |
| design budget | frames | `min(budget, frames)` | A screen is a step. | `poi/design.ts` | assumed |
| minimum budget | steps | 1 | A POI is never skipped by rounding. | `poi/index.ts` | assumed |
| slice length | steps | `ceil(total budget / R)` | Equal usage slices between social phases. | `run.ts` | assumed |

### Opinion, influence and edges

| Name | Unit or range | Value | Rationale | Provenance | Status |
| --- | --- | --- | --- | --- | --- |
| sentiment | integer | -2 to 2 | Explicit claim, not inferred from text. | `opinion/index.ts` | assumed |
| confidence | 0-1 | model-reported | Self-report; not a statistical interval. | `opinion/index.ts` | assumed |
| likes and frictions per opinion | count, characters | 5 each, 500 characters | Bounded output. | `opinion/index.ts` | assumed |
| edge threshold | sentiment units | 0.5 | Binds for a neutral first opinion (delta 0); any change of a prior integer opinion is at least 1. | `social/influence.ts` | assumed |
| `influence` rule | prior opinion required | yes | A first view is not a changed view. | `social/influence.ts`, new_simulation.md §4 | assumed |
| `formed` rule | no prior opinion | first opinion cites a post | Shown separately, not counted as influence. | `social/influence.ts` | assumed |
| echo discount | frictions with no signal but the scan's | heard first leaves k | A signal on the persona's own step cannot echo a post; a scan's may sit on anyone's. | `report/themes.ts` | assumed |

### Comparing runs

| Name | Unit or range | Value | Rationale | Provenance | Status |
| --- | --- | --- | --- | --- | --- |
| `RETEST_REACH` | personas | 3 | How many must reach all of a theme's pages in one later run before its absence reads as "Not seen again" rather than not retested. With fewer, it may just not have been tried. A report's coverage lists pages and screens below it as barely tested. | `report/diff.ts`, `report/coverage.ts` | assumed |

### Reading one run

| Name | Unit or range | Value | Rationale | Provenance | Status |
| --- | --- | --- | --- | --- | --- |
| `CURVE_MIN` | personas | 10 | Under this the discovery curve is too short to read, so the report says so and claims nothing from it. | `report/coverage.ts` | assumed |
| last fifth | personas | `ceil(n / 5)` | The window whose new themes the hint counts. | `report/coverage.ts`; tech.md §6.7 | assumed |
| `DRIVER_HOLDERS` | personas | 5 | How many must hold a value and have reached a theme's pages before it can read as "more common among". | `report/dimensions.ts`; features_roadmap.md item 8 | assumed |
| `DRIVER_AFFECTED` | personas | 2 | Of those, how many must have met the theme first-hand, so one persona is never a pattern. | `report/dimensions.ts` | assumed |
| `DRIVER_GAP` | difference of two rates | 0.25 | The least gap against those without the value. No p-value is given, as connected personas are not independent. | `report/dimensions.ts`; new_simulation.md §9 | assumed |
| `DRIVER_MAX` | values per theme | 2 | Keeps a finding readable, the largest gap first. | `report/dimensions.ts` | assumed |

### Friction signals

| Name | Unit or range | Value | Rationale | Provenance | Status |
| --- | --- | --- | --- | --- | --- |
| `small_target_px` | CSS pixels | 24 | A mobile tap under this in either direction is a `small_target` signal. Frozen per run, so older runs keep 40. Unlike WCAG, it does not exempt links inside a sentence. | `signals/index.ts`; the WCAG level AA minimum | assumed |
| weak signals | signal kinds | `small_target`, `backtrack` | Often the persona rather than the product, so a theme made only of them is left out of the report. | `report/friction.ts`, `report/themes.ts`; the 16 October Gym run, a tiny sample | assumed |
| `interference_s` | seconds | 60 | A failed action on an element whose name matches something another persona changed on the same POI this long before is tagged "possibly interference between personas". The tag removes nothing and changes no rank. Frozen per run, so older runs have no tag. | `signals/index.ts`; the minute in [tech.md §9.2](tech.md#92-dummy-data) | assumed |
| changed element | step kinds | a `type` or `select` that succeeded, or a `click` that did something on anything but a link | What the log can show of a write. Reads, hovers and link clicks write nothing, and a click with no effect changed nothing. A draft only its persona can see counts, because the log cannot tell it from a shared record, and pressing Enter does not, because the log does not say what a key did. So the tag can fire when nothing was shared. | `signals/index.ts` | assumed |
| interference name match | element names | whole name, ignoring case and outer spaces | The simplest rule that works from the log. A generic name such as "Save" can match across pages, and a renamed record cannot match at all. | `signals/index.ts` | assumed |
| priority labels | rounded severity, evidence level, trust | severity 3 splits the labels; single evidence needs confirmed or observed trust to reach Next | A recorded failure one persona met can still be a real defect, but one self-report is not yet a pattern. A reading aid within the run. | `report/themes.ts`, `interpreting-simulations.md` | assumed |
| `finding_check` | boolean | absent, which is off | Stays off until its `--evaluate` arm shows it helps. | `report/models.ts`, `acceptance/checks.ts` | assumed |
| evidence check input | themes per POI, per call; steps after each piece of evidence | 15, 3, 2 | Bounds the calls and what each one reads. | `report/models.ts`, `report/themes.ts` | assumed |
| `accessibility_checks` | boolean | absent, which is off | Covers the scan, the vision emulation and screen readers' missing screenshots. Stays off until its `--evaluate` arm shows it helps. | `agent/prompt.ts`, `signals/index.ts`, `acceptance/checks.ts` | assumed |
| signalled impacts | axe-core impact | `critical`, `serious` | Below them a violation goes to the methods appendix, as weak signals have made false themes before. | `signals/index.ts`; the 16 October Gym run, a tiny sample | assumed |
| `accessibility` signal severity | 1-4 | 2 | As the other signals, whatever the rule's impact. | `report/friction.ts` | assumed |
| complaint words for a scan | word lists per axe category | `SCAN_WORDS`: colour, naming (aria, forms, name-role-value, text-alternatives) and keyboard; any other category confirms nothing | A scan's step is arbitrary, so nearness says nothing, and an unrelated complaint beside a violation must not read as confirmed. Written by hand, not fitted. | `report/friction.ts` | assumed |
| vision emulation | need to Chromium type | `colour_blind`: `deuteranopia`, `low_vision`: `blurredVision` | The prompt says red-green. `blurredVision` cut the edge contrast of a screenshot of 14 px text about 15-fold (10.49 to 0.69) and leaves large headings readable. That says it blurs, not that it matches any person's sight. | `agent/prompt.ts`, `browser/audit.test.ts` | assumed |
| scan time limit | ms | 10,000 in the page, 1,000 more in the driver | Past it the persona carries on and the page counts as not scanned. 45-500 ms per page on the Gym. | `browser/page.ts` | assumed |
| scanned elements kept | count, path parts | 3, last 5 | Enough for a reader to find the elements; `elements` keeps the full count. | `browser/page.ts` | assumed |

### Rounds

| Name | Unit or range | Value | Rationale | Provenance | Status |
| --- | --- | --- | --- | --- | --- |
| `rounds` | count | 5 | Enough turns for a complaint to travel a few hops. | `settings.ts` | assumed |
| `MAX_ROUNDS` | count | 10 | Cost cap. | `settings.ts` | assumed |
| clamp | count | `min(10, max(1, floor(rounds)))`, 0 when social is off or no audience | Always at least one round when on. | `settings.ts` | assumed |
| posts per round | count | at most 1 per persona | Prevents flooding. | `run.ts` | assumed |
| `social` | boolean | true | A swarm needs an audience, so `socialRounds` gives 0 without one. | `settings.ts` | assumed |

### Temperatures and routing

| Name | Unit or range | Value | Rationale | Provenance | Status |
| --- | --- | --- | --- | --- | --- |
| temperature, navigator | 0-2 | 1 | Personas vary like people. | `llm/gateway.ts` | assumed |
| temperature, socialiser | 0-2 | 1 | Same. | `llm/gateway.ts` | assumed |
| temperature, persona_writer | 0-2 | 1 | Same. | `llm/gateway.ts` | assumed |
| temperature, judge | 0-2 | 0.5 | The judge stays near its evidence. | `llm/gateway.ts` | assumed |
| temperature, author | 0-2 | 1 | Same as personas. | `llm/gateway.ts` | assumed |
| reasoning routes | n/a | no temperature sent | These routes reject it; the recorded value is null. | `llm/gateway.ts` | assumed |
| provider seed | 31-bit integer | `fnv1a(run/persona/round/purpose) >>> 1`, Google, DeepSeek, OpenAI-compatible only | Anthropic and OpenAI Responses take none. | `llm/gateway.ts` | assumed |
| effort | low, high | low for all roles, high for author | Thinking tokens would dominate the bill. | `llm/gateway.ts` | assumed |
| default routing (Anthropic) | model alias | navigator and socialiser `claude-haiku-5-5`; persona_writer and judge `claude-sonnet-5-5`; author `claude-opus-5-5` | Aliases can change weights between runs; the provider-reported model is recorded. | `settings.ts` | assumed |
| `concurrency` | personas in flight | 12 | Browser memory; see tech.md §4. | `settings.ts` | assumed |
| `cost_budget_usd`, `wall_clock_budget_min` | USD, minutes | 5, 60 | Default allowance. | `settings.ts` | assumed |
