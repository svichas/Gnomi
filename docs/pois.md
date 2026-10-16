# Points of interest: the registry contract

How a project holds several points of interest (POIs) and how a new POI type plugs in. This is the M5 foundation of [tech.md §7](tech.md#7-poi-ingestion-and-interaction); the text, static-design, competitor and Figma pieces each add or replace files listed here rather than editing shared ones.

## Data

- `ProjectConfig.pois: Poi[]`, in the order personas use them. `Poi = WebPoi | TextPoi | DesignPoi` (`engine/src/types.ts`). Every POI has `id`, `name` and `segments`.
- `segments: string[] | null` lists the segment ids that use the POI. `null` means the default for each segment's kind (`isEligible` in `engine/src/poi/pois.ts`): segments of kind `user` (or with no kind, as saved before M5) use every POI; segments of kind `buyer` only perceive, so they use text and design POIs, never a web app. The built-in persona of a project without an audience uses every POI.
- `WebPoi.mode` is `full` or `observe_only`. Only the field exists so far; enforcing observe-only (no form submission, rate limit, robots.txt) belongs to the competitor piece. Logins are recorded on, and a recorded session's start page applies to, the first web POI in full mode (`loginPoi`).
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
  preflight(poi: P, project: ProjectConfig, hasAsset: (id: string) => boolean): string | null; // a sentence that blocks the run, or null
  episode(poi: P, deps: EpisodeDeps): Promise<EpisodeEnd>;  // one persona's episode
}
```

`RUNNERS` in `index.ts` maps each type to its runner; `preflight(project, hasAsset?)` runs every POI's check after "is there a POI" and "does every segment with a share have one". The host calls it before a run with `hasAsset` checking the project's `assets/` folder; the CLI calls it without (its project is one web app), and then a missing asset only surfaces when the run reads it.

| Type | File | Today |
| --- | --- | --- |
| `web` | `web.ts` | The existing browsing loop (`agent/loop.ts`), unchanged; budget is the patience budget; preflight is the production guard (`checkTarget`). |
| `text` | `text.ts` | Stub: preflight refuses with "not available yet". Replace this file. |
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

## Static design: `engine/src/poi/design.ts`

- **One step per frame, in order.** Each call (`purpose: 'design'`, the navigator role) shows the current frame and, after the first, the frame before it with what the persona said there. The answer (`designSchema` in `design-prompt.ts`) says whether this frame `matched` the persona's expectation (null on the first), what it `sees`, what it `would_do`, what it `expects_next`, `continue` or `abandon`, a `friction`, an `opinion`, a `thought` and a `feeling`.
- **A mismatch is a friction on the frame where the expectation failed:** `persona.friction_reported` with `frame`, `where.url` `asset:<id>`, and the model's friction, or, when it said `matched: false` without one, what it saw against what it said it expected. The step's thought is the quote.
- **Endings.** `abandon` ends with `persona.abandoned`; the last frame ends with `persona.goal_done` ("Looked through all N screens"); a sequence longer than the patience budget ends with `signal.budget_exceeded`. Two invalid answers are a failed step (`invalid_output`), as on the web; the next frame then has no expectation to compare with.
- **Steps.** `action` is `read` (`done` or `abandon` at the end), `target` is `{ role: 'frame', name: <step name or "Screen N"> }`, `frame` is the index, and `screenshot` is the frame's asset path `assets/<id>`, so the report view, the HTML export (main's thumbnails) and the inspector show the frame as the evidence image without code of their own (a WebP frame may be left out of the HTML export: main's thumbnails use `nativeImage`, which only promises PNG and JPEG). The report view and the Markdown export print the frame number on frictions and evidence.
- **Vision cost.** Only the current and previous frame are sent. A PNG frame is downscaled to at most 1,024 px on its long side (`frames.ts`, a small PNG decoder and encoder on `node:zlib`), once per asset id and shared by every persona. JPEG and WebP frames, and PNGs the decoder does not read (interlaced, under 8 bits per channel), are sent at their own size. The design runner always sends frames, whatever the screenshots setting.
- **Preflight.** Refused: no frames; a frame whose asset is not in `assets/`; a DeepSeek navigator (text only); the local OpenAI-compatible endpoint, because Gnomi cannot tell whether its model reads images. Anthropic, OpenAI and Google navigators run.
- **Scripted.** `DEMO_DESIGNER` in `llm/scripted.ts` (also through `DEMO_NAVIGATOR` for `purpose: 'design'`) passes every frame and logs a labelled sample mismatch on the second. `poi/design.test.ts` runs Gym v3's checkout frames with a scripted shopper that reads each frame through a lookup of its HTML: D26 gives one mismatch on frame 4, the control none.
- **App.** `DesignPoiForm.tsx` adds frames with a file picker or by dropping files (`window.gnomi.pathForFile`, then `import_asset { path }`), shows thumbnails through `get_blob`, and edits an optional step name, the order and removal per frame. A design with no frames does not save.

## Assets: `engine/src/assets.ts`

- Files live in the project's `assets/` folder under a content id: 16 hex characters of the SHA-256 and the extension, for example `3f9a…c2.md`. Ids are always safe file names; `assetPath` refuses anything else.
- Types: `.md` and `.txt` (UTF-8, at most 2 MB), `.png`, `.jpg`/`.jpeg` and `.webp` (checked by file signature, at most 20 MB). Nothing is fetched from the network; PDF and Word are out of scope for now.
- Host protocol: `import_asset` with `{ path }` (a local file the user chose) or `{ text, name? }` (pasted text) returns `{ id, name, mime, bytes }`. `get_blob` with `assets/<id>` returns the file, for previews.

## App registry: `app/src/renderer/src/poi/`

- `index.ts` holds `POI_KINDS`: per type a `PoiKind` with `label`, `blank(id)`, `draft(poi)`, `toPoi(draft)` (the POI or a sentence saying what is missing) and `title(draft)`. Drafts are what the Project screen edits; `form.ts` turns them into `ProjectConfig.pois`.
- `PoiList.tsx` is the ordered list (add, rename, reorder, remove, choose segments) and maps each type to its form component, which gets `PoiFormProps`: `{ draft, onChange, sessions }`.
- `web.ts` and `WebPoiForm.tsx` are today's web fields; `design.ts` and `DesignPoiForm.tsx` the design's frames (above). `text.ts` + `TextPoiForm.tsx` are placeholders the text piece replaces.
- Files on disk reach `import_asset { path }` through the preload's `window.gnomi.pathForFile(file)` (Electron's `webUtils.getPathForFile`), for files from an `<input type="file">` or a drop.

## Not done here

- Enforcing observe-only, the buyer survey, and a segment-kind control in the audience editor (segments have `kind`, but nothing in the app sets it yet).
- The survey prompt and the persona outcome are the web ones: a persona's outcome in the report is across all its POIs (any finished POI counts as done), and sentiment by segment pools the surveys of every POI.
