# Simulation review: report accuracy

Reviewed 2026-10-19 on `main` at `a8a90cd` (PR #40 merged plus later commits), by four independent readers with separate lenses: the report pipeline, social scheduling and reproducibility, persona behaviour and evidence, and statistics. Each finding names its file and line, what goes wrong, and the smallest fix. "Verified" means the orchestrator re-read the code on `main`; "probed" means the reviewer reproduced it with a throwaway script. Severity: **high** = a number or label in the report is wrong or systematically biased; **medium** = wrong in some runs or a missing safeguard; **low** = clarity or rare.

Every finding below was addressed on branch `claude/report-accuracy-fixes`, except three limits. Defect matching pairs themes and Gym defects on page only, because the defect catalogue has no element field, so recall and precision stay `NOT_RUN`. Projects whose saved persona schema still carries the old patience text keep it in their prompts until the schema is re-saved. No live run has exercised the Gym reset, the seeded arm order or cohort admission; they are covered by scripted tests only.

## 1. Trust and corroboration

| Sev | Where | What happens | Smallest fix |
| --- | --- | --- | --- |
| high | `simulation/src/report/friction.ts:114,153,157-167` (verified, probed) | Every signal, including console errors and backtracks, becomes a candidate keyed by whatever element the persona clicked that step, and any signal within 3 steps on the same page upgrades a self-report to `confirmed`. One complaint plus a background console error on a page five personas visit becomes "confirmed, strong, 5 of 5". | Key unmatched `error` candidates by `[poi, page, 'error', text]`; let only `failed_action`, `validation_error` and HTTP errors upgrade a report; never `backtrack`, `loop` or console errors. |
| high | `signals/index.ts:15,17,36,69`; `browser/page.ts:23` (probed) | Signals that are model or engine artefacts count as product failures: a malformed `ref` gives `ref_not_found`; three `read` or `invalid_output` steps give `loop`; a placeholder like "Enter a job title" matches the validation regex. | Drop `ref_not_found` from `FAILURES`; skip `read`, `wait` and `invalid_output` steps in `loop()`; require `[invalid]` for textbox lines. |
| high | `report/themes.ts:58-60,296` (verified) | A theme's trust is the maximum over members, so one confirmed member among nine reports labels the theme "Confirmed" and doubles its score; three reports plus one distant signal label it "observed: an objective signal only". | Keep per-theme trust counts and render "1 confirmed, 3 reported"; score by the mix, not the max. |
| medium | `signals/index.ts:19,29,90`; `browser/page.ts:91,113,150-154` | Errors are attributed to the page before a navigation; `no_effect` fires for `target=_blank` links, saves slower than 250 ms, and search boxes with no Enter key; exceptions caused by containment blocking a script count as product errors. | Use `url_after` for `signal.error`; add a `press` action; adopt popup URLs; suppress `no_effect` when a request was in flight; ignore errors in steps with a `containment.blocked_request`. |
| medium | `agent/loop.ts:183-184`; `report/themes.ts:295` (probed) | One persona reports the same problem on eight consecutive steps; theme severity is the median over members, so that persona's 4 outvotes three others' 1. The survey restates the frictions in a separate group. | Skip a friction whose normalised text repeats on the same page; take severity per persona before the median. |
| medium | `agent/loop.ts:184`; `report/friction.ts:110` | A friction is grouped under the element the persona clicks *next*, not the one that caused it, so two personas hitting the same Save bug land in different groups. | Add a nullable `about_ref` defaulting to the previous step's target when that action failed. |

## 2. Outcomes and completion

| Sev | Where | What happens | Smallest fix |
| --- | --- | --- | --- |
| high | `report/build.ts:70-87,115-140` (verified, probed) | `endingOf` takes the first `goal_done` across all of a persona's POIs and lets it override an abandonment elsewhere. Done on a text POI then abandoned on the web app counts as done; completion, the weighted headline and dimension rates all overstate. | Compute outcomes per (persona, POI); report completion per POI, or count a persona done only when every non-competitor POI ended done. |
| high | `run.ts:500`; `seams.ts:45`; `report/build.ts:76,99` (verified, probed) | Personas start in segment-then-slot order, so any stop (budget, projection, wall clock) cuts the population by segment. Never-started personas count as `incomplete` in the completion denominator, so the segment table reports a gap that is pure scheduling. | Start in a seeded, segment-mixing order; give never-started personas a `not_started` outcome outside the denominators. |
| medium | `agent/prompt.ts:158,313` (verified) | The prompt says "gives up after about N actions" and shows "Step n of N", so abandonments near the budget are partly the budget showing through, yet they are recorded as the persona's own choice. | Show the step number without the total; drop the budget clause. |
| medium | `agent/loop.ts:163-166,200-210`; `agent/prompt.ts:366` | Three invalid model outputs end the episode as `repeated_failure` and the survey says "the same action failed three times", blaming the product. Non-English thoughts on a non-English site trigger this. | Exclude `invalid_output` from the failure streak; end with a distinct engine reason. |
| medium | `report/build.ts:145`; `dimensions.ts:58` (probed) | "Ran into friction" counts self-reports only, so personas with failed clicks and an abandonment show 0% with friction while a theme counts them. | Count any candidate in a non-objection theme, or rename the column "Reported a friction". |
| low | `report/build.ts:255` vs `acceptance/run.ts` | The report headline completion is share-weighted; the harness's is unweighted. No unweighted figure is shown in the report. | Show both. |

## 3. Social echo and attribution

| Sev | Where | What happens | Smallest fix |
| --- | --- | --- | --- |
| high | `report/spread.ts:68,79,89`; `themes.ts:283-291,567` (verified by three reviewers) | "First-hand" means three things: theme prevalence uses the echo-filtered k; per-segment "affected" rows count everyone; the spread section counts every persona with an event in the theme as first-hand, so echoes appear as independent discovery and contradict the theme card. | Store the first-hand persona ids on `ReportTheme` and use them in segments and spread. |
| high | `app/src/renderer/src/Report.tsx:79-100,235-257,385-389` (verified: `heard_first` is not rendered anywhere in `app/src`) | The app never shows the heard-first count. A theme with four reporters, three of whom read about it first, shows "One persona, 1 of 10" beside an Affected bar of "4 of 10" and sits under "Single reports". k = 0 shows "0 of N". | Render "+N more after reading the feed" beside the share as the markdown export does; rename the fold "Met first-hand by one persona"; label k = 0 `none`. |
| medium | `report/themes.ts:536` (verified) | When the judge ran but tagged no posts, `themeTags` is an empty Map, so the heard-id fallback is skipped and no limitation is added. Every echo counts as first-hand. | `const themeTags = judged && tags?.tagged.size ? tags.tagged : null`, or make `echo()` return tagged OR heard. |
| medium | `run.ts:494` (verified) | A hard stop (recorded cost cap, tripwire, error) discards every staged social answer already paid for, with no event; the log shows feed views and silence. | Record a `social.discarded` event per staged answer, or a report limitation naming the round and count. |
| medium | `report/spread.ts:48` | "Segments reached" is posters plus influence targets; `social.feed_viewed` is never read. Ten independent posters show as spread; a segment shown a complaint that stays silent shows as not reached. The harness measures reach from `feed_viewed`, so report and evaluation disagree. | Compute reach from `feed_viewed` and `heard_post_ids`; show posters separately. |
| medium | `agent/loop.ts:180`; `poi/text.ts:110`; `poi/design.ts:112`; `social/influence.ts:29` | Opinion changes during product use after hearing posts cite `post_ids: []`, so word of mouth that reaches the product never draws an edge or counts as influence. | In `influenceEdges`, follow `step_ids` to the step's `heard_post_ids` and emit a `heard` kind. |
| low | `social/influence.ts:29-31`; `engine/src/graph/index.ts:148` | One opinion change citing two posts by the same author gives two edges with the full delta each. | Deduplicate by (from, to, change seq). |
| low | `report/spread.ts:72`; `influence.ts:31`; `themes.ts:97` | Posts with `about_poi_id: null`, likely for replies, drop out of spread, influence and echo detection, so a persona shown such a complaint counts as first-hand. | Replies inherit the parent's POI; a null post in a one-POI project is about that POI. |
| low | `run.ts:327`; `agent/prompt.ts:534` | The feed shows a reply's parent clipped to 120 characters, but the parent id is not in `feed_viewed.post_ids`, so exposure through a quoted parent is missed. | Add `parent_ids` to `feed_viewed`. |
| low | `themes.ts:321-324`; `run.ts:502` | Without judge tags the fallback compares seqs across personas, which is completion order within a slice; every stopped run has no judge, so this applies to all of them. | Compare by (round, step_no). |
| low | `agent/loop.ts:70` | A product episode starts with no opinion even when a social phase already gave one for that POI, so the first step logs `before: null`. | Start from `currentOpinion(persona, poi)`. |

## 4. Prevalence and ranking

| Sev | Where | What happens | Smallest fix |
| --- | --- | --- | --- |
| medium | `report/themes.ts:300` (probed) | Score = Wilson lower bound × severity × trust weight. The lower bound is convex in k, so a confirmed severity-4 blocker met by one persona scores below a reported severity-1 irritation met by four. | Rank by severity tier then lower bound, or use the point estimate with the bound as tie-break, or list single confirmed severe themes apart. |
| medium | `report/themes.ts:297` vs `:285-292` | The prevalence denominator is everyone who used the POI, while segment rates use page reach. A defect on a page only 10 of 50 personas can reach is capped at 20% and can never be `strong`. The computed `impact` is unused. | Use the theme's page reach as `exposed`, or include `impact` in the score. |
| medium | `report/friction.ts:149`; `themes.ts:297` | Buyer objections are divided by every persona who used the POI, users included: "2 of 20 (10%)" when both buyers objected. | For all-objection themes, divide by personas who answered a buyer survey on that POI. |
| medium | `app/src/renderer/src/Report.tsx:96`; `report/markdown.ts:165` | The tooltip says "the true share could plausibly be anywhere from", presenting a within-run range over correlated synthetic personas as a population estimate, which the design says the report must not do. | Reword to "among this run's simulated personas, assuming independence; not an estimate of real users". |
| low | `report/themes.ts:337` | `prevalence(0, n)` is labelled `single`. | Add `none`. |
| low | `Report.tsx:83-84,369` vs `markdown.ts` | The app sorts by evidence level, then severity, then score; the export uses the engine rank. The app's intro says personas-first, which its sort does not do. | Sort by `rank` within level, or reword. |
| low | `themes.ts:279` | The docstring says score = impact × …; the code uses `share.low`. `impact` is never shown. | Show it or drop it; fix the docstring. |

## 5. Surveys, sentiment and perception

| Sev | Where | What happens | Smallest fix |
| --- | --- | --- | --- |
| high | `agent/prompt.ts:402-411`; `run.ts:223-229`; `agent/buyer.ts:57-66` | The end survey receives only how the episode ended, the step count and the friction texts: no thoughts, pages or current opinion. Sentiment and would-continue are anchored on a list of problems, and "what went well" is invented from the product description. The prompt still says "answer from what you saw". | Pass the folded opinion and the last five thoughts into `surveyParts` and `buyerParts`, as `socialParts` already does. |
| high | `agent/prompt.ts:373-375,386-397`; `poi/compare.ts:33-34` | On a competitor POI the survey system prompt still says "has just used <team product>" and asks "would you keep using <team product>", so competitor sentiment and objections can describe the wrong product; the comparison hint only appears when the team POI was surveyed earlier. | Use `poi.name` whenever `poi.mode === 'observe_only'` and name the product consistently; state the browse-only limit beside the comparison. |
| medium | `report/themes.ts:408-421`; `agent/buyer.ts:93`; `Report.tsx:157-159` | Sentiment keys by persona and POI and includes buyer surveys, so one persona on two POIs counts as "surveyed: 2" with +2 and −2 averaging to 0, and "% would carry on" blends users' would-continue with buyers' would-buy. | Skip buyer answers in `sentimentBySegment`; split sentiment by POI or rename the column "Answers". |
| medium | `browser/prune.ts:137`; `page.ts:277`; `agent/prompt.ts:139` | Pages under 16k characters are sent whole, so below-the-fold content is visible to a persona told it "rarely scrolls far". Missed-content frictions cannot occur and low-skill personas succeed more than they would. | Mark lines with `dist > 0` as off screen, or omit them until the persona scrolls. |
| medium | `agent/prompt.ts:316`; `llm/gateway.ts:210`; `profile/schema.ts:50` | DeepSeek routes strip the screenshot but the prompt says "the screenshot is your screen"; `connectivity: flaky` is prompt-only with no throttling, inviting invented slowness frictions. | Pass `screenshot: null` for DeepSeek and flag the report text-only; drop `connectivity` from prompts until simulated. |
| medium | `poi/text-prompt.ts:59`; `poi/text.ts:41-52,116-117` | The text question presupposes something is unclear; a one-character quote links a passage; an unfound quote keeps its friction with no flag. | Ask "what does X make of it and do next"; require 3 words or 15 characters; mark `quote_unverified`. |
| medium | `poi/design.ts:116`; `design-prompt.ts:51,118` | A design expectation mismatch with no friction text is filed as a neutral description of the next frame, on that frame, at severity 2. The question "is this what you expected" is asked on every screen. | Set the text to the expectation and what the flow showed, and file it on the previous frame. |
| medium | `browser/contain.ts:120`; `page.ts:302` | On observe-only competitor sites, a background POST (analytics) during a click records the click as `submit_blocked`; three in a row end the episode as `repeated_failure`, skewing the comparison. | Count only navigation requests, or writes started by a click inside a form. |
| medium | `browser/inspect.ts:4,34` | An unanchored `/(auth|sso|…)/` matches `/authors`; any visible password field reads as a login page, so "change password" blocks the persona as `session_expired`. | Anchor to path segments; ignore `autocomplete="new-password"`. |
| low | `run.ts:216`; `agent/buyer.ts:73` | Surveys run on the navigator model; tech.md says a strong model. | Route surveys to the judge role, or fix the doc. |
| low | `agent/prompt.ts:195,249-259` | "Surprised" counts as friction; the six-step digest drops which elements were tried, so retries create loop and backtrack signals blamed on the product. | Say "unpleasantly surprised"; list distinct (page, element, result) in the digest. |

## 6. Competitor and at-a-glance

| Sev | Where | What happens | Smallest fix |
| --- | --- | --- | --- |
| high | `report/build.ts:192`; `Report.tsx:154,161-163` (verified: no competitor filter) | Themes include observe-only competitor POIs, and the at-a-glance card picks "Fix first" and counts "Problems to fix" from all of them. The card can tell the team to fix a competitor's pricing page. | Filter out themes whose POI is a competitor in `Glance`. |

## 7. Evaluation harness

| Sev | Where | What happens | Smallest fix |
| --- | --- | --- | --- |
| high | `acceptance/checks.ts:133-137` (verified, probed) | Recall and precision credit a theme for every Gym defect on any page it touches. Two themes on two pages give recall 0.52; nearly every page carries a defect, so precision is near 1 by construction. The arm differences measure page coverage. | One-to-one assignment on page plus element or kind; until reviewed mappings exist, report these as `NOT_RUN`, not as metrics. |
| high | `acceptance/run.ts:621,634-643`; `gym/server.ts:206,279-306` | One Gym serves every replicate and arm in a fixed order with `reset: false`; created jobs and invited users accumulate, so later arms see state the earlier ones made. The scripted rehearsal cannot show it. | `POST /__reset` before each run; shuffle arm order per replicate with a seed. |
| high | `acceptance/fixture.ts:118-127` (verified) | The generic persona keeps name, pronouns, country, device, accessibility needs, seniority, company size, familiarity and motivation; only attributes, title, industry, background, context, voice and the two levels change. The control understates how much the profile drives findings. | Set the built-in fields to constants (desktop, no accessibility need, one locale) or disable them for the prompt purpose in the arm's schema. |
| medium | `social/graph.ts:61` (probed by two reviewers; the implementer noted it) | `clustered` assigns nodes to clusters at random, not by segment, and is sparser; measured modularity about 0 against 0.37 for legacy. odd.md says "one cluster per segment". | Build clusters from `segment_id` with the existing stream, or rename and document it as random clusters. |
| medium | `acceptance/checks.ts:151` (probed) | Zero variance prints a zero-width interval, "0 to 0", for about sixty rows; two identical pairs are not certainty. | Return null bounds with a "no variation" note; require three pairs for any interval. |
| medium | `acceptance/run.ts:651-660` | Per-arm means average over each arm's own finished replicates, so a stopped run makes arms incomparable, and status stays `REVIEW_NEEDED` whatever `complete_replicates` is. | Average over replicates complete in every arm; flag `INCOMPLETE`. |
| medium | `acceptance/run.ts:656` | Seven arms × twelve metrics gives 72 uncorrected 95% intervals with no declared primary metric; three or four will exclude zero by chance. | Declare primary metrics in `BENCHMARK`; label the rest exploratory, or apply Holm. |
| medium | `run.ts:117-151` (probed) | The projected and recorded budget stops read in-flight counts at call time, so identical answers with different response timing give different step counts per persona, keeping the fastest responders. | Admit whole cohorts at slice and phase boundaries. |
| low | `acceptance/run.ts:658` | The validity and efficiency labels are constants; a scripted rehearsal says `INCONCLUSIVE` where nothing was measured. No run duration is recorded. | Set `NOT_RUN` in scripted mode; record duration per run. |
| low | `social/graph.ts:80` | `segment_assortativity` is directed modularity; the comment says so, the field name does not. | Rename. |

## 8. Replay, robustness and bookkeeping

| Sev | Where | What happens | Smallest fix |
| --- | --- | --- | --- |
| medium | `types.ts:432`; `report/friction.ts:206-215`; `engine/src/host.ts:464` | `report.themes` stores positional group ids like `g7`. The app rebuilds the report from the log on every view, and grouping rules have changed several times, so an older run's judge titles and author suggestions attach to different groups with no warning. | Record each group's key with its id; drop judge and author output whose key no longer matches, with a limitation. |
| low | `report/spread.ts:71` (verified) | `Math.max(1, ...events.map(...))` spreads every event as an argument; above about 100k events Node throws and no report is produced. | Use `reduce`. |
| low | `report/themes.ts:518` vs `models.ts:94` | The judge-input limitation is re-derived without likes, so it undercounts the groups the judge did not see. | Pass the POI's like groups. |
| low | `themes.ts:520,575,579`; `Report.tsx:870` | Limitations repeat per POI with identical text and duplicate React keys. | Prefix with the POI name. |
| low | `llm/gateway.ts:304`; `report/models.ts:86-125` | `llm.call` carries no `purpose` or `poi_id`, so step and survey cost cannot be told apart or attributed per POI; judge and author calls log as round 1; persona-writer cost is outside "Recorded cost" without saying so. | Add `purpose` and `poi_id`; record the actual round. |
| low | `run.ts:102` | Only the first stop reason is kept, so a provider error after a soft wall-clock stop is invisible. | Append later reasons to `detail`. |
| low | `engine/src/graph/index.ts:65-66,150-154` | The live swarm graph shows `budget_exceeded` and `repeated_failure` as abandoned, and its node sentiment mixes survey and opinion values, unlike the report. | Match the report's definitions. |
| low | `docs/odd.md:11,40-41,78,88,112,160` | Claims that do not hold: replay is timing-independent (not under stops); the wall clock is a hard stop (it is soft); clusters are per segment; the 0.5 threshold never binds (it does for `formed`); formed edges are shown in the report (only the engine graph). | Correct the sentences. |

## Improvements beyond fixes

1. **Trust mix per theme** instead of the maximum, with severity from self-reports only. About 15 lines.
2. **Per-POI outcomes** in the report persona table and segment table. About 40 lines.
3. **A cause on every signal** (`product`, `model`, `engine`, `containment`) so only product signals corroborate; the rest become run-quality notes. About 20 lines.
4. **Verified completion**: on `done`, have the judge check the final snapshot against the goal and compute completion from verified completions. About 30 lines.
5. **Abandonment near the budget** flagged separately from early abandonment, with the remaining budget stored on the event. About 8 lines.
6. **Reach from exposure**: per segment, shown / acted / changed opinion, out of those eligible. About 25 lines.
7. **Golden-log snapshot test** of `buildReport` over one recorded social, multi-POI, competitor log, to catch silent regrouping. About 40 lines plus a fixture.
8. **Rank stability**: recompute the top five with each persona left out; flag themes that move three or more places. About 30 lines.
9. **Exact small-sample inference** in the harness: a sign-flip permutation p-value beside the t interval, and between-replicate SD per arm for sizing repeats. About 20 lines.
10. **Prevalence across replicates**: mean and spread of k/n over seeds for themes mapped across runs, capturing model-sampling variance the within-run Wilson range cannot. About 25 lines.
11. **Methods section** showing rounds run versus configured, `network_policy`, `feed_policy` and `graphMetrics`, so a control run is distinguishable from a baseline. About 10 lines.
12. **Survey re-ask** for a 10% sample, reporting agreement, so readers know how stable survey answers are. About 25 lines.

Not covered: judge and author prompt quality, the comparison study's semantic rules, and anything that needs a live model or browser run. The Gym state confound (section 7) is verified from code only; its size needs a live run.
