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
  preflight(poi: P, project: ProjectConfig): string | null; // a sentence that blocks the run, or null
  episode(poi: P, deps: EpisodeDeps): Promise<EpisodeEnd>;  // one persona's episode
}
```

`RUNNERS` in `index.ts` maps each type to its runner; `preflight(project)` runs every POI's check after "is there a POI" and "does every segment with a share have one". The host calls it before a run and the CLI before its one.

| Type | File | Today |
| --- | --- | --- |
| `web` | `web.ts` | The existing browsing loop (`agent/loop.ts`), unchanged; budget is the patience budget; preflight is the production guard (`checkTarget`). |
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

- Enforcing observe-only, the buyer survey, a vision check for designs, and a segment-kind control in the audience editor (segments have `kind`, but nothing in the app sets it yet).
- The survey prompt and the persona outcome are the web ones: a persona's outcome in the report is across all its POIs (any finished POI counts as done), and sentiment by segment pools the surveys of every POI.
