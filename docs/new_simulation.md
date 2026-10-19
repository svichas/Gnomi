# Simulation design: useful competitor comparisons in a contained runtime

Status: **Steps 1 to 6 of §10 are implemented on branch `claude/simulation-workspace`; phase 2 (§8) and review decisions 2 and 3 (§10) remain.** Written on 2026-10-18 against baseline commit `9e383901046046eb9d6e06853f3a0aaf86504a4b` and revised after two reviews. The branch has the `simulation/` workspace (step 1), heard-post ids and first-hand counts (step 2), ordered social phases, feed positions, seeded ties, per-role temperature and the prior-opinion influence rule (step 3), graph metrics and null networks (step 4), the evaluation harness (step 5) and the ODD description in [odd.md](odd.md) (step 6). The run store and protocol (phase 2) are not built, the first validation task and benchmark are not chosen, and no behavioural validation has been done. The baseline before the move is documented in [old_simulation.md](old_simulation.md). Sections below keep the original design wording where it still describes the design.

**Comparison implementation, 2026-10-18:** the explicit comparison path in §3.1–§3.6 is implemented across setup, execution, persisted evidence, report projection and HTML/Markdown/JSON export. This revision responds to the locally supplied ATS report for run r-0001 (`docs/pitch/gnomi-report-r-0001.html`, not checked into the repository); that historical report is unchanged and must be rerun with a comparison brief to collect the new evidence. Existing architecture and scientific safeguards remain applicable.

In **Setup → Compare tools**, enable shared tasks and requirements after adding at least two tools or materials. Choose **Choose a tool** or **Improve my own product**, explicitly select the owned product for the latter, and review the common tasks, criteria, scenarios, source mappings and access scopes. Authenticated workflows require a separate recorded test login for each tool. The review screen shows the frozen brief and the estimate, including two evidence-assessment passes per eligible episode. Existing projects without a comparison brief retain their legacy behavior and reports.

The implementation lives in [comparison/](../simulation/src/comparison/), [report/comparison.ts](../simulation/src/report/comparison.ts), [ComparisonSetup.tsx](../app/src/renderer/src/ComparisonSetup.tsx), and [ComparisonReport.tsx](../app/src/renderer/src/ComparisonReport.tsx). Recorded assessments and deterministic replay produce scoped fit, focal advantages/gaps/parity, owner-specific next steps and coverage with explicit unknowns. Public/documentation scopes use observe-only browsing; missing access or materials limit the affected tasks. Optional final persona preference elicitation is not enabled: this version does not manufacture preference votes or a composite winner. Automated fixtures verify runtime and reporting behavior; live vendor studies and behavioral validation against human decisions remain separate work.

Authenticated studies open fresh browser contexts with the target's own recorded login; they do not reset server-side test records between episodes. Prepare fixtures accordingly. An unexpected initial login screen remains an access limitation rather than an inferred authentication defect: diagnosing a login-form defect requires evidence this access path does not collect. These constraints are also shown in authenticated comparison reports.

Run `npm test` and `npm run typecheck` for automated regressions. `npm run smoke:comparison -w @gnomi/app` builds and exercises the real Electron setup → saved brief → simulation → report path using disposable text assets and scripted models; it makes no paid model calls.

## 1. Objective and scope

Build a simulation runtime that produces inspectable product-research experiments: what a defined synthetic population experienced, what it communicated, how its responses varied, and what evidence supports the resulting findings. Improve behavioral validity and computational efficiency through measurement. A convincing conversation, a larger audience, or a scientific library is not evidence of validity by itself.

For a comparison, success means the reader can answer **which tool fits which needs, where their own tool wins or loses, why, and what to do next**. Support two purposes: a product owner comparing their tool with alternatives, and a buyer selecting among tools. Both need a common evaluation task and evidence for each alternative. Product owners need prioritized changes to their own product; buyers need a conditional shortlist and questions to resolve before choosing. A useful result may be a narrow advantage or an unresolved decision, provided it explains the evidence and next action.

The intended consumer remains Gnomi's desktop app, with a headless runner for experiments and evaluation. The runtime covers product interactions, social interaction, observations, decisions, opinion state, evidence, and run-level analysis. Editable projects, imports, credentials UI, and report presentation remain application concerns.

The proposed boundary is a top-level `simulation/` npm workspace named `@gnomi/simulation`, with its own dependencies, tests, fixtures, public contracts, and standalone Node entry point. Initially the desktop composes it inside the existing engine utility process; it is already separate from the UI process. Headless execution runs it independently. This provides a service boundary without adding a second worker hop to every desktop request. A network service can use the same contracts later; HTTP hosting, authentication, multi-tenancy, Redis, and distributed workers are outside this first design.

Success has separate dimensions: implementation correctness, reproducible recorded execution, agreement with relevant human evidence, robustness to assumptions, and measured cost/time. A release can satisfy some dimensions and remain unvalidated on others.

## 2. Ownership and dependency boundary

| Owner | Responsibilities |
| --- | --- |
| `simulation/` | Frozen experiment/comparison contracts; population snapshots; runtime scheduling; product and social decisions; graph/feed/exposure state; memory and opinion policies; model budgets; run persistence; replay; target/task evidence and deterministic comparison metrics; optional evidence-grounded report analysis. |
| `engine/` | Project and audience editing/authoring; comparison brief authoring; Figma and asset import; login recording; translation of project settings into simulation requests; legacy event/report readers; presentation/export helpers. |
| `app/` | Electron lifecycle, OS credential storage, user controls, visualization, and report presentation. |
| Simulation adapters | Browser execution and containment, provider requests, storage, clocks, and transport. Adapters implement interfaces owned by the simulation package. |

Dependencies point from `app/` and the engine compatibility facade into the simulation's public exports. No simulation source imports `app/` or `engine/` internals. Core policies do not import Electron, Playwright, provider SDKs, or SQLite. Existing interfaces in [seams.ts](../simulation/src/seams.ts) are useful extraction points, but the broad `ProjectStore` must become narrower run-scoped ports.

Layout, which now exists. Files keep their current names and relative paths, so the move is a `git mv` whose diff is empty apart from import paths, and history follows each file:

```text
simulation/
  package.json                 # an explicit exports map and independent scripts
  src/
    run.ts  safety.ts  types.ts  seams.ts  settings.ts  persona.ts  assets.ts
    cli.ts  acceptance.ts      # the standalone entry points, as today
    agent/  poi/  social/  opinion/  signals/  report/  llm/  browser/
    log/                       # the SQLite and blob adapters behind seams.ts
    acceptance/                # the evaluation harness and its fixtures (§9)
    audience/locations.ts  audience/sample.ts  profile/
    graph/synthetic.ts         # the seeded fixture run, beside the harness
  experiments/                 # versioned study definitions and analysis settings
```

Tests stay beside the code as `*.test.ts`, as they are now. The taxonomy of contracts, runtime, ports and adapters describes what these folders contain; it is not a rename to perform during the move. Rename a folder later only when it outgrows its name.

The `exports` map names each file the engine and the app import, in place of the wildcard. The app's imports were switched to `@gnomi/simulation` paths in the move; the engine keeps no re-export shims. An import-boundary check enforces the dependency direction. [no-electron.test.ts](../engine/src/no-electron.test.ts) is a regular expression over import statements, so a copy in the new workspace that also forbids `@gnomi/engine`, `../engine` and `app/` is a few lines. Match existing TypeScript/ESM conventions, discriminated unions, and runtime schema validation at boundaries.

### Reaching the boundary in two phases

The boundary is reached by moving code first and redesigning storage later. The move is where most of the containment value is; §8's run store and recovery protocol are where most of the cost is.

What the boundary crosses today:

- The engine exports every source file (`"./*": "./src/*"` in [engine/package.json](../engine/package.json)). The app imports 20 different engine modules, 53 times from [types.ts](../simulation/src/types.ts) alone.
- Simulation code reaches back into authoring code, counting source files only: `poi/` imports `assets.ts`, `audience/locations.ts`, `audience/sample.ts` and `profile/schema.ts`; `report/` imports `audience/diversity.ts` and `profile/schema.ts`; `llm/` imports `audience/sample.ts`; `agent/`, `browser/` and `run.ts` import `audience/locations.ts` and `profile/schema.ts`; `social/` and `graph/` import the seeded-sampling helpers in `audience/sample.ts`. Only tests import `log/sqlite.ts` and `log/blobs.ts`.
- In the other direction, `audience/write.ts`, `host.ts`, `cli.ts` and the app's provider test import `llm/`, and five renderer files import `graph/`. Those two folders are shared, so the move has to say where they go (below).

**Phase 1, move with no behaviour change.** Create the workspace and move the files in the layout above with `git mv`. `types.ts` moves whole: `RunConfig` freezes the entire `ProjectConfig`, so the project types are simulation inputs, and a split would only re-export them. `profile/` moves whole too, since the acceptance fixture samples profiles and all three files depend only on moved code. The engine keeps what authors and hosts: `host.ts`, `protocol.ts`, `sessions.ts`, `figma/`, the audience writer and proposer (`audience/index.ts`, `write.ts`, `propose.ts`, `demo.ts`, `diversity.ts`) and the UI readers `graph/index.ts` and `graph/feed.ts`, all importing from the simulation's exports. Three reach-backs need a line each: the pure `similarity` and `MEAN_SIMILARITY` that `report/spread.ts` uses move out of `audience/diversity.ts`, which then imports them; `Transport` moves from `seams.ts` to `engine/src/protocol.ts`, because `seams.ts` imported the engine's protocol; and `run.ts` takes `Pick<ProjectStore, 'events' | 'append' | 'saveTranscript' | 'finishRun'>` as its run-store port, leaving `log/` as the adapter that implements the whole interface. `llm/` moves and is exported, so the audience writer imports the gateway from the simulation; the dependency points the right way. The harness's `../../../gym/` imports keep the same depth. The run's tests ([run.test.ts](../simulation/src/run.test.ts), [run.e2e.test.ts](../engine/src/run.e2e.test.ts)) and the scripted acceptance rehearsals are the parity baseline; tokens and results do not change. The PR is large but mechanical.

**Phase 2, when a headless or hosted runner needs it.** The separate run store, `sim-<UUID>` ids, idempotency keys, checkpoints and the command protocol in §8. A single-user desktop app gains little from them, and they add a second lifecycle owner and a migration.

## 3. Define the model before running it

Use the **ODD protocol** to describe each version of the behavioral model. ODD is a reporting structure, not a certificate that the behavior matches humans. [Grimm et al., 2020](https://www.jasss.org/23/2/7.html)

| ODD element | Required Gnomi definition |
| --- | --- |
| Purpose and patterns | Research question, intended population/environment, outcomes to explain, and known limits. |
| Entities, state, scales | Personas, product inputs, posts, directed ties, experience/memory/opinions; units of logical time and observation. |
| Process and scheduling | Who is eligible to act, what they can observe, phase boundaries, and when effects become visible. |
| Design concepts | Assumed attention, learning, heterogeneity, interaction, and adaptation; which patterns are imposed and which may emerge. |
| Initialization | Population, graph, starting beliefs, environment state, and random-stream allocation. |
| Input data | Data provenance, sampling/weighting, asset versions, calibration evidence, and external environment changes. |
| Submodels | Versioned formulas or decision policies for activation, feed ranking, memory, opinion updates, and action generation. |

Every parameter has a name, unit/range, rationale, provenance, and status: **measured**, **calibrated**, or **assumed**. Keep current graph/feed settings as a named legacy baseline, not universal social constants. Changes to the behavioral policy create a new model version, even when wire schemas remain compatible.

### Experiment contract

Before a confirmatory run, freeze:

- The question, target population, scenario, treatment/control, and the quantity being estimated, such as the difference in task-completion rates between product variants.
- Primary and secondary outcomes; eligible denominators; handling of blocked, invalid, abandoned, or incomplete episodes; exclusions and missing-data rules.
- Population/network generation, model/prompt settings, replicate count or precision-based stopping rule, analysis method, and cost allowance.
- Calibration and held-out validation datasets, baseline comparisons, tolerances, and intended scope of any validity claim.

Exploratory runs may omit a confirmatory hypothesis, but must be labeled exploratory. Save deviations after the experiment starts; do not silently revise the definition to match observed results.

For product A/B comparisons, use matched population/network realizations across the two worlds and independent mutable state. Declare any shared random streams used for variance reduction. Changes to the environment, time horizon, or social policy must be treatment variables or documented deviations. Network exposure and interference belong in the design, not just the analysis. [Aronow and Samii](https://arxiv.org/abs/1305.6156)

### 3.1. What the comparison must fix

Run r-0001 asked personas to find an ATS for their company across Workable, Lever, Ashby and Teamtailor. Its output largely answered a different question: what was frustrating about each website. These are observations about that saved run, not current claims about the vendors.

| Failure in the saved report | Required change |
| --- | --- |
| The headline says 7 of 20 reached the goal, then prioritizes “Find ATS is a single-vendor marketing site, not a comparison tool,” reported by 19 personas. | Gnomi owns the cross-vendor synthesis. Visiting a vendor site to gather evidence must not require that site to offer an independent comparison directory. Separate per-tool task outcomes from the study's ability to support a decision. |
| Occasional reviewers expected shared candidate profiles despite being sent to marketing homepages. | Freeze the task and its prerequisites before execution. Persona traits can change priorities and reactions, but cannot invent a different assignment, incoming email, account, candidate or deep link. |
| “What to fix first” asks the reader to change competitors' websites. | Bind each recommendation to its owner. Changes to the user's tool, lessons from rivals, and buyer follow-ups have different destinations. |
| Pairwise preferences appear late: Workable/Lever/no preference = 11/1/8; Workable/Ashby/no preference = 4/12/4; Workable/Teamtailor/no preference = 7/8/5. | Lead with common criteria across all tools. These different pairwise votes cannot establish an overall winner; distinguish a tie from missing evidence, ineligibility and rejection of both. |
| Methods lists blocked login, app, documentation, API and CDN hosts, but says “Limitations: None.” Some broad themes contain unrelated quotes or generic console errors as confirmation. | Connect restrictions to the affected task and criterion. A blocked request or unrelated signal cannot confirm a product defect or missing capability. Validate what each evidence item actually supports. |

The current [comparison helper](../simulation/src/poi/compare.ts) uses the first full-access web POI as the baseline and observe-only POIs as competitors. [Report aggregation](../simulation/src/report/build.ts) and [comparison rendering](../app/src/renderer/src/Report.tsx) consume that model. Changing report prose alone cannot repair the task, sampling and evidence problems. Replace the implicit experiment semantics first; reuse existing event and screenshot capture.

### 3.2. Freeze a comparison brief

When the user asks to compare tools, draft a brief from their goal and selected targets. Show the task, criteria, assumptions, access scope and estimated allowance in the existing setup flow. Ask only for missing information that materially changes the decision; otherwise use visible exploratory assumptions. Choosing an ATS without company size, hiring needs or budget should yield conditional scenarios, not an invented universal buyer. Do not silently add vendors or expand browsing permissions.

| Field | Required meaning |
| --- | --- |
| Purpose | `improve_own_product` or `choose_tool`. The first requires an explicit focal target; the second allows all tools to be peers. Ownership is independent of target order and browser access. |
| Targets | Stable `target_id`, display name, optional owner/focal role, and associated POI/asset IDs. Several pages, screenshots or documents can describe one tool. Distinct product variants can be separate targets. URLs and array positions are not identity. |
| Decision context | Shared use case, company/user constraints, must-haves, current alternative and switching constraints where supplied. Each scenario has an immutable `scenario_id`; segment-specific needs are explicit scenarios, held constant across tools for that segment. |
| Tasks | Stable `task_id`, scenario reference, neutral instruction, prerequisites, eligible segments, and observable success rule. Map each target to its own entry point and data/account fixture for the same job. |
| Criteria | Stable `criterion_id`, question, importance, evidence required and decision rule. Separate must-have constraints from preferences. Use a small set tied to the decision, normally 4–6; freeze it before browsing. |
| Access and scope | Per-target public-site, documentation, prototype or authenticated-workflow scope; permissions, session reference, data/reset fixture and dependencies. Record which criteria each source can answer. |
| Execution | Independent benchmark or buyer journey (§3.3), eligible population, target order/allocation, per-task limits, social policy, stopping rule and budget split, including synthesis. |

Purpose is separate from the existing audience segment `kind`. A buyer choosing tools may need to browse public sites; it must not silently bypass comparison because the current [eligibility default](../simulation/src/poi/pois.ts) skips buyer web episodes. Validate assignments against the brief. Text/design targets participate in criteria their artifacts can answer; viewing every frame is not proof of completing a live workflow.

For the ATS example, a neutral public-site task is: “Find evidence for suitability, plan eligibility, pricing basis, required integrations and the next evaluation step for this company's hiring needs.” Gnomi combines the observations after all tools have been considered. A separate authenticated task might be “Find an assigned candidate and submit an evaluation”; it requires a valid account, candidate and permitted action for every tool included in that workflow comparison. Public documentation can support what a vendor claims, but cannot demonstrate completion of that workflow.

Useful criteria in this example include fit for the stated hiring workflow, cost at the relevant company size, integrations, ease of completing an accessible task, and evaluation/setup effort. Security or migration requirements are included when the brief calls for them. Do not substitute “has a competitor comparison page” for product fit, or rate every tool on every imaginable feature.

### 3.3. Execute comparable tasks

**Independent benchmark is the default.** Give matched personas the same scenario, task, device/locale policy and effort limits for each target. Each target episode starts with independent mutable memory, browser context and target-specific session/fixture. Do not inject the focal product's survey, verdict or other targets' social posts into another target's task. Survey prompts name the current target and ask about the assigned task. Cross-target judgment happens after these observations are frozen.

Allocate target order deterministically and balance positions within eligible segments as far as the sample allows; save the realized order and any imbalance. Admission should reserve a complete matched task block where possible. A deadline or provider failure may still interrupt a block: retain every attempt, expose unequal coverage, and never let the first configured tool quietly receive most of the evidence. A shared role name is not permission to reuse one vendor's login session at another vendor.

**Buyer journey is an explicit alternative.** A persona may remember previously considered tools, then choose a shortlist. Record the order and carryover policy, balance order where possible, and label outcomes as choices after that sequence. Do not mix them into independent benchmark metrics. Social interaction is off by default for the comparison baseline; an explicit social treatment needs its own exposure and carryover rules. Never interpret repeated opinions as additional independent product observations.

Before task execution, preflight entry points, required data, authentication and critical page dependencies. Separate navigation, read-resource and write permissions; discovering a dependency does not authorize it. Preserve containment and competitor observe-only rules. Missing/expired test credentials, a blocked API, prohibited submission or absent fixture become coverage limitations. A demonstrated login defect with valid prerequisites can instead be a task failure. Offer a permitted public-information task or collect the needed setup for a later run; never turn an access restriction into “this product cannot do X.” A bare console error is diagnostic unless linked to a visible task failure.

Retain these task outcomes independently of persona sentiment:

| Outcome | Meaning in analysis |
| --- | --- |
| `completed` | The declared success condition has supporting evidence. A persona saying “done” alone is insufficient. |
| `task_failed` / `abandoned` | The task was valid and accessible, but failed, exhausted its predeclared task-effort limit, or the persona chose to stop. These remain in valid-attempt denominators. Record the cause; a failed task does not by itself prove a product defect. |
| `blocked_environment` | Policy, missing test access/data or tooling prevented a valid observation. Report the specific cause and excluded comparison cells. Authentication failures with valid setup are not automatically excluded. |
| `incomplete` | A global cost limit/deadline, cancellation or provider failure interrupted an unresolved task. Preserve partial evidence and stop reason; do not overwrite an already established outcome. |
| `invalid_task` | A material deviation from the assigned task or invented prerequisite invalidates the episode. Exclude it from performance/preference denominators, show the deviation, and retain the trace for diagnosis. |
| `not_applicable` / `not_attempted` | The frozen eligibility rule excludes this task/segment, or no attempt occurred. Neither is a failure or a success. |

Finding plan information is a valid success for a public-site research task even when it produces a documented mismatch or “quote required.” That is distinct from completing a product workflow and from having enough information to recommend a purchase.

### 3.4. Build evidence before preferences

Capture positive capabilities and successful paths as well as friction. The existing [web survey](../simulation/src/agent/prompt.ts) and [run coordinator](../simulation/src/run.ts) must supply target-specific task observations, not just a friction summary and generic project goal. Keep source-level extraction separate from persona interpretation and final comparison.

Every comparison observation carries run/replicate, target, scenario, task, criterion and episode identities; persona/segment where applicable; source URL or asset ID; capture time; event/step and screenshot/text reference; access scope; and the proposition it supports. A document gathered once is one source, even if twenty personas read it. Preserve contradictory observations with their contexts rather than collapsing them into a favorable summary.

Use two separate labels on each criterion cell:

- **Assessment:** `meets`, `partially_meets`, `does_not_meet`, `unknown`, or `not_applicable`, against the frozen rule and scenario. `does_not_meet` requires positive evidence of a mismatch. Failure to find evidence is `unknown`.
- **Basis:** observed task behavior, vendor claim, user-supplied claim, or simulated opinion/inference. Link the underlying source and scope; an observed pricing page is evidence of what was displayed, not verification of all fees or contractual terms.

“Not found on the pages visited,” “requires a quote,” “blocked by the sandbox,” and “does not support the requirement” must remain distinct. Record pricing with the relevant tier, size/seat band, currency, billing period, date, add-ons and exclusions when visible. Normalize cost only with a shared scenario and compatible terms; do not compare a small-company starting price with an enterprise quote or fill undisclosed prices from model memory. External source retrieval, if enabled, follows declared sources/permissions and records provenance; marketing assertions never become verified workflow performance.

Validate evidence links before synthesis: the cited item must concern the same target, task, criterion and claim. A small-target signal cannot confirm that a vendor lacks a feature; an occasional reviewer's missing candidate cannot confirm a pricing problem. Group friction within a target first, then map supported findings to shared criteria. Deduplicate repeated complaints by persona/task and distinguish first-hand reports from social echoes (§4). Keep source strength, synthetic agreement and statistical uncertainty separate.

Semantic extraction and assessment may use a model under the frozen criterion rubric. Store each assessment, supporting observation IDs, assessor model/prompt/rubric versions and any rejection; these judgments are not deterministic facts. Code validates identity, permitted evidence, coverage and arithmetic, then builds the matrix deterministically from the accepted records. Unsupported or unresolved contradictory assessments remain unknown with their reasons. Replay reuses recorded assessments rather than judging them again. The synthesis model can summarize differences and propose actions from this matrix; it cannot invent facts, change criteria or calculate denominators. Retain the matrix and limitations if synthesis fails. The first release has **no overall score**: show criterion outcomes, tradeoffs and must-have constraints. A future weighted score requires a declared formula, weights, missingness handling and sensitivity analysis before execution.

Scope matrix cells by target, scenario, task, criterion, segment and access scope; show separate views where those conditions differ. A tool can meet a small team's requirement and fail an enterprise requirement without contradiction. Never average those into one fit label. Paired metrics match replicate, persona, scenario and task across targets, using the declared comparable access scope.

Preference is optional supporting evidence. Apply the frozen eligibility/coverage gate before asking: record exclusions as ineligible, invalid task or insufficient coverage, without issuing a preference call. When asked about two tools, a persona may answer A, B, tie, neither suitable or insufficient evidence; passing the coverage gate does not require it to have a preference. For several tools ask for one final shortlist/preference with reasons and criterion evidence, allowing multiple acceptable tools or no decision. Record collection separately as answered, not collected, failed or invalid response; a failed request is not a persona's abstention. Do not derive an all-tool ranking by adding separate baseline-versus-competitor votes. Label preferences as simulated choices within this study, not purchase likelihood or market share.

### 3.5. Report the decision first

The comparison report replaces the pooled “reached the goal / problems to fix / sentiment” opening for comparison studies. It must remain useful when the reader never opens a persona transcript.

| Order | Required output |
| --- | --- |
| 1. Decision and scope | A conditional recommendation or shortlist for the stated needs; the main differentiator, tradeoff and unresolved must-have. If evidence cannot separate tools, say so and give the next check. Show “public-site evaluation” or the actual workflow scope beside the verdict. |
| 2. Side-by-side matrix | Criteria as rows and every target as a column, including the focal tool. Group by scenario/segment and task/access scope when these differ. Each cell has the assessment, concise supporting fact, basis, coverage and inspectable evidence links. Unknowns remain visible. |
| 3. Where each tool fits | Advantages, disadvantages and shared gaps by relevant scenario/segment. For owners, call out focal-tool wins, losses and parity. For buyers, explain when each shortlisted tool is suitable and which requirement disqualifies a tool. |
| 4. Actions | A short ordered list, normally up to three, each with responsible owner, affected segment/task, evidence, expected benefit as a hypothesis, and a validation step. Unsupported implementation details and invented revenue lifts are excluded. |
| 5. Coverage and evidence | Attempts and outcomes per target/task/segment, comparable pairs, blocked or unobserved criteria, order and access differences, costs, uncertainty and study limitations. Task traces and diagnostic logs sit behind the findings. |

An owner action should take the form: “Improve **this part of your tool** for **this task/segment**, because **your observed result** differs from **the competitor's observed result**; verify with **this follow-up task**.” Prefer consequential must-have gaps and repeated task failures over cosmetic complaint counts; expose the evidence behind that priority. Competitor weaknesses become positioning opportunities or diligence questions, not instructions to edit the competitor's site. Buyer actions are concrete evaluations, quote requests or requirement checks; the report does not submit those requests automatically.

Show scheduled and attempted counts plus every terminal outcome from §3.3. For a task, valid attempts = completed + task_failed + abandoned; completion rate = completed / valid attempts, or unavailable if the denominator is zero. A predeclared task-effort limit counts as task_failed; a global execution interruption counts as incomplete. Show exclusions adjacent to the rate. Criterion coverage reports eligible and assessed persona/task counts separately from distinct source counts; repeated use of one source is not repeated verification. Preference shares use all valid answered responses as the denominator, including ties, neither suitable and insufficient-evidence answers; show gate exclusions and not-collected/failed/invalid responses separately. Pairwise differences use the same matched personas/tasks and show pair overlap. Preserve all unmatched outcomes too: incomplete coverage can change the apparent result, so do not present a selected subset as an unconditional winner.

Steps and browser/model latency are simulator effort and execution measurements, not human time-to-value. Never pool four tools' success, sentiment or willingness-to-continue into one product score. Single-run counts are descriptive; comparison intervals use independent replicate pairs (§9). If a key must-have is unknown, a tool may be a **conditional** shortlist candidate but cannot be declared a verified fit. Restrict superiority claims to comparable access and tested criteria; public marketing versus an authenticated workflow cannot establish overall product superiority.

### 3.6. What a useful result would say for the ATS example

The saved r-0001 report supports a lesson about what to investigate next, not a defensible overall ATS winner. A bounded summary of its recorded observations would read:

> **Decision: the study is insufficient to choose an ATS.** The personas inspected public vendor sites while key login, documentation and resource hosts were blocked. The run mixes tool selection with unsupported candidate-review tasks. Its pairwise preferences cannot resolve the four-way choice.
>
> **Useful next checks:** recover comparable plan and price evidence for the same company size; verify required integrations from accessible sources; then run the same hiring workflow in correctly configured accounts. Keep pricing visibility and actual product usability as separate criteria.

| Target | What the saved report records | Decision consequence / next check |
| --- | --- | --- |
| Workable | Some personas reached pricing; the dominant complaint incorrectly demands a multi-vendor directory. | Recheck the relevant plan and total-cost terms. Exclude the directory complaint from product-fit assessment. |
| Lever | Personas report missing public prices and an unavailable quote form. | Cost remains unresolved. Check whether permitted resources make the form observable before calling it broken; a quote is a buyer follow-up, not a product failure. |
| Ashby | Personas distinguish a displayed Foundations price from quote-based Plus pricing for their stated size. | Confirm the applicable tier before comparing costs. Do not use the smaller-company price as the price for these companies. |
| Teamtailor | The report has a no-public-pricing theme, but includes unrelated candidate-review evidence. | Reassess the pricing claim using only relevant captures. Exclude unrelated quotes and leave unverified cost unknown. |

These are historical report statements, not newly verified vendor facts or a regenerated result. A new valid run should replace this limited summary with the matrix, segment-specific tradeoffs and supported owner/buyer actions above. More personas repeating the same mistaken task would not solve the problem.

## 4. Population and behavioral model

### Population

Consume a frozen, realized population with its generation recipe and data provenance. Reuse the existing audience authoring flow initially; an authored biography is synthetic input, not an observed human record. Evaluation harnesses may prepare several independently sampled populations through the public boundary.

Prefer behaviorally relevant traits: goals, product familiarity, constraints, prior experiences, and task context. Record the evidence for demographic distributions and correlations; marginal quotas alone do not establish a representative joint population. Unsupported combinations and missing reference data stay explicit. Weight outcomes only with documented target-population weights, and show unweighted counts as well.

Evaluate within-segment diversity and subgroup errors. Increasing the number of synthetic personas does not resolve shared model bias. Existing research demonstrates identity flattening in the models and settings studied; Gnomi must test its own population/model combinations. [Wang et al., 2024](https://arxiv.org/abs/2402.01908)

### Social mechanisms

1. **Network formation:** use a directed graph with explicit tie semantics and optional weights. Compare the legacy segment-biased network with null networks. The null that answers whether segment homophily drives spread keeps every persona's out-degree and rewires whom it follows without regard to segment: a degree-preserving rewiring of the realized graph, about twenty lines in-house. Clustered and random generators are secondary controls. Persist the realized graph, not just its seed. Treat dynamic following/trust as later, separately evaluated policies.
2. **Availability and attention:** define whether a persona visits the feed during a logical interval independently of whether it posts. Record activation probabilities, sampled eligibility, and exposure decisions. Quiet readers may still change their opinions.
3. **Feed selection:** rank eligible content using a versioned, inspectable policy. Parameters may include tie strength, relevance, recency, and popularity. Freeze candidate/tie-breaking rules and log actual exposure, including each post's position in the feed shown. Models favour items early in a list, and the current ranking puts the most-reacted posts first, so position and popularity reinforce each other. Order equal-rank posts with a seeded per-persona shuffle rather than event sequence. Keep chronological and no-trending controls. Never infer exposure simply from a follow edge.
4. **Decision:** an active persona receives its own permitted observations, bounded memory, and selected feed. One structured model response may propose a post/reply/reaction/no-public-action plus an opinion update. Silence is a valid social action; failed inference is a different outcome.
5. **Opinion transition:** initially use the frozen LLM decision policy with strict validation of allowed values and supporting evidence. Record before/after state and references to firsthand observations or exposed posts. No update is valid. Do not add an automatic popularity-to-belief conversion or force convergence. Mechanistic alternatives require their own parameter definitions and controlled comparison.
6. **Memory:** retain recent observations plus a bounded summary of older relevant evidence, with source IDs and explicit uncertainty. Summarization policies must be versioned and tested for lost contradictions and invented facts. No global knowledge or access to another persona's private history.

Separate self-reported certainty, evidence quality, and statistical uncertainty. They are different quantities. Model-attributed influence edges describe provenance; estimating an intervention's effect requires a controlled comparison. An effect inside the simulator does not establish a real-world causal effect.

The baseline edge rule counted a first opinion as movement from zero. The implemented [correction](../simulation/src/social/influence.ts) requires a prior opinion for an `influence` edge; a non-neutral first opinion citing another persona's post about the same POI gets the separate `formed` kind. The 0.5 threshold remains a no-op for changes in integer sentiment. A first opinion is never counted as influence.

### Social echo in finding counts

The baseline report showed each theme's "k of n personas" with a 95% Wilson range ([report/themes.ts](../simulation/src/report/themes.ts), `prevalence`), treating each persona as an independent witness. With social rounds on, that is not true. A persona that reads a post is handed it in its next product step ([agent/loop.ts](../simulation/src/agent/loop.ts), [poi/text.ts](../simulation/src/poi/text.ts), [poi/design.ts](../simulation/src/poi/design.ts)), so a friction reported after reading about it may repeat the post rather than confirm it. Counting every report as independent can inflate k and narrow the range. The implemented correction must not swing the other way: a rule that discounts real defects in social runs confounds the social-on/off comparison in §9 with the rule itself.

Two things separate the two. First, heard posts now carry a post id ([agent/prompt.ts](../simulation/src/agent/prompt.ts), `HeardPost`), and step and friction events record the heard ids ([agent/loop.ts](../simulation/src/agent/loop.ts)), making exposure before a report a fact of the log. Second, the judge tags posts with the friction groups they discuss ([report/models.ts](../simulation/src/report/models.ts)), and `social.feed_viewed` records which posts each persona was shown and when. For each theme:

- A persona counts as **first-hand** when at least one of its reports on the theme precedes the first feed that showed it a post tagged with that theme (a reply's quoted parent counts as shown), or when any of its reports on the theme has `confirmed` or `observed` trust ([report/friction.ts](../simulation/src/report/friction.ts)). A browser signal cannot be an echo of a post, so the discount applies to `reported` frictions only.
- Otherwise it counts as **heard first**. It stays visible beside the share, but not in k.
- Ranking, evidence level and the "2+ personas" rule for top lists use first-hand k; themes rank by severity tier, then the share's lower bound times the mean trust weight, and k is out of the personas who reached the theme's pages. The recorded heard ids are checked with or without judge tags: a `reported` friction logged at a step whose heard posts include one by a persona already in the theme counts as heard first. With neither, the report says it could not separate echoes.

This correction added no model calls. Counts remain descriptive of this run's personas; a Wilson range does not establish independence among them or quantify uncertainty in a product comparison. Replicate-level intervals (§9) are the measure for comparisons between runs.

Use the same frozen language policy across a comparison. Browser locale, persona language, response language, and translation are distinct inputs and must be evaluated rather than assumed equivalent.

## 5. Logical execution and reproducibility

The initial scheduler uses discrete logical rounds with declared product and social phases. A logical round is not a claim about elapsed human time. Model real time only after defining and validating the mapping.

```mermaid
flowchart LR
  A[Freeze experiment and realized inputs] --> B[Product observations and decisions]
  B --> C[Freeze social snapshot]
  C --> D[Select activity and exposures]
  D --> E[Request independent decisions concurrently]
  E --> F[Validate and apply in stable logical order]
  F --> G[Checkpoint and calculate metrics]
  G --> H{Stopping rule reached?}
  H -->|No| B
  H -->|Yes| I[Result with evidence and uncertainty]
```

Assign operation IDs from run, logical phase, round, persona, input, step, and purpose. Allocate reproducible RNG streams by stable identities with a documented derivation/jump policy; record algorithm and stream allocation. Do not consume one global random stream in promise-completion order.

Model sampling is part of the experiment definition. The gateway now requests per-role temperatures and supported seeds and records accepted settings plus the reported response model ([llm/gateway.ts](../simulation/src/llm/gateway.ts)). Routing still names model aliases such as `claude-haiku-5-5` ([settings.ts](../simulation/src/settings.ts)), so weights may change between two runs with the same seed. Use dated model snapshots where the provider offers them and retain these settings in the run manifest. Routes with reasoning enabled get no temperature, so they record none. This does not make fresh replicates identical; it makes their variation declared.

Freeze observation inputs for each social phase. Issue independent requests concurrently, save attempt telemetry immediately, stage validated decisions, and apply effects in canonical logical order. Feed tie-breaking uses logical IDs/order. API response speed must not select whose post becomes most recent. Product steps within a persona remain sequential; independent personas may execute concurrently.

This fixes the baseline hazard in which [social decisions](../simulation/src/run.ts) appended as calls finished and [feed ranking](../simulation/src/social/feed.ts) used event sequence as a recency tie-breaker. The implemented scheduler stages decisions and applies them in population order; ties use seeded ordering. Preserve these guarantees when adding target/task scheduling.

At budget or deadline boundaries, use a frozen admission order and explicit partial-phase policy. Admit a complete phase cohort when its conservative reservations fit; otherwise stop before that cohort or use a predeclared sampling policy with known inclusion probabilities. Do not silently retain only the fastest responders. Provider failures or a wall-clock stop still produce missing observations and partial results, not an assurance of identical live execution.

Maintain three separate execution modes:

| Mode | Guarantee |
| --- | --- |
| Event replay | Rebuild state and metrics from committed events with zero model/browser/network calls. |
| Recorded-input execution | Run the coordinator with recorded observations and responses; require identical committed logical state, decisions and scientific outcome metrics despite artificial latency and permitted concurrency changes. Operational timing/queue telemetry may differ. |
| Fresh replicate | Make new model/environment requests under the frozen design. Seeds control application randomness; model outputs and live websites may still vary. |

Separate browser contexts do not isolate a shared server database. Controlled product comparisons require resettable fixtures or isolated accounts/data per replicate. Arbitrary shared live websites support weaker claims; record that environment limitation.

## 6. Efficient use of models and computation

Use deterministic code for selection, accounting, legal-action checks, state updates, graph metrics, and evidence aggregation. Use models for interpreting content and proposing behavior where language understanding is required. Benchmark each optimization against the baseline on both cost/time and declared behavioral outcomes.

| Technique | Required safeguard |
| --- | --- |
| Stable shared prompt prefix before persona-specific context | Cache keys include model, prompt/schema versions and content. Measure actual provider cache hits; cache support and minimum sizes vary. |
| Skip work with no new relevant information | Preserve the baseline no-information skip. New activity/attention gates are behavioral changes requiring calibration and ablation; never use posting propensity alone to decide whether someone reads. |
| Smaller models for routine roles, escalation for specified cases | Freeze routing/escalation rules; validate each route and log escalation cost. Do not switch model mid-study silently. |
| Bounded context and structured outputs | Keep evidence IDs, contradictory experiences, and validation. Measure truncation, invalid-output and retry rates. |
| Provider-aware concurrency | Separate browser capacity from model capacity and account/endpoint/model quota groups. Preserve logical ordering and retry accounting. |
| Incremental event projections and feed indexes | Update state from new events; keep replay as the reference implementation and compare projections against it. |
| Reuse frozen assets and deterministic calculations | Scope reuse to exact content/policy versions. Independently sampled outputs remain independent. |
| Batch independent calls or use efficient local serving | Only batch within dependency boundaries. Measure latency, cost and behavior on the actual hardware/model; asynchronous provider batches suit offline evaluations better than interactive dependent steps. |

The current gateway already supports shared prefixes; the [social call](../simulation/src/run.ts) currently supplies only a persona-specific system prompt. Extracting common instructions is an early optimization candidate, not a measured saving.

**Response caching has a narrower role than prefix caching.** Recorded responses are appropriate for replay and deduplicating the same operation. Reusing them across fresh replicates would erase intended variation and must not be counted as new independent evidence. Semantic answer caches across different personas are excluded from the initial design.

One budget ledger covers all model-backed phases, including retries, summarization, judging, and report writing. Reserve conservative request cost before dispatch using known pricing, input bounds and output/reasoning caps; reconcile returned usage, keep unknown charges reserved, and stop admission if a safe estimate cannot be made. Record setup cost separately and include it in end-to-end comparisons when population authoring is part of the experiment. Keep deadlines active through final analysis. Cancellation prevents new work but cannot guarantee that an already dispatched request will not be billed.

Comparison runs reserve allowance for evidence extraction and final synthesis before admitting additional persona/task blocks. Store shared source captures once with their provenance; do not count reuse as repeated verification. Account for target/task coverage and analysis cost explicitly. The comparison revision may add model work; measure it against the existing pipeline rather than promising unchanged cost. If allowance ends, publish the evidence matrix with partial coverage and the unresolved decision, not an invented winner.

Measure calls, tokens, cache usage, retry reasons, queue wait, model latency, active browsers, projection time, peak memory, recorded cost and cost uncertainty. Report setup, execution and analysis separately. No speedup claim is accepted without a reproducible workload and a behavioral non-inferiority comparison.

## 7. Libraries and adoption decisions

These are proposed choices, not installation instructions. Pin compatible versions and lockfile at implementation time after checking Node/Electron support, licensing, maintenance, deterministic behavior, bundle/native requirements, and a small integration benchmark. Keep library-specific objects behind public JSON contracts or internal adapters.

| Library | Proposed role | Decision and limit |
| --- | --- | --- |
| [Vercel AI SDK](https://ai-sdk.dev/docs/introduction) and [Zod](https://zod.dev/) | Provider adapters and structured input/output validation. | Keep the existing stack. Simulation policies and quota/budget semantics remain ours. |
| [Graphology](https://graphology.github.io/standard-library/) with [metrics](https://graphology.github.io/standard-library/metrics.html) and [generators](https://graphology.github.io/standard-library/generators.html) | Graph representation, assortativity and degree measurements, clustered/random secondary controls. | **Adopt for metrics.** The app already depends on it, so this moves an existing dependency into the runtime. Its generators give Erdős–Rényi and clustered graphs, not the degree-preserving rewiring that is the primary null (§4); that stays in-house. Use supported seeded RNG hooks; generators do not provide calibrated human networks. |
| [simple-statistics](https://simple-statistics.github.io/docs/) | Run-level mean, variance, quantiles and bootstrap resampling of whole replicates. | **Adopt in the evaluation layer only.** ESM, typed and maintained. It has no Student t quantile, which a handful of replicates needs in place of z; a thirty-row table of 95% t quantiles is one array beside it. jStat would supply the quantile but is UMD, typed through a separate package and barely maintained, so it is not adopted. The Wilson function in the report stays hand-written. Library functions do not decide the unit of inference. |
| Node SQLite and existing Playwright integration | Local durable runs, contained browser interaction. | **Keep** and adapt; preserve host restrictions, observe-only rules, login handling and evidence capture. |
| [graphology-communities-louvain](https://graphology.github.io/standard-library/communities-louvain.html) | Optional community diagnostics. | **Later**, when an evaluation reads community diagnostics. Fix resolution/RNG; an algorithmic community is not automatically a real social group. |
| [p-queue](https://github.com/sindresorhus/p-queue) | In-process execution queues, concurrency and cancellation plumbing. | **Not now.** The run's `inParallel` is about 15 lines and covers today's needs. Revisit if concurrency should rise again after a throttle. It would not implement token quotas, billing reservations or deterministic order in any case. |
| [Promptfoo](https://www.promptfoo.dev/docs/usage/node-package/) | Development/evaluation tool for prompt/model comparisons and custom assertions. | **Not now.** It brings its own provider layer, which would bypass the gateway and allowance ledger. Extending the existing acceptance harness is cheaper. |
| [pure-rand](https://github.com/dubzzz/pure-rand) | Reproducible PRNG and stream allocation. | **Skip.** The engine already derives an independent stream per stable key with `fnv1a` and `mulberry32` (for example `follows/<seed>` in [social/graph.ts](../simulation/src/social/graph.ts) and `profile/<seed>/<segment>/<attribute>` in [profile/sample.ts](../simulation/src/profile/sample.ts)). Document that allocation instead; switching generators changes every saved realization for no scientific gain. |
| A tokenizer such as js-tiktoken | Exact token estimates. | **Skip.** Estimates only gate admission and rate buckets; actual usage comes back from providers. Reading provider rate-limit headers would improve the limiter more. |

[OASIS](https://github.com/camel-ai/oasis) is a reference for social actions and recommendation mechanisms. [Concordia](https://github.com/google-deepmind/concordia) is a reference for component-based agents, memory and environment resolution. Both would add Python integration if adopted wholesale. Study or benchmark selected mechanics first; neither framework establishes Gnomi's validity or performance.

[vLLM](https://docs.vllm.ai/en/latest/) is an optional deployment experiment for open models using continuous batching and prefix caching. Keep it outside the runtime dependency set and compare total hardware/hosting cost and measured quality. A generic agent orchestration framework or vector database is not an initial requirement; introduce one only for a measured capability gap.

## 8. Portable API, persistence and recovery

This section is phase 2 (§2): build it when a headless or hosted runner needs it, not as part of the move.

### Public contract

Use versioned JSON request/response and event schemas shared by the desktop adapter and standalone runner. Internal ports may contain callbacks or `AbortSignal`; wire payloads cannot contain them, Zod instances, graph objects, browser pages or database handles.

```typescript
// Illustrative contract shape; not an implemented API.
type Command =
  | { protocol_version: 1; command_id: string; method: 'start';
      idempotency_key: string; manifest: RunManifest }
  | { protocol_version: 1; command_id: string; method: 'cancel'; run_id: string }
  | { protocol_version: 1; command_id: string; method: 'resume_personas';
      idempotency_key: string; run_id: string; persona_ids: string[];
      intervention_id: string }
  | { protocol_version: 1; command_id: string; method: 'status'; run_id: string }
  | { protocol_version: 1; command_id: string; method: 'events';
      run_id: string; after_seq: number; limit: number }
  | { protocol_version: 1; command_id: string; method: 'result'; run_id: string }
  | { protocol_version: 1; command_id: string; method: 'artifact';
      run_id: string; artifact_id: string };
```

`RunManifest` is a JSON schema containing experiment/treatment/replicate identities, realized population and graph or their immutable blob references, input/environment hashes, policies, model/provider/deployment identifiers and supported sampling options, prompt/schema hashes, code/dependency versions, RNG allocation, budget/deadline/failure rules, and analysis/stopping definitions. For a comparison it also freezes the brief, target/POI mapping, task/criterion rules, eligibility, access scopes and realized target order (§3.2–§3.3). Persist those comparison fields in the existing run snapshot first; they do not depend on phase 2. Store actual overrides and interventions as subsequent events. Secret material is supplied through a separate private adapter/bootstrap channel and is not part of the manifest.

`start` atomically claims its idempotency key and request hash in the run store. Same key/body returns the existing run and status; same key/different body returns a conflict. Keep the claim for the run's retained lifetime. Use one typed error envelope with codes such as `invalid_request`, `unsupported_version`, `conflict`, `not_found`, and `resource_unavailable`. Event pagination returns a stable sequence cursor; reconnecting clients deduplicate by run and sequence and can rebuild from a snapshot plus later events. Results are available as partial while a run is active or interrupted.

`resume_personas` records a declared intervention and refreshes the private environment/session adapter for selected blocked personas in a still-live run. Atomically deduplicate its key and request hash as for `start`; repeating an intervention must not repeat browser actions. It is not permission to recover an unknown browser action after a crash. Artifact reads resolve only artifacts owned by the requested run and return content type/hash plus bounded content or a transport-managed stream, never arbitrary filesystem access.

Expose `accepted`, `running`, `completed`, `partial`, `cancelled`, `failed`, `interrupted`, and `needs_intervention` states with explicit transition reasons. Normal execution moves from accepted to running to a terminal result. A live run may require intervention and return to running; an interrupted live browser run cannot take that path without the separate reset/restart policy. Scientific validation status is separate. The first transport is local messages/JSON-lines with bounded payloads and asset references; logs go to a separate diagnostic stream. The remote adapter is deferred.

### Storage and recovery

The simulation runtime is the single owner of new run storage, proposed under `<project>/simulation/` with its own SQLite database and content-addressed blobs. New run IDs use `sim-<UUID>` to avoid collisions with legacy project-local IDs such as `r-0001`. The project database keeps legacy logs and a rebuildable secondary index of new runs. Run acceptance commits only in the authoritative simulation store; the facade reconciles the secondary index after a crash, rather than requiring an atomic transaction across both databases. The engine facade queries new run data through the public boundary. Avoid two lifecycle owners: current [openProject()](../simulation/src/log/sqlite.ts) marks running rows interrupted on open, so it cannot safely be reused as an independent second writer.

Before accepting an executable manifest, ingest static imported inputs into the run's content store or verify existing immutable blobs against their hashes. Later edits to project assets must not change a run. Live web inputs retain their declared environment limitations; each actual observation is captured separately. The public artifact contract supplies screenshots and report evidence to the app without exposing storage internals.

Persist operation intent before external effects. Commit accepted decisions, simulation events and corresponding transcript/input references atomically, then publish them. Store screenshots and other model inputs by content hash and blob reference; image byte counts alone cannot reconstruct a request. Keep attempt-completion/cost telemetry separate from logical simulation event order.

Checkpoints occur at declared safe boundaries and include committed cursor, population/social/memory state, RNG state/allocation, pending operation IDs, remaining budgets/reservations, and environment recovery capability. Projection state can be rebuilt from the authoritative log. A checkpoint is not evidence that an arbitrary external browser action can safely be repeated.

Exactly-once application of a stored decision is achievable with transactional operation IDs; exactly-once provider billing or external website effects is not promised. An unknown outcome remains unknown until reconciled. Never automatically replay a potentially completed click or paid request simply because the worker died. Initially support exact replay and fixture-based recovery; interrupted live browser runs require a declared reset/restart or intervention, rather than claiming transparent durable resume.

## 9. Scientific evaluation and acceptance

### Verification, calibration, validation

**Verification** checks that the implementation follows the declared rules. **Calibration** fits parameters using designated evidence. **Validation** evaluates the frozen model on separate evidence for its intended use. These must have separate records and statuses. [Belfrage et al., 2024](https://www.jasss.org/27/4/4.html)

Use held-out human task observations where available: completion/abandonment, specific usability failures, action sequences, and changes following observed exposure. Separate calibration and validation by participants, studies or scenarios as appropriate; freeze splits and avoid near-duplicate leakage. Data used to author personas or tune prompts belongs in the calibration provenance. Interview-grounded agents have been assessed against the people represented, but that result does not transfer automatically to Gnomi's product or social tasks. [Park et al., 2024](https://arxiv.org/abs/2411.10109)

The first benchmark need not wait for a human study. [Gym](../gym)'s seeded-defect builds and control build (M3) give known ground truth for one narrow use: does the report find real usability defects and avoid inventing them? Track recall and precision against those defects per release. This validates defect detection on Gym, not human behaviour in general.

Compare against simple baselines and the legacy model. Two cheap controls belong in every evaluation: a **generic persona** with no profile attributes, whose findings show what the model says regardless of audience, and a **chronological feed**, which separates content effects from ranking effects. Record error by relevant segment and environment, as well as aggregate error. No human reference dataset means `NOT_VALIDATED`, even if all implementation and plausibility tests pass. The report must name its tested scope and untested populations/scenarios.

Use deterministic checks for factual references, schemas, legal actions, accounting and exposure. Semantic review uses a frozen rubric, a blinded human sample, reviewer agreement and adjudication. LLM judges may assist after comparison with human labels; their agreement is not human behavioral validation. Record judge identity and prompt separately from the simulated agents. By default the judge (`claude-sonnet-5-5`) shares a model family with the navigator and socialiser (`claude-haiku-5-5`); evaluation runs should be able to use a judge from another provider to limit self-preference. [Zheng et al., 2023](https://arxiv.org/abs/2306.05685)

### Replication, uncertainty and sensitivity

For each replicate, calculate outcomes at the run level, retaining segment numerators and denominators. Connected personas are not independent observations. For matched A/B worlds, calculate a difference per matched replicate, then estimate the mean difference and uncertainty across independent replicate pairs. Resample whole pairs/runs where using a bootstrap; do not bootstrap individual personas from one interacting graph as if they were independent humans.

Distinguish model-sampling variability, population/network variability, parameter sensitivity and human-data uncertainty. Intervals over synthetic replicates describe the specified simulator, not automatically the human population. Report the repeat count, analysis method and limits; a small number of seeds may not support a useful interval. Choose the confirmatory repeat count from pilot variance and a predeclared precision/power goal, or use a valid predeclared sequential rule. Budget exhaustion yields an incomplete/inconclusive result rather than statistical sufficiency.

At minimum compare social-on/off, chronological/ranked feeds, legacy/alternative networks, and full/optimized inference. Add memory, activity, influence-policy and model/prompt sensitivity where relevant to the question. Predefine plausible ranges, record sign reversals, and use broader sensitivity designs where interactions matter. [ten Broeke et al., 2016](https://www.jasss.org/19/1/5.html)

The existing M4 complaint-spread expectation is a regression check under an imposed network. Its five seeds and plausibility review are useful fixtures, but do not establish empirical validity. Report normalized same-segment/cross-segment reach alongside raw counts and eligible populations.

### Acceptance matrix

| Dimension | Required evidence before claiming success |
| --- | --- |
| Containment | Standalone scripted run works without Electron; import checks prohibit app/engine internals; public schemas reject invalid requests. |
| Correctness | No self-follow or forbidden exposure; decisions cite only permitted evidence; failed requests are distinguishable from silence; budget and terminal-state invariants hold. |
| Reproducibility | Event replay and recorded-input execution yield identical committed logical state, decisions and scientific outcome metrics; randomized response delays and permissible concurrency changes do not change these outcomes. Operational timing/queue telemetry is excluded from this equality check. |
| Persistence | Failure-injection tests cover intent/result/commit boundaries, deduplication and cursor recovery; no silent replay of unknown external effects. |
| Behavioral validity | Frozen held-out human benchmark, declared metrics/error margins, baseline comparison, and subgroup results pass for a named scope. Absent evidence is `NOT_VALIDATED`; insufficient precision is `INCONCLUSIVE`; a completed evaluation that fails its criterion is `FAIL`. |
| Robustness | Declared ablations and parameter/model sensitivity are reported; unresolved material reversals prevent a broad robust-result claim. |
| Efficiency | Against the frozen baseline, cost/time improve under the predeclared analysis. Independent paired-run estimates satisfy a predeclared inferential rule and confidence level: one-sided non-inferiority for increased behavioral error, or two-sided equivalence when preserving outcomes. Point estimates inside a margin alone are insufficient. Imprecision is `INCONCLUSIVE`; missing usage or an unmatched workload cannot establish a pass. |

Numeric behavioral tolerances, efficiency targets and sample sizes must be selected from the first benchmark's use case and pilot evidence **before** confirmatory measurement. This document deliberately makes no unsupported universal accuracy or speed target. Until those benchmark fields are filled, scientific/efficiency acceptance stays `NOT_RUN` or `INCONCLUSIVE`, not `PASS`.

Each result includes experiment/model versions, completion/missingness, costs and uncertainty, effect estimates and interval scope, evidence references, assumptions/deviations, validation coverage, and the five separate evaluation dimensions. Persona certainty is never displayed as a confidence interval for a product conclusion.

### Comparison acceptance cases

Use local scripted/recorded fixtures with known facts, defects and restrictions; no live vendor access is needed for these checks. Keep tests beside the existing runner, POI and report code. Unit tests verify evidence attribution and denominators; integration fixtures exercise scheduling and policy failures; app/HTML/Markdown checks verify that the same decision and limitations reach the reader. Passing these tests verifies the comparison implementation, not human purchasing behavior.

| Fixture / trigger | Required result |
| --- | --- |
| Four public ATS homepages; goal is tool selection. | Shared vendor-evaluation tasks and a four-column matrix; no invented comparison directory, invitation or candidate-review task. An invalid persona task is flagged, not counted as a vendor defect. |
| All targets are observe-only, with no owned tool; buyer segments are included. | Every eligible target receives evidence and comparison coverage. No dependency on a full-mode baseline or user-kind segment. |
| One tool has several pages/assets; another is a text/design prototype. | Evidence maps to the correct target and criterion once. Unsupported live-workflow comparisons are marked unknown, with artifact scope shown. |
| Two authenticated targets use the same persona role. | Separate target sessions and fixtures; no account, memory or private-data leakage across vendors. Missing setup blocks only the affected task. |
| Independent episodes are reordered; synthetic responses remain fixed. | No baseline-first prerequisite or survey leakage. Target metrics and supported findings remain unchanged; recorded order is correct. Buyer-journey carryover remains explicit and separately analyzed. |
| Required login/API/CDN request is blocked; an unrelated tracker is also blocked. | The affected task/criterion shows the restriction and limited coverage; no automatic product defect. An unrelated blocked tracker does not invalidate otherwise supported evidence. |
| Login is the assigned task: one target lacks valid test credentials; another has valid credentials and an observed product login defect. | The first is environment-blocked; the second is a valid task failure with supporting evidence. Both causes and their denominator treatment are visible. |
| A candidate-profile quote is offered as pricing evidence; a generic console error as feature confirmation. | Both mismatched citations are rejected. Repetition or a high-confidence model label cannot promote them to confirmed findings. |
| One plan has a stated price, another requires a quote, and a cheaper tier excludes the scenario's company size. | Visible terms and eligibility are preserved; quote-only cost is unknown, not unaffordable, free or zero. No false cheapest-tool verdict. |
| The same plan meets the small-team scenario but excludes the enterprise scenario. | Separate scenario assessments and recommendations; no averaged fit label or cross-scenario paired metric. |
| Two sources contradict each other, or a persona dislikes a feature that was successfully observed. | Keep the conflict and distinguish capability, task outcome and opinion. The narrative cannot erase contrary evidence. |
| Five personas are scheduled for both tools; A has 3 completions, 1 task failure, 1 environment block; B has 2 completions, 1 abandonment, 2 global budget stops. | A shows 3/4 valid attempts and its block; B shows 2/3 and its two incomplete episodes. Pair overlap comes from persona/task IDs, never the smaller denominator; no unconditional winner from unequal coverage. |
| Of four assigned episodes, one succeeds, one exhausts its planned task effort, one is globally interrupted and one invents a different task. | Completion is 1/2 valid attempts. The effort-limit failure remains in the denominator; incomplete and invalid-task exclusions are visible and cannot become preference votes. |
| Preference collection has 2 A, 1 B, 1 tie, 1 neither suitable and 1 insufficient-evidence answer, plus 1 gate exclusion, 1 not collected, 1 failed call and 1 invalid response. | A is 2/6 valid answers; all answer counts and four excluded/missing responses are visible. No missing call becomes a tie. All-tool preference cannot be reconstructed by summing pairwise votes. |
| Owned tool loses a criterion to a competitor; a different criterion favors the owned tool. | Both differences cite evidence for both sides and the relevant segment. Owner actions address the owned tool; buyer mode instead supplies selection conditions and follow-ups. |
| All tools have equal supported outcomes, or every decisive criterion is unknown. | No forced differentiation. Report parity or insufficient evidence and the specific next check needed to decide. |
| Synthesis fails or the run ends before all targets are covered. | Export the deterministic matrix, coverage and stop reasons. Do not mark the study as a completed selection because one tool's task succeeded. |

Review the resulting report against the r-0001 failure examples in §3.1. A reviewer should be able to locate the scoped recommendation, compare every target on the same criteria, trace each material claim and identify the next action without reading transcripts. This usefulness check complements deterministic fixtures; neither is a claim of behavioral validation.

## 10. Compatibility and review decisions

Extract the current behavior behind the new boundary before changing social mechanisms. Prove parity with scripted and recorded fixtures; fresh model output equality is not a migration requirement. Keep legacy readers and the old behavior version available during comparison. Introduce new model/event schema versions explicitly; do not reinterpret old influence edges as causal effects or rewrite historical results under new rules.

The engine compatibility facade preserves existing app commands and translates run events/projections. Preserve containment, recorded-login handling, cost interruption, locale behavior, and report/evidence access during extraction. The new store is additive; any legacy data conversion needs a separate reversible migration design.

Comparison contracts and report projections need explicit versions. Preserve single-target research behavior and legacy report readers. Old runs lacking task/criterion/target attribution remain labeled legacy; do not backfill invented coverage, silently split `no_preference`, or relabel their votes as validated comparisons. Optional reanalysis must preserve the original artifact, declare its source limitations and label any new interpretation. Keep report generation and exports on the same comparison projection so the app and downloaded report cannot disagree.

Current verification commands remain executable from the repository root:

```sh
npm test
npm run typecheck
# Optional free structural rehearsal; choose a fresh output directory.
npm run acceptance -w @gnomi/simulation -- --m4 --out /tmp/gnomi-m4-baseline-review
```

The workspace has its own `test`, `typecheck`, `cli` and `acceptance` scripts. A replay command does not exist yet. Live evaluations require an explicit configured allowance and must report actual model routing, environment and source revision; this documentation task runs no paid evaluation.

### Completed foundation

Steps 1–6 describe the completed foundation recorded in the opening status. They added no model calls to an everyday run; evaluation runs spend live tokens and need an explicit allowance. Preserve their parity and scientific checks while implementing the comparison revision.

| Step | Change | Cost |
| --- | --- | --- |
| 1 | Phase 1 move into `simulation/` with the boundary test (§2). | Large, mechanical; no behaviour change. |
| 2 | Carry post ids on heard posts and record them on step and friction events; count first-hand reports separately from social echoes, discounting `reported` frictions only (§4). | A few event-payload lines plus report code; changes the ranking of social runs. |
| 3 | Record social answers in population order after each phase; log feed positions and shuffle ties by seed; request per-role temperature and record what was accepted with the model version; require a prior opinion for an influence edge (§4, §5). | Small changes; same calls and tokens. |
| 4 | Graphology metrics in the runtime; degree-preserving rewiring plus random and clustered null networks as evaluation options (§4, §7). | Small; one existing dependency and about twenty lines. |
| 5 | Evaluation harness: repeat-N runs, generic-persona and chronological-feed controls, Gym defect recall, run-level statistics (§9). | Tokens per evaluation, not per user run. |
| 6 | ODD description and parameter provenance for the corrected model (§3). | Writing time. |
| Later | Phase 2: run store, protocol and recovery (§8). | Large; only when a headless or hosted runner needs it. |

### Next: comparison delivery

Deliver these slices inside the existing runtime before considering phase 2. Each slice includes its relevant §9 fixtures; the complete comparison experience requires all five. Use existing TypeScript discriminated unions, Zod boundary validation and colocated tests. No new dependency or hosted service is required by this design.

| Slice | Scope and existing touchpoints | Exit evidence |
| --- | --- | --- |
| 1. Explicit study | Versioned brief, targets, tasks, criteria and target-specific access/session assignments in [types.ts](../simulation/src/types.ts), [POI eligibility](../simulation/src/poi/pois.ts), and engine/app setup. Preserve legacy decoding. | All-public, buyer, multi-artifact and prototype studies validate without inferring identity from permission mode. |
| 2. Comparable episodes | [run.ts](../simulation/src/run.ts), [agent prompts](../simulation/src/agent/prompt.ts), and [POI comparisons](../simulation/src/poi/compare.ts): neutral tasks, preflight, isolated target context, recorded order and outcome/coverage events. | Fixed task fixtures reject invented assignments; reorder, session-isolation and partial-block cases pass. |
| 3. Evidence and metrics | Target/scenario/task/criterion observations, recorded semantic assessments, positive evidence, restriction attribution and pure per-target/paired projections in [report/build.ts](../simulation/src/report/build.ts) and [report/compare.ts](../simulation/src/report/compare.ts). | Citation, contradiction, denominator and missingness fixtures pass; replay uses recorded assessments and the matrix remains available without model synthesis. |
| 4. Decision and actions | [report/models.ts](../simulation/src/report/models.ts) synthesizes only the validated matrix; optional final preferences follow sufficient exposure. Keep the allowance active. | Supported tradeoffs, parity/inconclusive cases and correct owner/buyer actions; every comparative claim has evidence on both sides. |
| 5. Reader experience | [Report.tsx](../app/src/renderer/src/Report.tsx), [HTML export](../app/src/renderer/src/reportFile.tsx), and [Markdown export](../simulation/src/report/markdown.ts) share the decision-first projection. | The §3.5 layout and r-0001 usefulness check pass across exports, including partial and legacy results. |

No paid rerun is required to revise this document or verify the scripted cases. A later live pilot needs a configured allowance and correctly scoped vendor access. Measure coverage, useful evidence and supported decisions before increasing persona count.

Scientific review decisions still needed:

1. Retain the implemented `simulation/` workspace and local-process boundary; remote hosting remains deferred.
2. Choose the first validation task/population and identify usable human reference evidence. Without it the first release remains exploratory.
3. Freeze the first benchmark, precision/non-inferiority margins and spending envelope after a pilot; then decide which optional libraries earn adoption.

Always preserve evidence provenance, declared experiment semantics, compatibility and measured failure states. Implementation, dependency installation, production-data migration and hosted deployment are follow-up work, not part of this draft. Never manufacture human evidence, call unmeasured targets achieved, or hide incomplete replicates to improve a result.
