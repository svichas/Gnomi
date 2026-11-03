# Development

How to run Gnomi from source, find your way around the code, and check a change before you open a pull request. [CONTRIBUTING.md](../CONTRIBUTING.md) covers what a change is expected to look like.

## Set up

You need [Node.js 24.15 or newer](https://nodejs.org/) (the version CI uses is in `.nvmrc`). From the repository root:

```sh
git clone https://github.com/svichas/Gnomi.git
cd Gnomi
npm ci
npx playwright-core install chromium
npm run dev
```

`npm run dev` starts the desktop app with watched builds. Add a provider key in **Settings**, or start it with `GNOMI_FAKE_LLM=1 npm run dev` to use scripted personas: they need no key and cost nothing, but produce no real findings.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the desktop app with watched builds. |
| `npm test` | Run the workspace test suites. |
| `npm run typecheck` | Type-check the workspaces. |
| `npm run lint` | Lint with Biome. |
| `npm run build -w @gnomi/app` | Build the desktop app. |
| `npm run dist -w @gnomi/app` | Build an installer for your platform into `app/dist/`, without publishing it. |
| `npm run smoke -w @gnomi/app` | Run the scripted Electron smoke check. Other `smoke:*` scripts cover individual flows. |
| `npm run gym` | Start the [Gym demo app](#the-gym-demo) on `http://localhost:4317`. |
| `npm run gnomi -- <command>` | Run the [command line](cli.md). |
| `npm run acceptance -w @gnomi/simulation -- --m5 --out <new dir>` | Run the text and design acceptance rehearsal without provider calls. |

CI runs lint, typecheck, tests and the app build on every pull request. It does not run the smoke checks, which open real windows and write screenshots to `app/test-results/`, so say in your pull request which ones you ran. Live acceptance runs are opt-in and need provider credentials and an explicit spending allowance.

## The Gym demo

The Gym is a small applicant-tracking app with deliberately seeded UX defects, so you can try a full run against something local. Start it and leave it running:

```sh
npm run gym
```

In a second terminal, send six scripted personas through it:

```sh
npm run gnomi -- audience create --out ./gym-audience.json \
  --name Gym --product "An applicant tracking system." --goal "Create a job post" \
  --url http://localhost:4317 --count 6 --fake-llm

npm run gnomi -- run --url http://localhost:4317 --allow localhost \
  --audience ./gym-audience.json --fake-llm --project ./demo.gnomi
```

Then read `demo.gnomi/runs/r-0001/report.md`. For a real run, set your provider key (for example `ANTHROPIC_API_KEY`) and leave out `--fake-llm`. `GYM_DEFECTS=none npm run gym` starts a defect-free control. The [Gym guide](../demo/GymSite/README.md) covers its defect catalogue and its design and copy fixtures.

## Repository layout

| Directory | Contents |
| --- | --- |
| [`app/`](../app/) | Electron shell and React UI: projects, audience editor, inputs, live graph, activity and reports. |
| [`engine/`](../engine/) | Host process and CLI: project and audience authoring, Figma import, and the protocol around the simulation. |
| [`simulation/`](../simulation/) | Simulation runtime: Playwright browser actions, provider routing, social rounds, SQLite event storage and reports. |
| [`demo/GymSite/`](../demo/GymSite/) | Demo web app, defect catalogue, design frames and text fixtures. |
| [`docs/`](.) | Product and technical design, input contracts, evaluation guides and roadmap. |
| [`assets/brand/`](../assets/brand/) | Logos, icons, typography and brand assets. |
| [`videos/readme-gif/`](../videos/readme-gif/) | The README animation, rendered with `node videos/readme-gif/render.mjs`. |

## Architecture

The desktop shell runs the engine in a separate process. The engine drives browser contexts and model calls, and records events in SQLite and evidence in local files. The graph, activity views, persona inspector and reports are all built from that history. The UI uses React and Sigma.js, and model access goes through the Vercel AI SDK. [Technical design](tech.md) has the full picture, including the containment rules every change must keep.

## Releases

See [Releasing](releasing.md).
