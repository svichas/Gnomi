# Gnomi — product document

*Status: founding draft, 2026-10-15. Companion documents: [tech.md](tech.md) (how to build it) and [roadmap.md](roadmap.md) (in what order).*

## 1. Pitch

Gnomi is a social swarm simulator for product teams. Before a launch or a design change ships, Gnomi generates a population of fictional AI personas based on the team's audience assumptions, lets them use the product (a staging web app, a prototype, design frames, or copy) while pursuing a goal the team sets, and lets them talk to each other in a shared social space to explore how generated opinions spread and shift within the simulation. The team watches the swarm live, in a graph of who used what, who talked to whom and who changed whose mind, and receives a report that ranks UX frictions per point of interest, with simulation records (the step, a screenshot, a generated persona quote), a suggested change, and how sentiment moved through the swarm. Gnomi runs on the team's own machine, on the team's own LLM keys, and treats every finding as a hypothesis to validate with real users, not a verdict.

## 2. The problem, and why now

**The problem.** Teams ship changes with far less user feedback than they want. Moderated usability tests cost days per round and are run late, on the few flows a researcher has time for. Unmoderated tools give clicks and task-completion rates but not the *why*. Internal reviews are done by people who already know how the product works, so they miss what a first-time hiring manager on a phone will trip on. And none of these methods captures the social dynamics of a user base: in a real company, one recruiter's complaint about the new job-post form becomes the team's opinion by lunchtime. Early-stage founders and solo designers have no research function at all.

**Why now.**

- LLM agents can now operate real web apps reliably enough to be useful as simulated users. Accessibility-tree browsing with element references and structured actions, which is how Playwright's own browser-agent tooling works, gives an agent a usable, cheap view of a page. See the prior-art summary in [tech.md](tech.md#2-prior-art).
- Academic work from 2023 to 2026 has shown both the promise and the limits of LLM personas: generative-agent societies produce believable social behaviour, interview-grounded personas replicate human survey answers far better than demographic prompts ([Park et al., 2024](https://arxiv.org/abs/2411.10109)), and LLM-driven usability testing finds a meaningful share of real usability issues ([UXAgent, 2025](https://arxiv.org/abs/2502.12561)). The same literature documents the failure modes (sycophancy, homogeneity, over-competence), which means a product can be designed against them rather than discovering them in production.
- The market has split into tools that run personas through a site (for example Swarm) and tools that simulate opinion spread in a population (for example Artificial Societies). Nobody combines the two, and none of them runs locally on the team's own keys.
- Inference is cheap enough. A cheap-tier model can drive a persona through a 40-step task for cents, so a 50-persona run costs about what one hour of a human participant costs, and runs in under an hour.
- Teams already pay for LLM API keys and are wary of sending product data to yet another vendor. A local-first, bring-your-own-keys tool fits how design and product teams buy tools today.

**What Gnomi is not.** It is not a replacement for user research. Synthetic users are systematically more patient, more articulate and more alike than real ones. Gnomi's value is earlier, cheaper, broader coverage of *candidate* frictions, with inspectable simulation records to help decide which ones deserve a real test.

## 3. Target users and jobs-to-be-done

| User | Situation | Job to be done | What success looks like |
|---|---|---|---|
| Product designer | Has a new flow in staging or in Figma, wants feedback before dev or before launch | "Show me where people will get stuck in this flow, by user type, with evidence I can paste into a design review." | A ranked list of frictions per screen, with screenshots and quotes, within an hour, without asking an engineer. |
| Product manager | Owns a launch, needs to decide what to fix before shipping | "Tell me which problems affect the most important segments, how bad they are, and what the first-impression reaction will be." | Segment-weighted findings and a before/after comparison between two runs. |
| Founder / solo builder | No research function, shipping weekly | "Give me something like a usability study on each release for the price of a coffee." | A saved project that reruns on every staging deploy and a report they can share with advisors. |
| UX researcher | Plans and runs real studies | "Help me pick which flows and which segments to test with real people, and give me hypotheses to test." | A hypothesis list with confidence levels, clearly marked synthetic, feeding the study plan. |
| Engineer (secondary) | Maintains staging, integrates Gnomi into releases | "Point Gnomi at staging safely and rerun it reproducibly." | Login sessions, containment and reset hooks set up once; runs comparable across builds. |

Gnomi is designed so that the first three can go from install to report without a terminal, a config file or code. The engineer appears only when staging needs preparation (seed data, a reset hook, an email sink), and those steps are documented as one-time setup.

## 4. Glossary

| Term | Meaning |
|---|---|
| **Project** | A saved workspace: product description, POIs, audience, goals, settings and the runs made with them. Stored as one folder on disk; can be reopened, duplicated and zipped to share. |
| **Point of interest (POI)** | A thing to be judged: a staging website, a clickable prototype, a static design or sequence of frames, a piece of text (pricing page, docs, onboarding email), a developer-facing product, or a competitor's site. Each POI has a type that defines how it is ingested and what personas can do with it. |
| **Audience** | The set of segments that describes who the product is for, with each segment's share of the user base. |
| **Segment** | A type of user with a share of the population, an in-app role (and therefore permissions and a recorded login session), a usage frequency, typical goals, device mix and default patience. Segments drive behaviour; job titles are flavour. |
| **Persona** | One simulated individual within a segment: a profile with varied traits (job title, seniority, company size, tech skill, patience, device, language, accessibility needs, context of use), a personal interpretation of the goal, a writing voice and a random seed. Each persona is one LLM agent. |
| **Goal** | The scenario the personas try to accomplish, written in plain language, with optional overrides per segment. Each persona interprets the goal in its own way. |
| **Run** | One execution of a project's configuration: a fixed set of personas, POIs, goals, model settings and seeds. A run produces an event log, a graph, a feed and a report. Runs are saved and can be duplicated and compared. |
| **Round** | One cycle of the run loop: every active persona takes a slice of actions on the POIs (an *episode* of up to N steps), then takes part in one *social round* where it reads the shared feed and posts, replies or reacts. A run has a configurable number of rounds. |
| **Episode** | A persona's continuous session on one POI, from the start page until it declares the goal done, gives up, or hits its step budget. |
| **Swarm feed** | The shared social space of a run: posts, replies and reactions by personas, visible to each persona through its follow graph. |
| **Friction** | A moment where a persona struggled: a self-reported problem, an objectively observed signal (failed action, loop, backtracking, timeout, error), or both. Frictions are clustered into *friction themes* for the report. |
| **Evidence** | The report's existing name for simulation records: step, screenshot, page or frame, generated quote and observed signals. These document the run; they are not evidence about real users. |
| **Report** | The end-of-run document: per POI, sentiment by segment, ranked friction themes with evidence and suggested changes, and how opinions spread through the swarm. Exportable. |
| **Trust level** | Corroboration within a simulation: *confirmed* (generated self-report and observed signal), *observed* (signal only), *reported* (generated self-report only). None means validated by real users. |

## 5. The end-to-end journey

### 5.1 Setup

1. **Create a project.** The user names it and writes one sentence about the product ("An applicant tracking system for mid-sized companies").
2. **Add points of interest.** Drag in files, paste URLs or design-tool links. Each POI shows a preview card. For a website, Gnomi opens it in a separate browser window it controls; the user logs in by hand for each role (the *login recorder*), marks the start page, and Gnomi saves the session for that role. The user never types a password into Gnomi itself and Gnomi never sees it.
3. **Confirm the audience.** From the product sentence and the POIs, Gnomi proposes segments as editable cards with share sliders that always sum to 100%. Opening a segment shows its generated personas; each can be edited, regenerated, removed, or new ones added. Real numbers can be typed over the proposals.
4. **Write the goal.** One plain-language scenario, with optional per-segment overrides. Gnomi shows how each segment will read it.
5. **Keys and models.** In settings, add provider keys, test each one, pick a model per role (navigator, socialiser, judge, author, and the persona writer used at setup) or accept the defaults, and set a budget.
6. **Pre-run summary.** Gnomi shows the persona count, POIs, estimated cost and time, the containment settings (allowed hosts, blocked services), and one Start button.

Persona creation combines seeded trait sampling with model-written candidates and a selected biography, followed by team review. It creates fictional profiles rather than recruiting people. See [Persona generation](persona-generation.md#how-simulated-users-are-made).

### 5.2 Run

Gnomi seeds the swarm (assigning sessions, seeds and goals), then runs rounds. In each round, personas use the POIs concurrently, then join the social round. The live cost meter and progress bar update continuously. The run stops when all personas are done or have given up, when the round budget is reached, when the cost budget is hit, or when the user stops it.

### 5.3 Watch

While the run is live, the user can:

- watch the **swarm graph** grow: personas light up as they act, edges appear as they use POIs, talk and influence each other, and friction hotspots glow on POI nodes;
- open the **persona inspector** for any persona to see its profile, goal, step history, current opinion of each POI, and screenshots;
- follow the **activity panel**, a filterable feed of what every persona is doing right now;
- read the **swarm feed** as personas post and reply;
- stop the run at any moment and still get a report from what has happened so far.

### 5.4 Report

At the end, Gnomi clusters frictions into themes, ranks them by segment-weighted impact, severity and trust, attaches evidence, drafts a suggested change for each, and summarises how opinions spread. The report opens in the app and exports as a self-contained HTML file, PDF, Markdown or JSON.

The rankings are hypotheses. Counts and sentiment describe the simulated population, and generated quotes are not participant testimony. Screenshots and logs can establish what the agents did, but not what real users need. See [Interpreting simulations](interpreting-simulations.md) for trust-label limits and the validation workflow.

### 5.5 Iterate

The team fixes what it chooses, deploys to staging, duplicates the run (same personas, same seeds, same goals) and compares the two reports side by side: which frictions disappeared, which are new, and how sentiment moved per segment.

## 6. Features by area

### 6.1 Setup

- **Project home**: any number of projects, each stored as its own folder; a list with last run status; create, open, rename, duplicate, export and delete. One project is open per window, and a second window opens another project side by side.
- **POI library**: drag-and-drop and paste; type auto-detected; preview per POI; per-POI settings (start page, device, allowed hosts, mode: full / observe-only).
- **Login recorder** for web POIs: an embedded browser where the user logs in once per role, completes SSO or MFA by hand, and marks the start page. Sessions are saved per role and labelled with expiry. A "re-record" button handles expired sessions.
- **Audience builder**: segment cards with share sliders that renormalise to 100%; per-segment role, usage frequency, device mix, country mix, patience, account state (empty or populated), typical goals, and an optional employer list ("Coca-Cola, Pepsi, a staffing agency") that the segment's personas are spread across; persona list per segment with edit, regenerate, add, remove; import of real shares from a CSV; a profile-attributes editor to switch default attributes off, add custom ones with a type and per-segment sampling rule, and save the set as a template.
- **Goal editor**: scenario text, per-segment overrides, a preview of each segment's interpretation.
- **Settings**: provider keys (add, test, remove), model routing per role with cost estimates, budget, concurrency, data folder location.
- **Pre-run summary**: everything that will happen, estimated cost and time, containment summary, Start.

### 6.2 Swarm graph

- Nodes: personas (coloured by segment, sized by activity), POIs (shape differs; a glow proportional to friction count), and optionally pages within a web POI.
- Edges: *used* (persona → POI), *talked to* (persona ↔ persona, from replies and reactions), *influenced* (persona → persona, when a persona's opinion changed after reading a post it cited), *friction* (persona → POI, weighted by severity).
- Interaction: zoom, pan, drag, click to inspect, hover for a tooltip, filter by segment, by edge type, by round, by POI; a time scrubber that replays the graph round by round.
- Layout: force-directed with segment clustering; POIs pinned in a ring so the picture is stable between runs.

### 6.3 Persona inspector

- The complete profile and biography (identity with country and languages, work, capability, context, psychology, intent, voice), segment, device, seed, all editable; "regenerate from these traits" rewrites the biography without changing the sampled fields.
- Timeline of actions with the page or frame, the persona's think-aloud note, and the screenshot at each step; failed steps and loops are highlighted.
- Opinion panel: per POI, a sentiment score from −2 to +2, confidence, top likes and top frictions, and how the opinion changed over rounds, with the posts that changed it.
- Social panel: who it follows, what it posted, what it read.
- "Rerun this persona" to replay a single persona with a different seed or model.

### 6.4 Activity panel

- A live, virtualised feed of events: navigating, clicking, typing, reading, thinking aloud, posting, replying, reacting, reporting friction, giving up, finishing.
- Every step shows two lines, what the persona did and what it thought, in the persona's own words:
  > Stefanos (recruiter, Pepsi) clicked "See pricing"
  > Stefanos thought "pricing is expensive for what we'd use, I'd need to ask Finance"
  > Stefanos felt −1
- Thoughts can be filtered on their own, so a team can read the swarm's running commentary without the clicks.
- Filters by persona, segment, POI, event type, round, and a search box.
- Clicking an event opens the inspector at that step.
- A cost ticker and a progress summary (personas active / done / abandoned) at the top.

### 6.5 Report

- **Summary**: top five frictions across all POIs, overall sentiment by segment, cost and duration, and a banner stating that findings are synthetic hypotheses.
- **Per POI**:
  - sentiment by segment (score, distribution, and change between rounds);
  - ranked friction themes, each with: title, trust level, severity, share of affected personas per segment and segment-weighted impact, evidence (step, screenshot, persona quotes), a suggested change, and a possible solution;
  - opinion spread: which posts seeded a view, how many personas repeated it, which segments it crossed, and a round-by-round sentiment line;
  - what went well (so teams do not remove things that work).
- **Methods appendix**: personas, models, seeds, budgets, containment settings, blocked requests, limitations observed (sessions expired, CAPTCHAs met, budget reached).
- **Compare view** between two runs of the same project: frictions fixed, new, unchanged; sentiment deltas by segment.
- **Export**: self-contained HTML, PDF, Markdown, JSON.

## 7. Points of interest

### 7.1 POI types

| Type | What the user provides | What personas can do | Who engages | Version |
|---|---|---|---|---|
| **Website / web app** | A staging URL, a start page, one recorded login session per role, allowed hosts, device (desktop/mobile) | Navigate, click, type, scroll, read, submit forms, report friction, give up | All segments with a role; candidates on public pages | v1 |
| **Text** | Pasted or uploaded text or Markdown: product concept, pricing, landing copy, docs, onboarding email | Read, rate clarity and appeal, say what they would do next, report confusion | All segments; buyer segment in particular | v1 |
| **Static design** | One image, or an ordered sequence of images standing for a flow (PNG/JPG/PDF pages) | Look at a frame, say what they understand and what they would click, then see the next frame and judge whether it matched their expectation | All segments | v1 |
| **Competitor site** | A public URL, observe-only | Browse and read, no form submission; compare with the team's POI in the survey | All segments | v1 (as a web POI in observe-only mode) |
| **Design-tool frames** | A Figma file or frame link (a personal access token from a Dev or Full seat, added in settings) | Frames are exported as images and become a static-design sequence | All segments | v1.1 |
| **Figma prototype (simulated)** | A Figma file or prototype link | Gnomi rebuilds the prototype from the file's own interaction data (starting points, hotspots, destinations) and renders the frames itself; personas click hotspots and move between frames, and a click where nothing is tappable is a friction. Figma's prototype viewer is never automated | All segments | v1.2 |
| **Developer product** | An OpenAPI spec, README, SDK docs, CLI help text, optionally a sandbox base URL | Read docs, plan an integration, make sample calls against the sandbox, judge developer experience | Technical personas only | v1.2 |
| **Source code** | Not a POI. Users never see code. The team runs the app locally or in staging and points Gnomi at it. A later version may offer "launch recipes" (a Docker Compose file) to start the app from the UI. | — | — | deferred |
| **Native mobile app** | An app binary in a simulator | Tap, type, swipe | All segments | later |

### 7.2 Upload flows

- **Website**: paste a URL. Gnomi loads it in the login recorder. The user logs in for each role defined by the audience (the audience step can be done first; Gnomi then asks for a session per role) and marks the start page. Gnomi checks the host against production tripwires (see tech.md, hard problem 3) and shows the allowed-hosts list for confirmation. A preview screenshot is stored.
- **Text**: paste or drop a `.md`, `.txt`, `.pdf` or `.docx`. The preview is the rendered text. The user picks which segments engage with it.
- **Static design**: drop one or more images or a PDF. For multiple images, the user orders them and optionally names each step ("Pricing page", "Checkout step 1"). The preview is a filmstrip.
- **Competitor site**: paste a URL and tick "observe-only". No sessions.
- **Figma frames**: paste a frame or file link; Gnomi lists the frames found, the user ticks and orders them; they become a static-design POI. Figma's API allows only 20 calls a month on View and Collab seats, so the token must come from a Dev or Full seat; the settings screen says so.
- **Figma prototype (simulated)**: paste the file or prototype link; Gnomi shows the flow it found (starting frame, hotspots, destinations) as a map the user can check before running.
- **Developer product**: drop an OpenAPI/README/docs file or paste a docs URL; optionally add a sandbox base URL and an API key placeholder (held in settings, never in the prompt).

## 8. Audience: segments and personas

### 8.1 Segment model

A segment has:

- `name`, `share` (percent of the population; the sliders always sum to 100%),
- `role`: the in-app role, which maps to a recorded login session and to permissions,
- `usage_frequency`: daily / weekly / monthly / rarely / never (external),
- `typical_goals`: what this type of user usually tries to do,
- `device_mix`: share of desktop vs mobile,
- `country_mix`: countries with shares (for example 60% United States, 25% United Kingdom, 15% Germany); personas get a city, timezone and languages from it,
- `patience`: a default range from which persona patience is sampled,
- `tech_skill`: a default range,
- `account_state`: empty (first use) or populated (an account with history),
- `entry`: how they usually arrive (direct, email link, shared link),
- `employers` (optional): named companies or kinds of company that the segment's personas work for, such as "Coca-Cola, Pepsi, a staffing agency". Personas are spread across the list. Left empty, Gnomi invents plausible employers from the industry and company-size ranges,
- `goal_override` (optional).

Segments come from one line about the product plus the POIs. Gnomi proposes them; the user edits shares or imports real numbers. The report weights every finding by segment share and shows friction per segment.

### 8.2 Persona model

A persona is a complete person, not a job title. The profile has eight groups, all visible and editable in the inspector:

- **identity**: `name`, `age_range`, `pronouns`, `country`, `city`, `timezone`, `languages` (each with proficiency; the first is the language the persona thinks and posts in), `education`,
- **work**: `job_title`, `employer` (a real or invented company name), `employment_type` (in-house, agency or contractor, freelance), `seniority`, `years_in_role`, `team_size`, `company_size`, `industry`, `decision_role` (user, influencer, approver, budget holder), `tools_today` (the software they already use for this job),
- **capability**: `tech_skill` (1–5), `patience` (1–5), `reading_speed`, `familiarity_with_category` (has used an ATS before or not), `prior_tools` in the category with one line each on what they liked and hated,
- **context**: `device`, `accessibility_needs` (none, low vision, colour-blind, screen reader, motor), `context_of_use` ("between meetings on a phone", "end of day, 20 tabs open"), `working_pattern` (office, hybrid, remote, shifts), `connectivity` (fast, flaky, mobile data),
- **psychology**: `motivation` (1–5), `risk_appetite`, `openness_to_new_tools`, `trust_in_vendors`, `price_sensitivity`, `posting_propensity`, each 1–5,
- **intent**: `goal_interpretation` (its own reading of the goal) and `what_good_looks_like` (what would make this person say the product worked),
- **voice**: how the persona writes and in which language, its formality and typical length, two or three phrases it would actually use,
- **biography**: 150–250 words in the first person, written from every field above, interview-style: how they got the job, what a normal week looks like, what annoys them about their current tools, what they would never tolerate. This is the text that makes the model think like the person; the structured fields keep it honest.

Plus a `seed` that fixes the trait sampling and the model sampling, so the persona can be regenerated identically.

**The attribute set is customisable.** The eight groups above are the default schema, not a fixed one. A project can remove attributes it does not care about and add its own, with fewer or more fields than the default:

- A small **core** stays in every schema because the engine depends on it: name, country with timezone and languages, device, tech skill, patience, goal interpretation, voice, biography and seed. Core attributes can be hidden from the cards but not removed.
- Every other default attribute (employer, prior tools, psychology dials, working pattern and so on) can be switched off; it then disappears from the cards, the prompt and the report.
- A **custom attribute** has a name, a type (text, number range, choice list, yes/no, list of text), a one-line description the model reads, a sampling rule per segment (fixed value, a share per choice, or a range) and two flags: *use in prompt* and *report dimension*. Examples: `hiring_volume_per_quarter: number 1–50`, `uses_linkedin_recruiter: yes/no`, `region: choice [EMEA, Americas, APAC]`, `must_have_integrations: list`.
- Custom attributes feed the biography writer, so a persona with `hiring_volume_per_quarter: 40` has a biography about volume, and attributes flagged as a report dimension become filters in the inspector, the activity panel and the report ("friction by region").
- The schema is saved with the project and can be saved as a **template** ("B2B SaaS buyer", "consumer app", "developer tool") for reuse in other projects; Gnomi ships the default template.

**Country matters in three places.** The persona expects its own date formats, currency, units, spelling and consent norms, and judges the product against them. Its browser runs with that country's locale, timezone and language, so the product under test behaves for the persona as it would for a real user there (a German hiring manager sees `15.10.2026`, euro prices and the cookie banner Germany requires). And its posts in the swarm are written in its first language unless the segment says otherwise, so a multilingual audience produces a multilingual feed. Countries come from a per-segment country mix the user sets (for example 60% United States, 25% United Kingdom, 15% Germany).

**How a persona thinks.** On every step the model is given the full profile and biography and asked what this person does, thinks and feels next. The prompt makes the profile load-bearing: the country sets what looks normal, the prior tools set what the product is compared against ("in Greenhouse this took one click"), the decision role sets what matters (a CFO thinks in cost per hire, a recruiter in minutes per candidate), the psychology dials set how it reacts to risk, price and novelty, and the voice sets how the thought reads. Thoughts are in the first person and in the persona's language, and the inspector shows the profile next to the timeline so a reader can check that the thinking fits the person.

Personas are sampled from the segment's ranges with a seeded random generator first, and only then written up by a model, so that the population's diversity comes from sampling rather than from asking a model to "be diverse".

Example record:

```yaml
id: p-017
segment: hiring-managers
identity:
  name: Dana Okafor
  age_range: 35-44
  pronouns: she/her
  country: DE
  city: Berlin
  timezone: Europe/Berlin
  languages: [{code: de, level: native}, {code: en, level: fluent}]
  education: MSc Computer Science
work:
  job_title: Engineering Manager
  employer: Northline Payments
  employment_type: in-house
  seniority: senior
  years_in_role: 3
  team_size: 14
  company_size: 180
  industry: fintech
  decision_role: approver          # approves hires, does not choose the ATS
  tools_today: [Jira, Slack, Google Calendar, Notion]
capability:
  tech_skill: 5
  patience: 2
  reading_speed: fast
  familiarity_with_category: low   # has used two ATSs, never configured one
  prior_tools:
    - {name: Greenhouse, liked: "scorecards were one tap", hated: "email notifications for everything"}
    - {name: Personio, liked: "nothing in particular", hated: "could never find the candidate again"}
context:
  device: mobile
  accessibility_needs: none
  context_of_use: "Opening an email link between two meetings, 4 minutes to spare"
  working_pattern: hybrid
  connectivity: mobile data
psychology:
  motivation: 2
  risk_appetite: 3
  openness_to_new_tools: 2
  trust_in_vendors: 2
  price_sensitivity: 3
  posting_propensity: 2
intent:
  goal_interpretation: "Look at the two candidates the recruiter sent, leave quick feedback, get out."
  what_good_looks_like: "Two taps per candidate and I never see this app again until the next one."
voice:
  language: de                     # thinks and posts in German; reads English UIs fine
  style: "Terse. Impatient with HR tooling. Asks why things take more than two taps."
  phrases: ["Warum ist das drei Klicks?", "Kann das nicht einfach im Mail sein?"]
biography: >
  I run two backend teams at a payments company in Berlin. Hiring is maybe five percent of my
  week and I want it to stay that way: the recruiter does the work, I say yes or no. I open
  these tools from my phone, usually from an email, usually late. Greenhouse was fine because
  the scorecard was one tap; Personio lost me every time I tried to find a candidate again.
  I notice when prices are in dollars and dates are the wrong way round. If something takes
  more than a couple of taps I close it and tell the recruiter to just message me.
seed: 884213
```

### 8.3 Worked example: an applicant tracking system

Product sentence: "An applicant tracking system for companies with 50–2,000 employees." POIs: the staging app (web), the careers page (web, public), the pricing page (text), a new job-post creation flow (Figma frames). Goal: "Create your first job post and get a hiring manager to review the first applicants; then decide whether you'd pay for this."

Gnomi proposes this audience (shares are illustrative, the user edits them):

| Segment | Share | Role | Frequency | Device | Patience | Typical goals | Goal override |
|---|---|---|---|---|---|---|---|
| Recruiters and HR | 55% | `recruiter` | daily | 90% desktop | medium | post jobs, screen candidates, schedule interviews, chase hiring managers | — |
| Hiring managers | 25% | `hiring_manager` | weekly or less | 60% mobile, from an email link | low | review candidates in their own jobs, leave feedback, approve offers | "You got an email: two candidates are waiting for your review. Review them and leave feedback." |
| HR admins | 10% | `admin` | weekly | desktop | high | configure pipelines, manage users, set up integrations | "Set up the approval workflow a recruiter needs for the new job post." |
| Execs and approvers | 5% | `approver` | monthly | 50% mobile | very low | approve a requisition or an offer | "Approve or reject the requisition you were sent." |
| Candidates (external audience) | separate population | none | once | 70% mobile | low to medium | find a job, apply quickly, know what happens next | "Find the software engineer role and apply." |
| Buyers (optional, perception-only) | separate population | none | never | desktop | — | judge whether the product is worth the price and fits the company | "Read the pricing page and decide whether you'd book a demo." |

Notes on the example:

- A developer persona in this product is a **hiring manager**. Job title is flavour; the `hiring_manager` role, the weekly-or-less frequency, the mobile entry from an email link and the low patience drive its behaviour. It is technically skilled but unfamiliar with HR tools and unwilling to learn them.
- Candidates are a separate audience with its own 100%: they never log in and only use the public careers page POI. Their report section is separate because their frictions are a different product problem.
- Buyers only engage with the text POIs (pricing, positioning). They cover perception, not usage.
- Within recruiters, sampled personas vary: a junior coordinator at a 60-person startup on an empty account; a senior talent partner at a 1,500-person company with 40 open jobs; a recruiter whose first language is not English; one with low vision who uses browser zoom at 150%.
- Countries follow the segment's country mix. With 60% United States, 25% United Kingdom and 15% Germany for recruiters, the German recruiters see the staging app with a German locale and Berlin time, expect euro prices and `DD.MM.YYYY` dates, post in German in the swarm feed, and report "the salary field only accepts dollars" as a friction the American recruiters never meet. The report shows friction per country within a segment when the mix has more than one.
- Employers are the user's call. Typing "Coca-Cola, Pepsi, a staffing agency" into the recruiters segment spreads its personas across an in-house recruiter at Coca-Cola, one at Pepsi and an agency recruiter who works for several clients, and their goal interpretations differ accordingly (the agency recruiter juggles many clients and cares about bulk actions and client-facing views). The inspector, the activity panel and the report can be filtered by employer. The personas remain fictional people; a real company name is context, not a claim about that company's staff.
- Recorded sessions: the engineer records one session each for `recruiter`, `hiring_manager`, `admin` and `approver` on staging; candidates and buyers need none.

Personas per run: 50 by default, configurable from 1 to 200. Counts follow segment shares, preferring at least 3 per active segment when the requested total allows it; smaller runs lower that minimum so even one persona is possible. The report still weights segments by their configured shares. Personas added by hand remain extra.

## 9. Example report excerpt

The following is an illustrative synthetic report, not a human study. All counts and quotes refer to fictional personas; “confirmed” means corroborated within the simulation.

> ### POI: Staging app — "Create job post" flow
>
> **Sentiment by segment (−2 to +2):** recruiters +0.6 (n=27), hiring managers −0.8 (n=13), admins +0.9 (n=5). Recruiters' sentiment fell from +1.1 in round 1 to +0.6 by round 5, after the "hiring manager invite" thread spread (see opinion spread below).
>
> **Friction 1 — Assigning a hiring manager who is not yet a user drops the recruiter out of the job-post form.**
> Trust: **confirmed** (self-reported by 14 personas; observed loop and backtracking in 11). Severity: high. Affected: 52% of recruiters, 20% of admins. Segment-weighted impact: 31% of the population.
> *Evidence:* step 14 of persona p-004 (Priya Natarajan, recruiter, desktop): clicked "Assign hiring manager", typed a name, got "No user found", clicked "Invite user", landed on Settings › Users, invited, used the browser back button three times, found the draft job post empty. Screenshot: `runs/r-12/shots/p-004-014.png`.
> *Quote:* "I lost the whole draft. I'm not writing that description twice. I'd email the manager instead and come back tomorrow, if at all."
> *Suggested change:* allow inviting a hiring manager inline from the assignment field, and keep the draft. *Possible solution:* a combobox with a "Invite dana@…" row that sends the invite and assigns a pending user; autosave the draft on every field change.
>
> **Friction 2 — The mobile review screen hides the "Leave feedback" action below the résumé viewer.**
> Trust: **observed** (9 hiring managers scrolled up and down 4+ times; 3 gave up before finding it; 2 reported it). Severity: high for hiring managers (62% affected), not seen on desktop. Segment-weighted impact: 15%.
> *Quote (p-017, Dana Okafor):* "Where do I say yes or no? I'm not reading a PDF on my phone to find a button."
> *Suggested change:* pin the decision actions to the bottom of the screen on mobile.
>
> **Opinion spread.** Persona p-004's post ("Lost my draft assigning a manager, anyone else?") received 6 replies within the round and was repeated by 9 recruiters in later rounds; 3 admins who had not met the issue themselves lowered their rating of the flow after reading it (influence edges p-004 → p-031, p-033, p-035). The hiring-manager complaint stayed within its segment: recruiters do not use the mobile review screen and did not react to it.
>
> **What went well.** 24 of 27 recruiters completed the flow; the job-description templates were praised by 11 ("saved me ten minutes").
>
> *These findings are produced by simulated users. Treat them as hypotheses and validate the top items with real users before committing to changes.*

## 10. Non-goals

- **Replacing user research.** Gnomi produces hypotheses with simulation records, not evidence about real users or validated findings, and says so in every report.
- **Quantitative prediction.** Gnomi does not predict conversion rates, NPS or market size. Sentiment scores are relative within a run and between runs of the same project.
- **Testing production.** Gnomi refuses to run against hosts the user has not marked as staging and contains outbound traffic. It is not a monitoring or load-testing tool.
- **Defeating bot protection.** Gnomi never attempts CAPTCHAs, MFA or any bot-detection bypass. The human does these in the login recorder.
- **Functional QA.** Gnomi reports broken things it meets, but it is not a regression test suite and does not assert expected outputs.
- **A hosted service.** v1 is local only. Team sharing is done by exporting reports and zipping projects.
- **Native mobile apps** in v1.
- **Reading source code.** Gnomi judges what users see.

## 11. Risks and ethics

- **Over-trusting synthetic users.** The biggest product risk. Mitigations: trust levels on every friction; the hypothesis banner on every report; a "validate with real users" checklist generated from the top findings; publishing Gnomi's own measured detection rates (see the evaluation plan in [roadmap.md](roadmap.md#evaluation-plan)); never showing a single "score" for the product.
- **Bias in personas.** A model asked for "a recruiter" tends to produce a narrow, stereotyped, English-speaking, able-bodied persona. Mitigations: traits are sampled by Gnomi from explicit distributions the user can see and edit (including country, language and accessibility needs), not left to the model; the biography is written from the sampled traits and the prompt forbids national or cultural caricature; names and backgrounds are generated from the sampled traits; the audience screen shows the population's distribution; the report shows findings per segment so minority segments are not averaged away; a diversity check warns when generated personas are too similar.
- **Homogeneity and herd effects.** Social rounds can make the swarm converge on one opinion faster than real communities do. Mitigations: the follow graph is sparse and segment-clustered; influence is logged and shown, so the team can tell a widely *held* view from a widely *repeated* one; the report distinguishes first-hand frictions from second-hand ones.
- **Real company names.** Users may give personas real employers for realism. The report must present these as fictional people in a named context, never as the views of that company's employees, and the export carries that note.
- **Caricature.** Telling a model to "be impatient" produces a cartoon of impatience, which is as misleading as politeness. Gnomi derives behaviour from sampled traits and enforces patience in the engine rather than piling on instructions, and the methods appendix shows abandonment and sentiment distributions so a team can see when a population looks implausible.
- **Misuse against third-party sites.** Competitor POIs are observe-only, rate-limited, respect `robots.txt`, and never submit forms. Gnomi should not be usable as a scraping or spam tool, and the containment layer blocks everything but the hosts the user allowed.
- **Privacy of product data and keys.** Everything stays on the machine except what is sent to the chosen LLM provider; keys live in the OS keychain; no telemetry by default. Screenshots may contain staging data; the user owns the project folder.
- **Prompt injection from the product under test.** Page content is untrusted input to the agent. Personas can only act within the browser on allowed hosts and have no file, shell or network tools. See the security model in [tech.md](tech.md#13-security-model).
- **Staging damage.** Personas will click delete and send. Gnomi contains outbound side effects, but staging data can still be changed; the reset hook and the "never production" guard are the safety net, and the pre-run summary says so.
- **Labour and representation.** Gnomi simulates people, including people with disabilities and non-native speakers. It must present these as approximations that make accessibility and language problems *visible earlier*, not as a substitute for testing with those users.

## 12. Assumptions

Labelled assumptions the design relies on; each is revisited in the roadmap's evaluation plan.

- **A1.** Accessibility-tree browsing plus occasional screenshots is enough for personas to find most navigational and form frictions; purely visual-design frictions need the screenshot path and a vision-capable model.
- **A2.** 20–200 personas per run is the useful range. Below 20 the segment shares are meaningless; above 200 the cost grows without new frictions appearing (the friction discovery curve flattens). Default 50.
- **A3.** Teams have, or can create, a staging environment with test accounts per role and are willing to record one login session per role.
- **A4.** A cheap-tier model can drive navigation acceptably when the page is presented as a pruned accessibility tree with element references; a stronger model is needed for judgement, clustering and report writing.
- **A5.** Users will accept per-run costs in the range of a few dollars to a few tens of dollars on their own keys, shown before the run starts.
- **A6.** Sampled-trait personas plus explicit patience and step budgets reduce, but do not remove, the "too patient, too capable" bias. The report must still present findings as hypotheses.
- **A7.** Social spread is informative mostly in relative terms (which complaint travels, which stays local), not in absolute numbers.
- **A8.** The product is used for the team's own products and for observe-only looks at public competitor pages; no other third-party use.

## 13. Open questions

1. **How far to go with per-persona accounts.** One recorded session per role is simple but means personas in the same role share an account and can see each other's data. Should v1 support one session per persona for small segments, or rely on namespacing created objects?
2. **Email verification flows.** Integrating an email sink (Mailpit) covers teams that control staging email. What should Gnomi do for teams that cannot change SMTP settings: skip sign-up flows, or offer a hosted-free "pretend inbox" that only works when the app's email is routed to it?
3. **Figma prototypes.** Driving Figma's prototype viewer is ruled out (its terms do not permit programmatic access and the viewer exposes no accessibility tree), so Gnomi rebuilds prototypes from the file's interaction data instead. That covers navigation hotspots but not component states or animations. Is that enough for the designers who live in Figma, and does the Developer Terms clause about bidirectional data flow (which needs a legal read) affect a read-only importer?
4. **Calibration data.** Gnomi's detection rates will be measured on its own seeded-defect demo app. Can we obtain a real usability study with findings for a public app to calibrate against humans?
5. **Sentiment scale.** A −2 to +2 scale is easy to read; is a per-POI "would recommend / would pay" question more useful for buyers?
6. **How much to show of the model's reasoning.** Think-aloud notes make the inspector useful but can read as more confident than they are. Should they be shown verbatim, summarised, or hidden by default?
7. **Headless mode for CI.** Engineers will want "run on every staging deploy". It is deferred, but the engine is designed as a library so a command-line entry point can be added without changing the app.
8. **Team sharing.** Zipping the project folder is the v1 answer. Is a read-only report link (hosted) wanted enough to justify a service component later?
