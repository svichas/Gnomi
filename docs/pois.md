# Points of interest: the registry contract

How a project holds several points of interest (POIs) and how a new POI type plugs in. This is the M5 foundation of [tech.md §7](tech.md#7-poi-ingestion-and-interaction); the text, static-design, competitor and Figma pieces each add or replace files listed here rather than editing shared ones.

## Data

- `ProjectConfig.pois: Poi[]`, in the order personas use them. `Poi = WebPoi | TextPoi | DesignPoi` (`simulation/src/types.ts`). Every POI has `id`, `name` and `segments`.
- `task` and `context` are optional strings on any POI (`PoiBase` in `simulation/src/types.ts`). `task` is the POI's own task: while personas are on it, it replaces the goal in every per-POI persona prompt and leaves out the persona's reading of the project goal (`goal_interpretation`, in the task section and the persona block); `context` is what the setup implies and the screens do not say, added as one line after the product. Both are read by `taskSection` in `simulation/src/agent/prompt.ts` and by `productFor` in `simulation/src/report/models.ts`, where the task becomes the product goal and the context `product.context`. Comparison studies ignore them, since the assignment already replaces the goal, and neither is in the profile signature, so editing them rewrites no persona.
- `segments: string[] | null` lists the segment ids that use the POI. `null` means the default for each segment's kind (`isEligible` in `simulation/src/poi/pois.ts`): segments of kind `user` (or with no kind, as saved before M5) use every POI; segments of kind `buyer` only perceive, so they use text and design POIs, never a web app. The built-in persona of a project without an audience uses every POI.
- `WebPoi.mode` is `full` (the team's own product) or `observe_only` (a competitor's site, [below](#observe-only-web-pois-competitors)). Logins are recorded on, and a recorded session's start page applies to, the first web POI in full mode (`loginPoi`). That POI is also "the team's product" a competitor is compared with.
- `TextPoi.asset` and `DesignPoi.frames[].asset` are asset ids (below).
- Step and friction payloads may carry `frame` (index into `DesignPoi.frames`) and `passage` (`{ start, end, text? }` character offsets, end exclusive). A friction's passage carries `text`, the quoted span as the engine verified it; a text step's passage is the part it read, without `text`. The report carries them into `ReportFriction` and `ReportEvidence`, and the Markdown and HTML exports and the report view print them, with the quote when there is one.
- `Segment.kind` is `user` (or absent) or `buyer`; the audience editor sets it with a Users / Buyers control on each segment.
- Projects, run snapshots and `run.started` events saved with one `poi` read as `pois: [poi]` with `mode: 'full'` and `segments: null` (`withPois`, applied by the SQLite store, `buildReport` and the graph).

## Scheduling

`startRun` (`simulation/src/run.ts`) gives each persona `poisFor(project.pois, segment)` and runs them one after another in that order. For each POI it calls the type's runner, then asks the persona's survey about that POI (`persona.survey` with its `poi_id`). Personas of a `buyer` segment answer the buying survey instead (Text, below). A run-wide stop ends the sequence; any other ending moves on to the next POI. A persona with no POI stops the run before it starts; the host's preflight says so earlier.

- **Step numbers run on across a persona's POIs.** The second POI's first step is `stepsBefore + 1`. This keeps `(persona, step_no)` unique for the report, screenshots (`runs/<run>/shots/<persona>-<step_no>.jpg`) and signals. The prompt still shows "Step 1 of N" for each POI.
- **Budgets** come from the runner: `poiBudget(persona, poi)` is the runner's `budget(patienceBudget, poi)`, at least 1.
- **Social rounds** slice a persona's steps across its POIs: the slice is `ceil(sum of its POI budgets / rounds)`, and `deps.slice.next()` is due before every global step number `k·slice + 1`. It resolves with the opinion the social phase left and `heard`, the posts the persona read there, which a runner shows in its next step only (`heardLines` in `agent/prompt.ts`). A text read in one sitting ends in round 1; the rounds after it are discussion only, while anyone has something new to read (tech.md §6.4).
- **Shared prefix.** A text POI's part goes in the request's `shared` field, ahead of the persona's system prompt with a cache breakpoint of its own, so every persona reading that part reuses one cached copy (Chat Completions endpoints get it at the start of their one system message).
- Report themes are grouped and ranked per `poi_id` (after a `report.started` event listing them, every POI's judge call runs at once, then its evidence check when that is on, merged into one `report.checks`, then its author calls in parallel batches of three themes, merged into one `report.suggestions`). The report lists `pois`; the report view, the HTML and Markdown exports, the inspector, the feed and the review screen name every POI.

## Engine registry: `simulation/src/poi/`

```ts
interface PoiRunner<P extends Poi> {
  budget(patienceBudget: number, poi: P): number;          // steps for one persona on this POI
  preflight(poi: P, project: ProjectConfig, hasAsset: (id: string) => boolean): string | null; // a sentence that blocks the run, or null
  episode(poi: P, deps: EpisodeDeps): Promise<EpisodeEnd>;  // one persona's episode
}
```

`RUNNERS` in `index.ts` maps each type to its runner; `preflight(project, hasAsset?)` runs every POI's check after "is there a POI" and "does every segment with a share have one". The host and the CLI call it before a run (through `checkRun` in `engine/src/workspace.ts`) with `hasAsset` checking the project's `assets/` folder.

| Type | File | Today |
| --- | --- | --- |
| `web` | `web.ts` | The browsing loop (`agent/loop.ts`); budget is the patience budget; preflight is the production-domain guard (`checkTarget`). Observe-only POIs run with no session. |
| `text` | `text.ts` | Read and rate, below; budget is one part per 15 steps of patience budget; preflight refuses a text without its `.md` or `.txt` asset. |
| `design` | `design.ts` | The expectation loop below; budget is the number of frames, capped by the patience budget; preflight refuses an empty design, a missing frame and a navigator that cannot see images. |

An episode runner must:

- emit every event with `poi_id: poi.id` and `round: deps.round()`, starting with `persona.episode_started` (`start_url` is required: a non-web POI can put a stable label such as `asset:<id>` there);
- number its steps `deps.stepsBefore + 1 …` and stop after `deps.budget` steps with `signal.budget_exceeded`;
- call `deps.beginStep()` before each model call and `deps.endStep()` after it; `false` from `beginStep` means stop with `'stopped'`;
- pass `deps.signal` to model calls and return `'stopped'` once it is aborted;
- with `deps.slice`, await `deps.slice.next()` before each step whose number `n > 1` has `(n - 1) % deps.slice.steps === 0`; `null` means stop;
- record frictions as `persona.friction_reported` (with `frame` or `passage` when there is no page) and opinions as `persona.opinion_changed`, as the web loop does;
- end with `persona.goal_done`, `persona.abandoned` or a signal, and return the matching `EpisodeEnd`. The scheduler runs the survey; the runner does not.

`EpisodeDeps.openPage(poi)` opens a contained browser page for a web POI; other runners ignore it. Assets are read with `readAsset(deps.blobs, id)`.

## Static design: `simulation/src/poi/design.ts`

- **One step per frame, in order.** Each call (`purpose: 'design'`, the navigator role) shows the current frame and, after the first, the frame before it with what the persona said there. The answer (`designSchema` in `design-prompt.ts`) says whether this frame `matched` the persona's expectation (null on the first), what it `sees`, what it `would_do`, what it `expects_next`, `continue` or `abandon`, a `friction`, an `opinion`, a `thought` and a `feeling`.
- **A mismatch is a friction on the frame where the expectation failed:** `persona.friction_reported` with `frame`, `where.url` `asset:<id>`, and the model's friction, or, when it said `matched: false` without one, what it saw against what it said it expected. The step's thought is the quote.
- **Endings.** `abandon` ends with `persona.abandoned`; the last frame ends with `persona.goal_done` ("Looked through all N screens"); a sequence longer than the patience budget ends with `signal.budget_exceeded`. Two invalid answers are a failed step (`invalid_output`), as on the web; the next frame then has no expectation to compare with.
- **Steps.** `action` is `read` (`done` or `abandon` at the end), `target` is `{ role: 'frame', name: <step name or "Screen N"> }`, `frame` is the index, and `screenshot` is the frame's asset path `assets/<id>`, so the report view, the HTML export (main's thumbnails) and the inspector show the frame as the evidence image without code of their own (a WebP frame may be left out of the HTML export: main's thumbnails use `nativeImage`, which only promises PNG and JPEG). The report view and the Markdown export print the frame number on frictions and evidence.
- **Vision cost.** Only the current and previous frame are sent. A PNG frame is downscaled to at most 1,024 px on its long side (`frames.ts`, a small PNG decoder and encoder on `node:zlib`), once per asset id and shared by every persona. JPEG and WebP frames, and PNGs the decoder does not read (interlaced, under 8 bits per channel), are sent at their own size. The design runner always sends frames, whatever the screenshots setting.
- **Preflight.** Refused: no frames; a frame whose asset is not in `assets/`; a text-only navigator model (DeepSeek V4-Pro); the local OpenAI-compatible endpoint, because Gnomi cannot tell whether its model reads images. Anthropic, OpenAI, Google and DeepSeek V4.1-Flash navigators run.
- **Scripted.** `DEMO_DESIGNER` in `llm/scripted.ts` (also through `DEMO_NAVIGATOR` for `purpose: 'design'`) passes every frame and logs a labelled sample mismatch on the second. `poi/design.test.ts` runs Gym v3's checkout frames with a scripted shopper that reads each frame through a lookup of its HTML: D26 gives one mismatch on frame 4, the control none.
- **App.** `DesignPoiForm.tsx` adds frames with a file picker or by dropping files (`window.gnomi.pathForFile`, then `import_asset { path }`), shows thumbnails through `get_blob`, and edits an optional step name, the order and removal per frame. A design with no frames does not save.

## Assets: `simulation/src/assets.ts`

- Files live in the project's `assets/` folder under a content id: 16 hex characters of the SHA-256 and the extension, for example `3f9a…c2.md`. Ids are always safe file names; `assetPath` refuses anything else.
- Types: `.md` and `.txt` (UTF-8, at most 2 MB), `.png`, `.jpg`/`.jpeg` and `.webp` (checked by file signature, at most 20 MB). Nothing is fetched from the network; PDF and Word are out of scope for now.
- Host protocol: `import_asset` with `{ path }` (a local file the user chose) or `{ text, name? }` (pasted text) returns `{ id, name, mime, bytes }`. `get_blob` with `assets/<id>` returns the file, for previews.

## Text: `simulation/src/poi/text.ts`

- **One step per part of the text.** A text is cut at paragraph breaks into parts of at most 48,000 characters (~12k tokens), so most copy is one part and one call. Each call (`purpose: 'read_text'`, the navigator role, prompt and `readSchema` in `text-prompt.ts`) shows the part with the character offset it starts at, plus what the persona took from earlier parts. The answer thinks aloud, rates (the `opinion`), lists up to five `confusions` as `{ quote, start, end, what, expected, severity }`, and says `read_on` (only while parts remain), `done` with what the persona would do next, or `abandon` with why it stops.
- **Every quote is checked against the text read so far.** Offsets that hold the quote stay; otherwise the quote's occurrence nearest to them is used, matched exactly and then ignoring case and runs of white space; a quote the text does not hold keeps its friction without a quoted passage. Each confusion is a `persona.friction_reported` with `passage: { start, end, text }`, `where.url` `asset:<id>`; the step's `passage` is the part it read, its `action` `read`, `done` or `abandon`, and its thought the quote.
- **Endings and budget.** `done` ends with `persona.goal_done` (the summary is what the persona would do next), `abandon` with `persona.abandoned`. The budget is one part per 15 steps of patience budget (patience 1 → 1, 5 → 4); a reader out of budget before the end gets `signal.budget_exceeded`. Two invalid answers are a failed step (`invalid_output`) and the same part is read again.
- **Preflight** refuses a POI whose asset is not a `.md` or `.txt` id and, given a `hasAsset` check, one whose file is not in `assets/`; a missing or blank file at run time ends the run with an error.
- **Buyers.** Personas of a `buyer` segment answer the buying survey after each POI (`askBuyer` in `simulation/src/agent/buyer.ts`, `purpose: 'buyer_survey'`): would they buy or recommend buying, how the price looks (`low`, `fair`, `high`, `unclear`), what would stop them and what was unclear. It is recorded as `persona.survey` with `buyer` filled in, its objections as `frictions` and would-buy as `would_continue`, so sentiment by segment and the themes count buyers too. The hook in `run.ts` is one branch before the usage survey.
- **Report.** A text's confusions group into themes by the passage they quote (the candidate's element is `passage "…"`), so a text POI's ranked themes are its confusions, with the persona's thought as the quote and the passage as evidence. `Report.buyers` (`report/buyers.ts`) has, per POI and buyer segment, the surveyed count, mean sentiment, the share who would buy or recommend, the price answers, and objections and unclear points grouped by their words. The report view (`BuyerSurvey.tsx`, so also the HTML export) and the Markdown export show it as "Buying survey", and print a friction's quoted passage.
- **Scripted.** `DEMO_NAVIGATOR` answers `read_text` with `DEMO_READ` (the part's first line as a labelled sample confusion at its real offsets) and `buyer_survey` with `DEMO_BUYER_SURVEY`. `poi/text.test.ts` runs Gym v3's pricing copy (D28) with a buyer and a user segment.
- **App.** `TextPoiForm.tsx` takes pasted text or a `.md`/`.txt` file (read in the page, checked for UTF-8 and 2 MB, sent as `import_asset { text, name }`) and previews the saved text, with "Replace the text". The audience editor's Users / Buyers control sets `Segment.kind`. `npm run smoke:text -w @gnomi/app` pastes the pricing copy, marks a segment as buyers and runs it with the scripted models.

## Project setup

The Points of interest section offers four ways to add material: a web app, pasted or uploaded text, design images, or frames from Figma. Numbered rows show the order personas try them. Open a row to edit it, use the arrow controls to reorder it, or remove it with the trash control. Adding an item opens its editor and focuses its name. Collapsing an editor preserves unfinished text and ongoing imports. Changes are saved with **Save project** or **Continue to audience**.

Names are optional. Audience selection is under **Who tries this?**, and website restrictions are under **Website access & safety**. Product sites need no staging confirmation; competitor sites remain observe-only. The design picker accepts multiple PNG, JPEG, or WebP files, either selected or dropped.

`npm run smoke:poi -w @gnomi/app` checks adding, collapsing without losing text, keyboard focus, reordering, removing, saving, the Figma entry point, and narrow layouts in a disposable Electron project.

## App registry: `app/src/renderer/src/poi/`

- `index.ts` holds `POI_KINDS`: per type a `PoiKind` with `label`, `blank(id)`, `draft(poi)`, `toPoi(draft)` (the POI or a sentence saying what is missing) and `title(draft)`. Drafts are what the Project screen edits; `form.ts` turns them into `ProjectConfig.pois`.
- `PoiList.tsx` is the ordered list (add, rename, reorder, remove, choose segments) and maps each type to its form component, which gets `PoiFormProps`: `{ draft, onChange, sessions }`.
- `web.ts` and `WebPoiForm.tsx` are today's web fields; `text.ts` + `TextPoiForm.tsx` the text's and `design.ts` + `DesignPoiForm.tsx` the design's frames (both above).
- Files on disk reach `import_asset { path }` through the preload's `window.gnomi.pathForFile(file)` (Electron's `webUtils.getPathForFile`), for files from an `<input type="file">` or a drop.

## Observe-only web POIs (competitors)

A web POI with `mode: 'observe_only'` is browsed without writes (tech.md §7 "Competitor site", §9.3 "Observe-only mode").

- **Containment** (`browser/contain.ts`, `browser/observe.ts`): `PageOptions.observe` turns it on. On a listed host only GET and HEAD go out; every other method is aborted, and so is every WebSocket (its messages could write). A page's reads that are not a tab's page load may also reach unlisted hosts (not the blocked domains): `route()` passes them and the proxy tunnels them, https only, to hosts whose addresses are all public, so a site's CDNs, fonts, form scripts and embedded frames load, and the loopback and private networks stay shut. Page loads (navigation requests) go out one per two seconds per browser context (`OBSERVE_INTERVAL_MS`); a page's own subresources and its scripts' reads are not paced, and neither are redirect hops, which never reach `route()`. Each refusal is a `containment.blocked_request` with `reason: 'observe_only' | 'robots'` (no reason: a host outside the allowed ones), and the methods appendix counts blocked requests per host and reason.
- **robots.txt**: `run.ts` fetches `/robots.txt` from the POI's start origin once per run (`observeOptions`), with Node's fetch, not the browser. A 2xx is parsed (RFC 9309: the groups naming `gnomi`, else those for `*`; the longest matching rule wins, allow wins a tie; `*` and a final `$` work); a 4xx means no rules; a 5xx, a timeout or no answer keeps Gnomi off the whole origin. Only page loads on the start origin are checked; other allowed hosts are not.
- **What the persona hears**: an action that set off a blocked write (a form post, or a script's POST from a click) fails with `submit_blocked`; a page load robots.txt disallows fails with `robots_disallowed`. The page goes back from the browser's error page, as with `host_not_allowed`. The navigator prompt (`systemPrompt(…, poi)`) says the site is a competitor being looked at and that nothing may be submitted, and explains both errors. A start page robots.txt disallows ends the run with an error that says so.
- **No login**: no recorded session is loaded for an observe-only POI, and a login page there is a page, not an expired session. The app offers the login recorder only when the project has a web POI in full mode.
- **Production**: an observe-only POI may be a production site (a live payment key on its pages is no tripwire), but listed production domains stay blocked and it may not have a reset hook.
- **Survey** (`poi/compare.ts`): `run.ts` passes the survey request through `comparisonFor(project, persona, poi, surveys).ask(…)`. For an observe-only POI, when the persona answered the team's product's survey earlier in the run, the survey also asks for `comparison: { prefers: 'product' | 'competitor' | 'no_preference', reason }`, and `persona.survey` records it with `with_poi_id`. List the competitor after the product: a persona that reaches the competitor first is not asked.
- **Report**: `pois[].competitor` marks observe-only POIs; `comparisons` gives each competitor's answers counted by segment, with the reasons. When a run also has a POI of the team's own, competitor events stay out of persona outcomes, step and friction counts, the frictions list, feelings, sentiment by segment and "what went well"; the competitor's own themes are ranked in its own section, as every POI's are.

## Figma frames: `engine/src/figma/`

"Add from Figma" on the POI list (`poi/FigmaImportDialog.tsx`) is not a POI type: it adds a `design` POI whose frames are Figma frames, stored as PNG assets, with the Figma frame names as step names.

- **Token.** Settings → Figma. Held like a provider key (`ProviderKeys` in `app/src/main/providers.ts`: encrypted `figma.key`, mask only in the page, last test remembered) and sent to the engine as the secret `figma_token`. The page never sees it; only the engine talks to Figma.
- **Modules.** `link.ts` (a pasted link → file key and node; only the key goes to the API, the link itself is never requested), `client.ts` (read-only REST client: the token goes in the `X-Figma-Token` header to `api.figma.com` only, redirects refused, `Retry-After` waited out up to 20 s and otherwise an error saying how long; a 403 is told apart by asking `/v1/me`), `frames.ts` (list, previews, export and store). `fake.ts` is a fixture API shaped like Figma's responses.
- **Host calls.** `figma_test`, `figma_frames {link}`, `figma_previews`, `figma_import` (which stores each PNG with `importAsset`, so the assets store's size and type checks apply). A frame that fails to export comes back in `failed` with its reason; the others are stored and the dialog lets the user retry or add what worked.
- **Requests.** A listing is one request (the file at depth 2) plus one for the contents of its sections; previews and exports are render requests of at most 20 frames, pinned to the listed file `version`; downloads go to Figma's image storage without the token.
- **Egress.** `api.figma.com` and `*.amazonaws.com` (render storage) are listed under Settings → Where Gnomi connects only while a token is saved (`egressList`).
- **Tests.** No network: unit tests use `fake.ts`; `GNOMI_FAKE_FIGMA=1` (or its options as JSON) makes the host use it, which `npm run smoke:figma` drives. Against a real file this code has never run (no token was available): see the legal and real-file gates in [figma-prototype-spike.md](figma-prototype-spike.md).
- **Not done.** The spike's suggestion to keep the full-depth page JSON with the version (the assets store has no JSON type); OAuth; importing prototype interactions.

## Not done here

- The usage survey prompt (users, on any POI) and the persona outcome are the web ones: a persona's outcome in the report is across all its POIs (any finished POI counts as done; a text counts once read to the end), and sentiment by segment pools the surveys of every POI, except a competitor's (above). The buying survey section is per POI.
- PDF and Word text imports (paste, `.md` and `.txt` only).
