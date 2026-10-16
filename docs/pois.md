# Points of interest: the registry contract

How a project holds several points of interest (POIs) and how a new POI type plugs in. This is the M5 foundation of [tech.md §7](tech.md#7-poi-ingestion-and-interaction); the text, static-design, competitor and Figma pieces each add or replace files listed here rather than editing shared ones.

## Data

- `ProjectConfig.pois: Poi[]`, in the order personas use them. `Poi = WebPoi | TextPoi | DesignPoi` (`engine/src/types.ts`). Every POI has `id`, `name` and `segments`.
- `segments: string[] | null` lists the segment ids that use the POI. `null` means the default for each segment's kind (`isEligible` in `engine/src/poi/pois.ts`): segments of kind `user` (or with no kind, as saved before M5) use every POI; segments of kind `buyer` only perceive, so they use text and design POIs, never a web app. The built-in persona of a project without an audience uses every POI.
- `WebPoi.mode` is `full` or `observe_only`. Only the field exists so far; enforcing observe-only (no form submission, rate limit, robots.txt) belongs to the competitor piece. Logins are recorded on, and a recorded session's start page applies to, the first web POI in full mode (`loginPoi`).
- `TextPoi.asset` and `DesignPoi.frames[].asset` are asset ids (below).
- Step and friction payloads may carry `frame` (index into `DesignPoi.frames`) and `passage` (`{ start, end, text? }` character offsets, end exclusive). A friction's passage carries `text`, the quoted span as the engine verified it; a text step's passage is the part it read, without `text`. The report carries them into `ReportFriction` and `ReportEvidence`, and the Markdown and HTML exports and the report view print them, with the quote when there is one.
- `Segment.kind` is `user` (or absent) or `buyer`; the audience editor sets it with a Users / Buyers control on each segment.
- Projects, run snapshots and `run.started` events saved with one `poi` read as `pois: [poi]` with `mode: 'full'` and `segments: null` (`withPois`, applied by the SQLite store, `buildReport` and the graph).

## Scheduling

`startRun` (`engine/src/run.ts`) gives each persona `poisFor(project.pois, segment)` and runs them one after another in that order. For each POI it calls the type's runner, then asks the persona's survey about that POI (`persona.survey` with its `poi_id`). Personas of a `buyer` segment answer the buying survey instead (`askBuyer`, `engine/src/agent/buyer.ts`, purpose `buyer_survey`): would they buy or recommend buying, how the price looks (`low`, `fair`, `high`, `unclear`), what would stop them and what was unclear. It is recorded as the same `persona.survey` with `buyer` filled in, its objections as `frictions` and would-buy as `would_continue`, so sentiment by segment and the themes count buyers too. A run-wide stop ends the sequence; any other ending moves on to the next POI. A persona with no POI stops the run before it starts; the host's preflight says so earlier.

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
| `web` | `web.ts` | The existing browsing loop (`agent/loop.ts`), unchanged; budget is the patience budget; preflight is the production guard (`checkTarget`). |
| `text` | `text.ts`, prompt in `text-prompt.ts` | Read and rate: one model call (purpose `read_text`) per part of the text, cut at paragraph breaks into parts of at most 48,000 characters (~12k tokens), so one call for most copy. Each call thinks aloud, rates (the opinion), lists up to five confusions with their quotes and offsets, and on the last part says what the persona would do next (`done`) or gives up (`abandon`). The engine checks each quote against the text read so far, keeps offsets that hold it, repairs others to the quote's nearest occurrence (exact, then ignoring case and white space) and drops the passage of a quote the text does not hold. Budget: one part per 15 steps of patience budget (patience 1 → 1, 5 → 4); a reader out of budget before the end is `budget_exceeded`. Preflight refuses a POI without a `.md` or `.txt` asset; a missing or blank file ends the run with an error. |
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
- `web.ts` and `WebPoiForm.tsx` are today's web fields. `text.ts` + `TextPoiForm.tsx`: paste the text or choose a `.md` or `.txt` file (read in the page, checked for UTF-8 and 2 MB, and sent as `import_asset` `{ text, name }`), then a preview of the saved text with "Replace the text". `design.ts` + `DesignPoiForm.tsx` are placeholders the design piece replaces.

## Report

- Confusions of a text group into themes by the passage they quote (the candidate's element is `passage "…"`), so the ranked themes of a text POI are its confusions, each with the persona's thought as the quote and the passage as evidence.
- `Report.buyers` (`engine/src/report/buyers.ts`): per POI and buyer segment, the surveyed count, mean sentiment, the share who would buy or recommend, price answers, and objections and unclear points grouped by their words. The report view (`BuyerSurvey.tsx`, so also the HTML export) and the Markdown export show it as "Buying survey".
- Scripted runs: `DEMO_NAVIGATOR` answers `read_text` with the part's first line as a sample confusion at its real offsets, and `buyer_survey` with `DEMO_BUYER_SURVEY`.

## Not done here

- Enforcing observe-only and a vision check for designs.
- The usage survey prompt (users, on any POI) and the persona outcome are the web ones: a persona's outcome in the report is across all its POIs (any finished POI counts as done, for a text: read to the end), and sentiment by segment pools the surveys of every POI. The buying survey section is per POI.
- PDF and Word text imports (paste, `.md` and `.txt` only).
