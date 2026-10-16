# Points of interest: the registry contract

How a project holds several points of interest (POIs) and how a new POI type plugs in. This is the M5 foundation of [tech.md §7](tech.md#7-poi-ingestion-and-interaction); the text, static-design, competitor and Figma pieces each add or replace files listed here rather than editing shared ones.

## Data

- `ProjectConfig.pois: Poi[]`, in the order personas use them. `Poi = WebPoi | TextPoi | DesignPoi` (`engine/src/types.ts`). Every POI has `id`, `name` and `segments`.
- `segments: string[] | null` lists the segment ids that use the POI. `null` means the default for each segment's kind (`isEligible` in `engine/src/poi/pois.ts`): segments of kind `user` (or with no kind, as saved before M5) use every POI; segments of kind `buyer` only perceive, so they use text and design POIs, never a web app. The built-in persona of a project without an audience uses every POI.
- `WebPoi.mode` is `full` (the team's own product) or `observe_only` (a competitor's site, [below](#observe-only-web-pois-competitors)). Logins are recorded on, and a recorded session's start page applies to, the first web POI in full mode (`loginPoi`). That POI is also "the team's product" a competitor is compared with.
- `TextPoi.asset` and `DesignPoi.frames[].asset` are asset ids (below).
- Step and friction payloads may carry `frame` (index into `DesignPoi.frames`) and `passage` (`{ start, end }` character offsets, end exclusive). The report carries them into `ReportFriction` and `ReportEvidence`, and the Markdown export and report view print them.
- Projects, run snapshots and `run.started` events saved with one `poi` read as `pois: [poi]` with `mode: 'full'` and `segments: null` (`withPois`, applied by the SQLite store, `buildReport` and the graph).

## Scheduling

`startRun` (`engine/src/run.ts`) gives each persona `poisFor(project.pois, segment)` and runs them one after another in that order. For each POI it calls the type's runner, then asks the persona's survey about that POI (`persona.survey` with its `poi_id`). A run-wide stop ends the sequence; any other ending moves on to the next POI. A persona with no POI stops the run before it starts; the host's preflight says so earlier.

- **Step numbers run on across a persona's POIs.** The second POI's first step is `stepsBefore + 1`. This keeps `(persona, step_no)` unique for the report, screenshots (`runs/<run>/shots/<persona>-<step_no>.jpg`) and signals. The prompt still shows "Step 1 of N" for each POI.
- **Budgets** come from the runner: `poiBudget(persona, poi)` is the runner's `budget(patienceBudget, poi)`, at least 1.
- **Social rounds** slice a persona's steps across its POIs: the slice is `ceil(sum of its POI budgets / rounds)`, and `deps.slice.next()` is due before every global step number `k·slice + 1`.
- Report themes are grouped and ranked per `poi_id` (the judge and author run once per POI). The report lists `pois`; the report view, the HTML and Markdown exports, the inspector, the feed and the review screen name every POI.

## Engine registry: `engine/src/poi/`

```ts
interface PoiRunner<P extends Poi> {
  budget(patienceBudget: number, poi: P): number;          // steps for one persona on this POI
  preflight(poi: P, project: ProjectConfig): string | null; // a sentence that blocks the run, or null
  episode(poi: P, deps: EpisodeDeps): Promise<EpisodeEnd>;  // one persona's episode
}
```

`RUNNERS` in `index.ts` maps each type to its runner; `preflight(project)` runs every POI's check after "is there a POI" and "does every segment with a share have one". The host calls it before a run and the CLI before its one.

| Type | File | Today |
| --- | --- | --- |
| `web` | `web.ts` | The browsing loop (`agent/loop.ts`); budget is the patience budget; preflight is the production guard (`checkTarget`). Observe-only POIs run with no session. |
| `text` | `text.ts` | Stub: preflight refuses with "not available yet". Replace this file. |
| `design` | `design.ts` | Stub: preflight refuses with "not available yet". Replace this file; refuse a navigator without vision here. |

An episode runner must:

- emit every event with `poi_id: poi.id` and `round: deps.round()`, starting with `persona.episode_started` (`start_url` is required: a non-web POI can put a stable label such as `asset:<id>` there);
- number its steps `deps.stepsBefore + 1 …` and stop after `deps.budget` steps with `signal.budget_exceeded`;
- call `deps.beginStep()` before each model call and `deps.endStep()` after it; `false` from `beginStep` means stop with `'stopped'`;
- pass `deps.signal` to model calls and return `'stopped'` once it is aborted;
- with `deps.slice`, await `deps.slice.next()` before each step whose number `n > 1` has `(n - 1) % deps.slice.steps === 0`; `null` means stop;
- record frictions as `persona.friction_reported` (with `frame` or `passage` when there is no page) and opinions as `persona.opinion_changed`, as the web loop does;
- end with `persona.goal_done`, `persona.abandoned` or a signal, and return the matching `EpisodeEnd`. The scheduler runs the survey; the runner does not.

`EpisodeDeps.openPage(poi)` opens a contained browser page for a web POI; other runners ignore it. Assets are read with `readAsset(deps.blobs, id)`.

## Assets: `engine/src/assets.ts`

- Files live in the project's `assets/` folder under a content id: 16 hex characters of the SHA-256 and the extension, for example `3f9a…c2.md`. Ids are always safe file names; `assetPath` refuses anything else.
- Types: `.md` and `.txt` (UTF-8, at most 2 MB), `.png`, `.jpg`/`.jpeg` and `.webp` (checked by file signature, at most 20 MB). Nothing is fetched from the network; PDF and Word are out of scope for now.
- Host protocol: `import_asset` with `{ path }` (a local file the user chose) or `{ text, name? }` (pasted text) returns `{ id, name, mime, bytes }`. `get_blob` with `assets/<id>` returns the file, for previews.

## App registry: `app/src/renderer/src/poi/`

- `index.ts` holds `POI_KINDS`: per type a `PoiKind` with `label`, `blank(id)`, `draft(poi)`, `toPoi(draft)` (the POI or a sentence saying what is missing) and `title(draft)`. Drafts are what the Project screen edits; `form.ts` turns them into `ProjectConfig.pois`.
- `PoiList.tsx` is the ordered list (add, rename, reorder, remove, choose segments) and maps each type to its form component, which gets `PoiFormProps`: `{ draft, onChange, sessions }`.
- `web.ts` and `WebPoiForm.tsx` are today's web fields. `text.ts` + `TextPoiForm.tsx` and `design.ts` + `DesignPoiForm.tsx` are placeholders: the text and design pieces replace those two files each.

## Observe-only web POIs (competitors)

A web POI with `mode: 'observe_only'` is browsed without writes (tech.md §7 "Competitor site", §9.3 "Observe-only mode").

- **Containment** (`browser/contain.ts`, `browser/observe.ts`): `PageOptions.observe` turns it on. On a listed host only GET and HEAD go out; every other method is aborted, and so is every WebSocket (its messages could write). Page loads (navigation requests) go out one per two seconds per browser context (`OBSERVE_INTERVAL_MS`); a page's own subresources and its scripts' reads are not paced, and neither are redirect hops, which never reach `route()`. Each refusal is a `containment.blocked_request` with `reason: 'observe_only' | 'robots'` (no reason: a host outside the allowed ones), and the methods appendix counts blocked requests per host and reason.
- **robots.txt**: `run.ts` fetches `/robots.txt` from the POI's start origin once per run (`observeOptions`), with Node's fetch, not the browser. A 2xx is parsed (RFC 9309: the groups naming `gnomi`, else those for `*`; the longest matching rule wins, allow wins a tie; `*` and a final `$` work); a 4xx means no rules; a 5xx, a timeout or no answer keeps Gnomi off the whole origin. Only page loads on the start origin are checked; other allowed hosts are not.
- **What the persona hears**: an action that set off a blocked write (a form post, or a script's POST from a click) fails with `submit_blocked`; a page load robots.txt disallows fails with `robots_disallowed`. The page goes back from the browser's error page, as with `host_not_allowed`. The navigator prompt (`systemPrompt(…, poi)`) says the site is a competitor being looked at and that nothing may be submitted, and explains both errors. A start page robots.txt disallows ends the run with an error that says so.
- **No login**: no recorded session is loaded for an observe-only POI, and a login page there is a page, not an expired session. The app offers the login recorder only when the project has a web POI in full mode.
- **Production**: an observe-only POI may be a production site (no "not production" confirmation, and a live payment key on its pages is no tripwire), but listed production domains stay blocked and it may not have a reset hook.
- **Survey** (`poi/compare.ts`): `run.ts` passes the survey request through `comparisonFor(project, persona, poi, surveys).ask(…)`. For an observe-only POI, when the persona answered the team's product's survey earlier in the run, the survey also asks for `comparison: { prefers: 'product' | 'competitor' | 'no_preference', reason }`, and `persona.survey` records it with `with_poi_id`. List the competitor after the product: a persona that reaches the competitor first is not asked.
- **Report**: `pois[].competitor` marks observe-only POIs; `comparisons` gives each competitor's answers counted by segment, with the reasons. When a run also has a POI of the team's own, competitor events stay out of persona outcomes, step and friction counts, the frictions list, feelings, sentiment by segment and "what went well"; the competitor's own themes are ranked in its own section, as every POI's are.

## Not done here

- The buyer survey, a vision check for designs, and a segment-kind control in the audience editor (segments have `kind`, but nothing in the app sets it yet).
- The survey prompt and the persona outcome are the web ones: a persona's outcome in the report is across all its POIs (any finished POI counts as done), and sentiment by segment pools the surveys of every POI, except a competitor's (above).
