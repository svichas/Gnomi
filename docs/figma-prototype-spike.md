# Spike: a simulated Figma prototype

M5 spike from [roadmap.md](roadmap.md#m5--more-points-of-interest). Question: should Gnomi rebuild a Figma prototype from the file's own data (starting points, hotspots, destinations), render the frames itself, and let personas click through it, and does that ship in M7?

Context: [tech.md §7](tech.md#7-poi-ingestion-and-interaction) ("Figma frames" and "Figma prototype, simulated" rows) and [§4.16](tech.md#416-design-tool-ingestion). Gnomi never automates Figma's own prototype viewer: its terms and its lack of an accessibility tree rule that out, and nothing here changes that.

Written 2026-10-16. The parser (removed; see `git show d3696fa:engine/src/figma/spike/flow.ts`) was written against the documented schema and a hand-built fixture. **It has never seen a real Figma file**: no token was used and no network call was made beyond reading documentation.

## 1. Recommendation

**Ship a reduced version in M7, behind two gates. If either gate fails, defer to after 1.0.**

*Reduced* means a navigation-only click-through: the flow map, Gnomi-rendered frames, hotspots that navigate, open or close overlays, go back, scroll to an anchor or fire after a delay, and dead clicks as the friction. It does not mean component states, variables, conditions, typing or animation, which are not rebuilt (§3).

Why ship it:

- It tests something a static-design sequence cannot. In the M5 sequence the persona is *shown* the next frame; here the persona must *find* the way to it, which is the "where will people get stuck in this flow" the product designer asks for in [idea.md](idea.md).
- The data is documented and cheap to get: the same three Tier 1 calls as frame import (§2.4), so a Figma frames import in M5 already has most of what the simulation needs.
- A run needs no browser. The simulation is a small state machine over images, so cost per persona-step is that of a static-design step (§6) and there is no containment layer to build.

Why not unconditionally, and not now:

- Two things can kill it, and neither can be settled without someone other than this spike: a **legal read** (§7; the Developer Terms and Acceptable Use Policy now published are newer than the versions tech.md cites) and a **check on real designer files** with a Dev or Full seat token (what do real prototypes contain, and do the assumptions in §3 hold?).
- Frame import covers most of the value, as the roadmap already says. The simulation adds discoverability testing, not a new kind of POI.
- M7 is three weeks and already carries installers, signing, the developer-product POI and the evaluation. This adds roughly **8–10 working days** for one engineer (my estimate: import wiring 1, screen renderer and state machine 3, persona loop and friction types 2, flow map UI 2, Gym fixture and acceptance 2). If M7 cannot absorb that, move it to a 1.x release rather than cutting the gates.

### Gates, to pass before M7 work starts

| Gate | Pass when | Cost |
|---|---|---|
| **G1 Legal read** | Counsel confirms (a) a read-only REST importer is not caught by the Developer Terms' two-way data-flow clause, (b) rebuilding prototype *playback* from file data is not "copying" Figma's function under the Acceptable Use Policy, and (c) whether a commercial app may ask users for personal access tokens or must register an OAuth app. Questions in §7. | A legal review; no engineering |
| **G2 Real files** | On 5 real prototypes from designers (a Dev or Full seat token), at least 4 import with 80% or more of reachable hotspots carrying only supported actions; overlay position and dismissal, interactions on instances, and scroll rendering behave as §3 assumes; exported PNGs line up with the hotspot boxes when drawn over them. The 80% is my proposed threshold, not a measured one. | 1–2 days, using the §4 parser and a throwaway script |
| **G3 Click accuracy** | Told in words which element to click, vision models land inside the intended hotspot at least 90% of the time on Gym frames. Below that, "dead click" is mostly model noise rather than friction. Also my proposed threshold. | About a day |

### One change worth making in M5 regardless

Have the Figma frames import request the chosen page's nodes at full depth and keep the raw response in `assets/` with the file's `version` and `lastModified`, pinning `version` on the image export too. The interaction data comes in the same call, so the simulation can be built later without spending rate limit again, and frames and hotspots are guaranteed to come from the same file version. This session did not change any M5 code; it is a note for whoever owns the importer.

## 2. What Figma's documentation says

Everything here was read on **2026-10-16** from Figma's documentation. The pages were fetched and summarised by a small model, not read verbatim in a browser, so quoted values (especially the legal sections) must be re-read in the primary text before anyone relies on them. Section numbers below are as the summaries reported them.

### 2.1 Sources

| Page | URL |
|---|---|
| REST API introduction | <https://developers.figma.com/docs/rest-api/> |
| File endpoints (files, nodes, images) | <https://developers.figma.com/docs/rest-api/file-endpoints/> |
| Node types (CANVAS, FRAME, INSTANCE...) | <https://developers.figma.com/docs/rest-api/file-node-types/> |
| Property types (Trigger, Action, Transition, FlowStartingPoint) | <https://developers.figma.com/docs/rest-api/file-property-types/> |
| OpenAPI spec (schemas for layout and frame traits) | <https://github.com/figma/rest-api-spec> (`openapi/openapi.yaml`, about 400 KB, read in 100 KB chunks and searched by field name, so a field I report as absent may only have been missed) |
| Authentication, personal access tokens, scopes | <https://developers.figma.com/docs/rest-api/authentication/>, <https://developers.figma.com/docs/rest-api/personal-access-tokens/>, <https://developers.figma.com/docs/rest-api/scopes/> |
| Rate limits (effective 2025-11-17) | <https://developers.figma.com/docs/rest-api/rate-limits/> |
| Changelog | <https://developers.figma.com/docs/rest-api/changelog/> |
| Developer Terms (effective 2026-05-05) | <https://www.figma.com/legal/developer-terms/> |
| Acceptable Use Policy (last updated 2026-10-07) | <https://www.figma.com/legal/aup/> |
| Prototype actions and triggers (Help Center) | <https://help.figma.com/hc/en-us/articles/360040035874>, <https://help.figma.com/hc/en-us/articles/360040035834> |

### 2.2 Endpoints

| Endpoint | Scope | Tier | Use for the simulation |
|---|---|---|---|
| `GET /v1/files/:key` | `file_content:read` | 1 | Page and frame listing with `depth`; whole file otherwise. Parameters: `version`, `ids`, `depth`, `geometry`, `plugin_data`, `branch_data`. `depth=1` returns pages only. |
| `GET /v1/files/:key/nodes` | `file_content:read` | 1 | Only the nodes asked for (`ids` required), same `version`, `depth`, `geometry`. The `nodes` map can hold nulls for ids that do not exist. |
| `GET /v1/images/:key` | `file_content:read` | 1 | Renders. `ids` (required), `scale` 0.01–4, `format` jpg, png, svg or pdf, `contents_only` (default true), `use_absolute_bounds` (default false), `version`. Up to 32 megapixels, larger is scaled down. A null in `images` means that node failed to render. **Render URLs expire after 30 days**, so frames must be downloaded at once. |
| `GET /v1/files/:key/images` | `file_content:read` | 2 | Image *fills* (bitmaps inside the design), not renders. Not needed. |
| `GET /v1/files/:key/meta` | `file_metadata:read` | 3 | Metadata only. Not needed. |

Errors named on those pages: 403 (invalid or expired token) and 404 on files; 400 on nodes and images; 500 on images ("render could not be completed"); 429 is documented on the rate-limit page. No maximum number of ids per request, no response-size limit and no render timeout is documented. Until G2 shows what real responses weigh, request at most 20 ids at a time and avoid fetching a large whole file in one request; the 20 is my caution, not a documented limit.

`absoluteBoundingBox` is a required field of the layout trait in the OpenAPI spec (null when the node has no box), so it comes without `geometry=paths`; `size` and `relativeTransform` need `geometry=paths` and are not needed. Do not request `geometry=paths`: vector data would make responses much heavier.

### 2.3 How the prototype is represented

- **Flow starting points** are on the CANVAS (page) node: `flowStartingPoints: [{ nodeId, name }]`. `prototypeStartNodeID` on the page is deprecated. A page with an empty list is not a prototype.
- **Interactions are on layers, not only on frames.** In the OpenAPI spec `interactions` belongs to `TransitionSourceTrait`, which frames, groups, components, instances, rectangles, ellipses, vectors, lines, polygons, boolean operations and text all include; sections, sticky notes, connectors and slices do not (added to the REST API on 2024-09-12 per the changelog). **The human-readable node-types page is narrower**: it lists `interactions` only for frames and the types that inherit from them (groups, components, instances) and lists only the legacy `transitionNodeID` for shapes and text. Hotspots on text and rectangles are common in real files, so this disagreement is a G2 item. Each interaction is `{ trigger, actions[] }`. The older `transitionNodeID`, `transitionDuration` and `transitionEasing` fields are the legacy single-destination form; the spike ignores them.
- **Trigger** `type`: `ON_CLICK`, `ON_HOVER`, `ON_PRESS`, `ON_DRAG`, `AFTER_TIMEOUT` (with `timeout` ms), `MOUSE_ENTER`, `MOUSE_LEAVE`, `MOUSE_UP`, `MOUSE_DOWN` (with `delay`), `ON_KEY_DOWN` and `ON_KEY_UP` (with `device`, `keyCodes`), `ON_MEDIA_HIT` (with `mediaHitTime`), `ON_MEDIA_END`.
- **Action** `type`: `NODE` (`destinationId`, `navigation`, `transition`, `preserveScrollPosition`, `overlayRelativePosition`, `resetVideoPosition`, `resetScrollPosition`, `resetInteractiveComponents`), `BACK`, `CLOSE` (closes the topmost overlay), `URL` (`url`), `UPDATE_MEDIA_RUNTIME`, `SET_VARIABLE`, `SET_VARIABLE_MODE`, `CONDITIONAL` (`conditionalBlocks`, each with a `condition` and its own `actions`).
- **Navigation** on a `NODE` action: `NAVIGATE`, `OVERLAY`, `SWAP`, `SCROLL_TO`, `CHANGE_TO`. A `destinationId` of null means no destination.
- **Transition**: `DISSOLVE`, `SMART_ANIMATE`, `SCROLL_ANIMATE` (with `duration`, `easing`) and `MOVE_IN`, `MOVE_OUT`, `PUSH`, `SLIDE_IN`, `SLIDE_OUT` (also `direction`, `matchLayers`).
- **Boxes**: `absoluteBoundingBox` `{x, y, width, height}` in page coordinates, so a hotspot's box relative to its screen is its box minus the screen's. For a rotated layer it is the axis-aligned box around the rotation. `absoluteRenderBounds` includes effects such as shadows and is the wrong box for a hotspot.
- **Scrolling**: `overflowDirection` on a frame (`NONE`, `HORIZONTAL_SCROLLING`, `VERTICAL_SCROLLING`, `HORIZONTAL_AND_VERTICAL_SCROLLING`) and `scrollBehavior` on a layer (`SCROLLS`, `FIXED`, `STICKY_SCROLLS`).
- **Overlays**: the action carries `overlayRelativePosition`. **I did not find** the frame-level overlay settings (position type, background, "close when clicking outside") in the node-type page or in the four OpenAPI chunks read. If the REST API really omits them, a rebuilt overlay must assume a default (centred, dimmed background, dismissed by a click outside) and will differ from files that set something else. G2 must check this on a real file.

### 2.4 What an import costs in requests

1. `GET /v1/files/:key?depth=3`: pages, flow starting points, top-level frames (depth 3 reaches frames inside sections). This is also the call frame import needs to list frames.
2. `GET /v1/files/:key/nodes?ids=<page>&version=<v>` at full depth for the page that holds the chosen flow. Hotspots live deep in the tree, so the reachable set can only be computed after this call.
3. `GET /v1/images/:key?ids=<reachable frames>&scale=2&format=png&version=<v>`, then download every URL.

Three Tier 1 requests per import.

### 2.5 Tokens, seats and rate limits

- **Personal access token**: Settings, Security tab, "Generate new token"; chosen expiry and scopes; shown once; sent as the `X-Figma-Token` header. Since 2025-04-28 a token expires within **90 days** at most (changelog), so a Gnomi user will have to replace it regularly and the app must treat 403 as "expired or invalid token" with that explanation.
- **Scope**: `file_content:read` covers all three Tier 1 endpoints. The broad `files:read` is deprecated. A scope does not widen what the user can already open: the token holder must have access to the file.
- **Seat**: any account can make a token, but the *request budget* depends on the seat the token's owner holds in the file's plan. Tier 1:

  | Seat | Starter | Professional | Organization | Enterprise |
  |---|---|---|---|---|
  | Dev, Full | 10 / min | 15 / min | 20 / min | not shown in the text I received |
  | View, Collab | up to 20 / **month**, all plans | | | |

  The page's own example says that a personal access token reading a file on a **Starter** plan is limited to **6 requests per month**, even if the user has a Full seat on another plan. The View and Collab figures are maximums that "may be lower during high demand". Limits are tracked per user and plan for personal access tokens, leaky-bucket, with `429` and `Retry-After`.
- At three Tier 1 calls per import, a View or Collab seat gets about six imports a month, and a Starter-plan file through a personal token gets two. Treat those seats as unsupported for imports, as tech.md already says, and tell the user which budget applies when the first call returns.
- **Variables**: reading variable definitions needs `file_variables:read`, which the scopes page lists as Enterprise only. So even a rebuild willing to evaluate conditions could not read the values it needs on most plans.

### 2.6 Terms that bear on this (paraphrased; legal must read the originals)

- **Developer Terms, effective 2026-05-05.** §2: the licence covers using the developer resources to develop, test and support an integration, *as permitted in Figma's developer documentation*. §4(f): Figma integrations must allow data to flow in both directions, and Figma may stop an integration from using its APIs if it blocks "write-back tool calls"; neither "tool calls" nor "write-back" is defined, and the wording reads as aimed at tool-style (MCP) integrations, but it is not limited to them. §4(e): Figma may build products that compete with integrations. §4(b)–(c): Figma may change or deprecate resources, and may suspend access at any time. §8(e): Figma may add or change rate limits and fees on thirty days' notice. §3(a): credentials must not be shared, and the credential type Figma designates for the use case must be used. §7(b): integrations offered beyond the developer's own organisation need user consents and a privacy policy. Nothing in what I received addresses caching, displaying or storing API data, AI use of API data (it points to separate "Figma AI Terms" that I did not read), or prototypes.
- **Acceptable Use Policy, last updated 2026-10-07.** §2(j): no scraping, systematic extraction or "programmatic access" to Figma or its content *except as expressly permitted by Figma*. §2(e): do not use the Services to compete with Figma or *copy any ideas, features, functions or graphics* of the Services. §2(k): no third-party content without permission. The policy does not mention prototypes, presentation view or embeds.
- **Personal access tokens** are described on the authentication page as for individual use, scripts and local tooling against one's own account.

## 3. What can and cannot be rebuilt

| Feature | In the REST data | Rebuilt in the reduced version |
|---|---|---|
| Flows, starting points, multiple flows per page | Yes | **Yes.** One flow per run, chosen by the user; a persona starts at its starting point. |
| Click or tap to navigate (`ON_CLICK`, `NAVIGATE`) | Yes, with box | **Yes.** |
| Open, swap, close overlay | Yes (`OVERLAY`, `SWAP`, `CLOSE`) | **Yes**, with a *default* overlay position and dismissal unless G2 finds the settings (§2.3). `overlayRelativePosition` is honoured. |
| Back | Yes | **Yes**, using a history stack. Exact rules (does Back also close an overlay? `SWAP` is not added to history per the Help Center) need checking against real prototypes. |
| Scroll to an anchor, scrolling frames, fixed layers | Yes (`SCROLL_TO`, `overflowDirection`, `scrollBehavior`) | **Partly.** The parser keeps scroll direction, the fixed flag and boxes that lie past the frame's edge. Whether a frame export contains the scrolled-away content is unverified; if not, the persona sees only the first viewport and below-the-fold hotspots become false dead ends. G2. |
| After-delay transitions (`AFTER_TIMEOUT`) | Yes | **Yes**, fired when the persona waits. |
| Open a link | Yes | **Partly.** Ends that path ("left the prototype for <url>"). The link is never fetched. |
| Press and mouse down or up | Yes | Treated as a click. |
| Hover, mouse enter or leave | Yes | **Not in v1**; recorded. Hover states exist on desktop designs and a desktop persona could hover; later. |
| Drag, key, gamepad, video triggers | Yes | **No**; recorded, listed in the pre-run summary. |
| Smart animate, dissolve, push, slide, easing | Yes (type, duration, easing) | **Dropped.** The persona sees the destination frame. Judging animation is out of scope. |
| Variables, `SET_VARIABLE`, `SET_VARIABLE_MODE` | Actions yes; variable definitions Enterprise only | **No.** Reported as unsupported. |
| Conditional logic (`CONDITIONAL`) | Blocks yes; condition values need variables | **No.** Every branch that navigates is kept and marked `conditional`, so the map shows where a click *may* lead; the persona follows the first. Reported as unsupported. |
| Interactive components (`CHANGE_TO`, variant swaps, toggles, hover states of instances) | Action yes; the other variant is a separate renderable node | **No in v1.** Compositing a variant's render over the instance would work for one level but not for state that persists and nests. Reported as unsupported; the layer stays tappable. |
| Text input, forms, checkboxes | Not real inputs in prototypes (faked with variables) | **No.** Typing is accepted and assumed done. |
| Video and audio actions | Yes | **No.** |
| Interactions inherited by instances from a main component | **Unverified** whether an instance's `interactions` list includes the main component's | G2 |
| Clipping by ancestors, masks, layers at zero opacity | Not in the data a hotspot walk sees | **No.** A hotspot may exist in the data where nothing is visible. Known shortcut in the parser. |
| Other pages | Flows do not cross pages | Not applicable |

Anything in the "No" rows that appears on a flow's reachable path is counted in the pre-run summary the user sees on the flow map ("12 screens, 31 hotspots; 3 conditions and 2 component states are not simulated"), and a click on such a layer is **not** counted as a friction (§5).

## 4. The rebuilt flow: data model and parser

`engine/src/figma/spike/flow.ts` (removed; see `git show d3696fa:engine/src/figma/spike/flow.ts`) turns the JSON of `GET /v1/files/:key` into one `Prototype` per page that has a flow starting point. Only screens reachable from a starting point are kept; hotspots are relative to their screen; hidden layers are skipped.

```ts
type Box = [x, y, width, height]                       // frame pixels, the tuple the engine already uses for targets

type Prototype = { page, flows: { name, start }[], screens: Record<id, Screen>, unsupported: { at, kind }[] }
type Screen    = { id, name, size: [w, h], scroll: 'none' | 'vertical' | 'horizontal' | 'both', hotspots: Hotspot[] }
type Hotspot   = { id, name, box: Box, fixed: boolean,  // one per interaction on one layer, in tree order (later = on top)
                   trigger: 'click' | 'press' | 'hover' | 'drag' | 'timeout' | 'key' | 'media' | 'other', ms: number | null,
                   actions: Action[] }                  // empty when the file's action cannot be played: still tappable
type Action    = { kind: 'navigate' | 'swap' | 'overlay' | 'scroll_to', to, transition, at } // `at`: overlayRelativePosition
               | { kind: 'back' | 'close' } | { kind: 'link', url }                           // any of them may carry `conditional: true`
```

Overlays are not a flag on a screen: whichever screen an `overlay` action targets is shown as an overlay *at that moment*, which the runtime knows from its stack. A frame's own interactions (a timer, say) become a hotspot covering the whole screen.

The test (removed; see `git show d3696fa:engine/src/figma/spike/flow.test.ts`) builds the fixture in `fixture.json` (a five-screen checkout flow plus an overlay, a scrolling screen, a conditional, a component-state toggle, a dangling destination, an unreachable frame and a page with no flow) and checks reachability, relative boxes, every action kind, scroll and fixed layers, the unsupported report, and that no other source file imports the spike. The parser's known shortcuts are marked `shortcut:` in the code.

### Runtime sketch (not built)

State: `{ screen, overlays[], history[], scrollY }`. A persona step is one of `click(x, y)`, `scroll(dy)`, `wait`, `done`, `give_up`, in frame coordinates (normalised 0–1000 against the shown image). Applying a click: the topmost hotspot containing the point, among those visible now (non-fixed hotspots move with `scrollY`; an open overlay's scrim blocks what is under it) — then its first action:

- `navigate`: close any overlays, push the current screen on `history`, show `to`.
- `overlay`: push `to` on `overlays`. `swap`: replace the top overlay, or the current screen without a history entry.
- `close`: pop an overlay. `back`: pop `history`. `scroll_to`: set `scrollY`. `link`: end the path.
- `wait` fires `timeout` hotspots on the current screen.

Observation: the current frame PNG, with an open overlay composited over a dimmed copy of the screen below it. Three ways to composite, cheapest first: send the two images and say which is on top; draw them in a small local HTML page screenshotted by the Playwright pool the engine already has (this also gives the click-map evidence below); or add an image library. The second is the likely choice, and does not need the containment layer because the page is Gnomi's own.

## 5. How personas interact, and what counts as friction

- **Perception is vision-only**: the frame image, as for the static-design POI. No hotspot is outlined for the persona (that would hand it the answer), and the accessibility-snapshot route used for web POIs does not apply.
- **A click on a hotspot** follows the file's interaction. **A click elsewhere** is a *dead click*: the persona is told "nothing happened", and the step is recorded with the frame, the click point and the persona's stated expectation ("expected this to be tappable").
- **Caveat that matters for the report:** a dead click may mean the design is unclear, or only that the designer has not wired that layer yet. The report should therefore rank dead clicks by how many personas converge on the same place, show them as a click map over the frame, and word the finding as "personas expected this to be tappable; the prototype has no interaction here". One persona's miss is noise.
- **Near misses.** A click just outside a hotspot (the 24 px margin is a placeholder) is a separate finding about target size or position, and could reuse the existing small-target threshold (24 px) on hotspot boxes.
- **Not counted as friction:** a click on a layer that is tappable in the file but whose action is unsupported (§3). The persona is told the prototype cannot show what happens next and that path ends; the report lists these as "not simulated" so they do not dilute the real findings.
- **Reused signals:** loops and repeated back-and-forth work on a screen id plus a visit count, so the existing loop and backtrack rules should carry over once their input is a screen id rather than a URL and a DOM hash (not checked in code).
- **Evidence:** the frame, the click point and the quote, as tech.md §7 already lists for this POI.
- **Forms:** typing is accepted without effect, because prototypes cannot take input. The persona prompt says so, otherwise every form screen produces a "could not type" complaint.

## 6. Cost and performance

- **Import**: three requests (§2.4). One 375×812 frame at `scale=2` is about 1.2 megapixels, far below the 32-megapixel cap; a 50-frame flow is 50 downloads of a few hundred KB to a few MB each. Frame import already has to meet the roadmap's "50 frames in ten seconds", which this does not add to. The 30-day render URL expiry means the PNGs must be stored at import.
- **Parsing**: on a synthetic page of 50,100 nodes (100 frames, 6.7 MB of JSON, one interaction on every tenth layer) `parseFile` takes 8–60 ms after `JSON.parse` takes 30–50 ms (one machine, three runs, a throwaway script). Real nodes carry fills, strokes, effects and text styles and weigh far more, and no response-size limit is documented, so the download and `JSON.parse` of a large page, not the walk, will dominate. G2 should record real response sizes.
- **Per persona-step**: one image (about 1,000–1,800 tokens by tech.md §6.2's figure; the downscaled screenshot is about 1.2k) plus a prompt and a short answer. Assuming about 3k input and 0.3k output tokens per step and tech.md §10.3 prices, 20 personas × 12 steps = 240 steps is roughly 0.7M input and 0.07M output tokens: **about $0.11 on Haiku 5.5, about $2.10 on Sonnet 5.5** (an estimate; no run was made). Cheaper than a web POI run because there is no browser, no snapshot text and no containment.
- **Runtime**: no browser pool for the simulation itself; the state machine is in-memory. If overlays are composited in a Playwright page, one lightweight page per persona is enough.
- **Throughput limit** is the model, as everywhere else, not Figma: after import there are no further API calls.

## 7. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| **Terms** (below) | Could forbid the feature or the whole importer | G1 before any M7 work; keep the importer read-only and local |
| Files in the wild differ from the documented schema (overlay settings, inherited interactions, scroll renders, huge responses) | Wrong hotspots or missing screens | G2; the parser's `unsupported` list; draw boxes over exports before trusting a flow |
| Unwired prototypes turn into "friction" | False positives that erode trust | Rank by convergence; word findings as expectation, not defect (§5) |
| Vision models mis-click | Dead clicks that are model error | G3; near-miss band; low-temperature navigator |
| Real prototypes lean on variables, conditions and component states | The simulation shows a different product | Pre-run summary of what is not simulated; fall back to the frames sequence when too much is unsupported |
| Token and seat friction | Designers on View or Collab seats cannot import; tokens expire within 90 days | Say which budget applies on the first call; explain 403 as expiry; keep the raw response so a re-run needs no new import |
| API and policy change | Figma may change limits, deprecate fields or suspend access (Developer Terms §4(b)–(c), §8(e)) | Isolate Figma behind one import module; treat the stored JSON and PNGs as the product's input |
| Customer designs are confidential | Sending frames to a model provider | Local-first and bring-your-own-key already mean the user chooses the provider; the settings screen should say that frames go to it |

### Questions for the legal read

1. **Two-way data flow (Developer Terms §4(f)).** Does the requirement apply to a local desktop app that only reads (`GET` file, nodes and images with a personal token) and never calls a write endpoint? What are "tool calls" and "write-back" meant to cover? tech.md and idea.md already flag this; it affects frame import as much as the simulation.
2. **Licence scope (§2).** Is downloading frames and rebuilding interaction behaviour from file data inside "an integration with the Services, as permitted in Figma's developer documentation"? The documentation permits fetching files, nodes and renders; it does not discuss building a player.
3. **Copying Figma's functions (AUP §2(e)).** Does re-implementing prototype *playback* (navigation, overlays, back) count as using the Services to copy a feature or function? This is the clause that separates the simulation from frame import. Read the 2026-10-07 text: tech.md cites the 2026-03-26 version, and I did not compare the two.
4. **Programmatic access (AUP §2(j)).** Confirm that REST access with a user's token is "expressly permitted", and that Gnomi must never request a `figma.com/proto/...` page. The importer should take the file key and node ids out of a pasted link (their layout is not in the developer documentation, so it needs checking) and call only the REST API.
5. **Credential type (Developer Terms §3(a); authentication page).** Personal access tokens are described as for individual use and local tooling. May a commercially distributed app ask each user to paste one, or must it register an OAuth app (and then publish a privacy policy and gather consents, §7(b))? An OAuth app changes setup, rate-limit accounting (per user, plan and app) and distribution.
6. **Sending frames to AI providers.** The terms I received do not address it and point to Figma AI Terms. Does sending a user's exported frames to a third-party model, using the user's own key, need anything from Figma or from the user beyond their own authority over the file?
7. **Storage.** Is keeping exports and the raw file JSON in a local project folder, and in an exported report, within the terms?
8. **The importer that now exists (M5).** Frame import is built ([pois.md](pois.md#figma-frames-enginesrcfigma)): users paste a personal access token in Settings, Gnomi calls `GET /v1/files/:key`, `/v1/files/:key/nodes` and `/v1/images/:key` read-only, downloads the renders from Figma's image storage and keeps the PNGs in the project. Questions 1, 4, 5 and 7 therefore apply to this importer now, not only to the simulation: settle them before a commercial release.

## 8. Corrections suggested to existing docs

Not made here, because other sessions are editing these files:

- tech.md §4.16, idea.md: "only 20 requests per month" on View and Collab seats should read "up to 20 per month, and 6 per month for a file on a Starter plan reached with a personal token"; the Enterprise figure for Dev and Full was missing from the page text I received.
- tech.md §4.16 and its source line cite the Developer Terms and Acceptable Use Policy as 2026-03. The pages now show Developer Terms effective 2026-05-05 and the Acceptable Use Policy last updated 2026-10-07.
- tech.md §7 and §4.16 say interactions are "per-frame". They are on any layer, which is what makes hotspots possible; `flowStartingPoints` is on the page, not the frame.
- tech.md: personal access tokens expire within 90 days (since 2025-04-28), and `files:read` is deprecated in favour of `file_content:read`.
- roadmap.md "Deliberately deferred" and M7 "Out of scope": record the decision in §1 once the gates are scheduled.

## 9. What this spike did not do

- No real Figma file, no token, no request to Figma; the parser has only seen the fixture.
- Overlay settings, instance-inherited interactions, scroll renders, id limits, response sizes and the proto link format are unverified (flagged above).
- No vision-model click test (G3), no UI, no persona loop, no change to any product code.
- The documentation was read through a summarising fetch tool; the legal pages in particular need a human reading the originals.
