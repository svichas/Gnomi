<p align="center">
  <a href="https://github.com/svichas/Gnomi#gh-dark-mode-only">
    <img src="assets/brand/gnomi-logo-light.svg#gh-dark-mode-only" alt="Gnomi" width="260">
  </a>
  <a href="https://github.com/svichas/Gnomi#gh-light-mode-only">
    <img src="assets/brand/gnomi-logo.svg#gh-light-mode-only" alt="Gnomi" width="260">
  </a>
</p>

<p align="center"><strong>Perspective before you ship.</strong></p>

<p align="center">
  <a href="https://github.com/svichas/Gnomi/actions/workflows/ci.yml"><img src="https://github.com/svichas/Gnomi/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/svichas/Gnomi/releases/latest"><img src="https://img.shields.io/github/v/release/svichas/Gnomi" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>
</p>

<p align="center">
  <a href="https://youtu.be/qgSt7nscow4">
    <img src="videos/readme-gif/gnomi-social-simulation.gif" alt="Five simulated personas explore a pricing page, think, talk, and influence each other until Gnomi surfaces a finding. Click to watch the 1 minute 27 second introduction on YouTube." width="100%">
  </a>
</p>

<p align="center">
  <a href="https://youtu.be/qgSt7nscow4">Watch the introduction on YouTube · 1:27</a>
</p>

**Gnomi is an open-source desktop app for social simulation and product research.** Give it an idea, a staging app or a Figma design. It builds an audience of simulated people who explore your product, talk about it with each other, and leave behind evidence of where they got stuck.

It is for product teams, designers, founders and engineers who want to know what to test next, before they recruit real participants.

> [!IMPORTANT]
> Findings come from simulated users. Treat them as hypotheses, and validate important decisions with real people. [Interpreting simulations](docs/interpreting-simulations.md) explains what a run does and does not tell you.

[Quick start](#quick-start) · [How it works](#how-it-works) · [Providers](#model-providers) · [Command line](#command-line) · [Privacy](#privacy-and-safety) · [Development](#development) · [Docs](#documentation) · [Contributing](#contributing)

## Quick start

### Download the app

Get the installer for macOS, Windows or Linux from the [latest release](https://github.com/svichas/Gnomi/releases/latest), open **Settings**, and add a provider key.

The installers are not code-signed yet, so your operating system will warn you the first time:

- **macOS:** if Gnomi is blocked, open **System Settings → Privacy & Security** and choose **Open Anyway**.
- **Windows:** in the SmartScreen dialog, choose **More info → Run anyway**.
- **Linux:** make the AppImage executable with `chmod +x Gnomi-*.AppImage`.

### Or try it from source, with no API key

You need [Node.js 24.15 or newer](https://nodejs.org/). Clone the repository and start the bundled **Gym** demo, a small applicant-tracking app with deliberately seeded UX defects:

```sh
git clone https://github.com/svichas/Gnomi.git
cd Gnomi
npm ci
npx playwright-core install chromium
npm run gym
```

Leave it running. In a second terminal, send six scripted personas through it:

```sh
npm run gnomi -- audience create --out ./gym-audience.json \
  --name Gym --product "An applicant tracking system." --goal "Create a job post" \
  --url http://localhost:4317 --count 6 --fake-llm

npm run gnomi -- run --url http://localhost:4317 --allow localhost \
  --audience ./gym-audience.json --fake-llm --project ./demo.gnomi
```

Then read `demo.gnomi/runs/r-0001/report.md`. `--fake-llm` uses scripted answers. They show the workflow working but produce no real findings, and they cost nothing. To open the desktop app from source, run `npm run dev`.

For a real run, set your provider key (for example `ANTHROPIC_API_KEY`) and leave out `--fake-llm`. The [Gym guide](demo/GymSite/README.md) covers its design and copy fixtures, and `GYM_DEFECTS=none npm run gym` starts a defect-free control.

## What you can test

A project contains one or more **points of interest**: the material each persona explores, in the order you choose.

| Input | What Gnomi does with it |
| --- | --- |
| **An idea or product copy** | Reads pasted text, Markdown or a text file, and explores comprehension, objections, pricing and buying intent. |
| **Your staging app** | Opens a web URL with the hosts you allow and an optional recorded login. Personas navigate, click and type to reach a goal. |
| **Design images** | Shows an ordered sequence of PNG, JPEG or WebP frames. Personas say what they see, what they would do, and what they expect next. |
| **Your Figma design** | Imports selected frames as images through the Figma API with your personal access token. Frame names become step names. |
| **A competitor's website** | Browses in observe-only mode for comparison. Write requests are blocked and robots rules are respected. |

Design inputs are reviewed as static frames. Importing Figma prototype interactions is planned. See the [input guide](docs/pois.md) for formats and limits.

## How it works

1. **Describe the product and the goal.** Add the material you want feedback on and say what people should try to do.
2. **Define your audience.** Choose segments, roles, countries, languages, devices and profile attributes. Gnomi builds individual personas with their own goals and perspectives.
3. **Let them explore.** Each persona works through the inputs while Gnomi records web actions, thoughts, expectations, screenshots and frictions.
4. **Watch the conversation.** Personas post, reply and react in social rounds. You can see who heard an opinion, who repeated it, and who changed their view.
5. **Review the evidence.** Read ranked friction themes with affected segments, quotes, screenshots or text passages, and suggested changes.

You get an audience you can inspect and edit, a live social graph and activity feed, findings with evidence links and trust levels, and reports in HTML, PDF, Markdown and JSON. You also control model routing, concurrency, step limits, social rounds and cost budgets. Everything is saved in a project folder on your machine.

## Model providers

Add and test providers in **Settings**, then pick the models each project uses.

| Provider | Configuration |
| --- | --- |
| Anthropic | API key |
| OpenAI | API key |
| Google | API key |
| DeepSeek | API key. V4.1-Flash navigates with screenshots. |
| Local OpenAI-compatible server | A per-project endpoint, such as Ollama or LM Studio |

Design inputs need an image-capable navigator, which is currently an Anthropic, OpenAI or Google model. For Figma imports, add a personal access token under **Settings → Figma**.

Browser runs need Chromium, Google Chrome or Microsoft Edge. When running from source, `npx playwright-core install chromium` installs the version this checkout uses.

## Command line

Everything the app runs is also available from the terminal:

```sh
npm run gnomi -- <command> [options]
```

Run `npm run gnomi` with no command for every option.

| Command | Purpose |
| --- | --- |
| `audience create` | Write an audience and its personas to a file. `--propose` asks the model for segments. |
| `audience update` | Write personas again after editing the file's segments or count. |
| `audience analytics` | Set segment, device, country and language shares from an analytics CSV. No model calls. |
| `audience sources` | Condense interview notes or support tickets into a segment's goals, vocabulary and objections. |
| `personas` | List an audience's personas, or show one with `--id`. |
| `estimate` | Estimate cost and time before a run. |
| `run` | Run the audience against `--url` or a `--pois` file and write the report into `--project`. |
| `runs` | List a project's runs. |
| `report` | Rebuild a run's report as a summary, Markdown or JSON. |
| `rerun` | Run a finished run again on its frozen settings and personas, optionally at a new address or with `--returning` personas. |
| `rejudge` | Regroup and rename an ended run's themes with the current judge, without browsing. |
| `compare` | Show what changed between two runs or repeat sets. No model calls. |
| `gate` | For CI: exit non-zero on a new high-severity theme across two repeat sets. No model calls. See [CI gate](docs/ci-gate.md). |
| `study` | Plan a study with real people from a run's top findings and write `study-plan.md`. |
| `outcome` | Record what your own study found about a finding. No model calls. |
| `edit` | Hide or reword a finding in the shared copy of a report. No model calls. |

Provider keys come from the environment: `ANTHROPIC_API_KEY` for the default routing, or `OPENAI_API_KEY`, `GOOGLE_API_KEY` or `DEEPSEEK_API_KEY` when `--settings` routes to them. `--pois <file.json>` replaces `--url` for text, design or several inputs. With `--json`, every command prints one JSON object per line and ends with its result. Recording logins and exporting HTML or PDF reports are only available in the desktop app.

### With AI coding agents

Coding agents can run Gnomi for you. Open one in this repository and ask in plain language:

> Test the pricing copy in `copy/pricing.md` with 20 simulated small-business owners and tell me the top frictions. Keep it under $3.

**Claude Code** loads [the Gnomi skill](.claude/skills/gnomi/SKILL.md) automatically, or invoke it with `/gnomi`. **Codex, Cursor** and other agents that read [AGENTS.md](AGENTS.md) are pointed to the same skill. The skill estimates before running, asks before going over your budget, and presents findings as hypotheses. Set your provider key in the shell the agent uses.

## Privacy and safety

- **Local first.** Projects, run history and evidence stay on your machine. Model inputs go only to the provider you configure, web runs only reach the hosts you allow, and Figma imports only contact Figma. Settings lists every place Gnomi connects to.
- **Keys stay out of projects.** Provider keys and Figma tokens are encrypted with your operating system's secure storage. Without secure storage, they last only for the current app session. Recorded logins are encrypted separately and never shown to the model.
- **Contained browsers.** Interactive runs are meant for staging or test environments. Production hosts are refused, CAPTCHAs and bot protection are never bypassed, and competitor sites are observe-only.
- **Budgets.** A cost budget stops new work at the threshold, but requests already in flight may still be billed by your provider.

[docs/tech.md](docs/tech.md) explains each safeguard. Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Electron app with watched builds. |
| `npm run gym` | Start the Gym demo app. |
| `npm test` | Run the workspace test suites. |
| `npm run typecheck` | Type-check the workspaces. |
| `npm run lint` | Lint with Biome. |
| `npm run build -w @gnomi/app` | Build the desktop app. |
| `npm run smoke -w @gnomi/app` | Run the scripted Electron smoke check. Other `smoke:*` scripts cover individual flows. |
| `npm run acceptance -w @gnomi/simulation -- --m5 --out <new dir>` | Run the text and design acceptance rehearsal without provider calls. |

CI runs lint, typecheck, tests and the app build on every pull request. Live acceptance runs are opt-in and need provider credentials and an explicit spending allowance.

| Directory | Contents |
| --- | --- |
| [`app/`](app/) | Electron shell and React UI: projects, audience editor, inputs, live graph, activity and reports. |
| [`engine/`](engine/) | Host process and CLI: project and audience authoring, Figma import, and the protocol around the simulation. |
| [`simulation/`](simulation/) | Simulation runtime: Playwright browser actions, provider routing, social rounds, SQLite event storage and reports. |
| [`demo/GymSite/`](demo/GymSite/) | Demo web app, defect catalogue, design frames and text fixtures. |
| [`docs/`](docs/) | Product and technical design, input contracts, evaluation guides and roadmap. |
| [`assets/brand/`](assets/brand/) | Logos, icons, typography and brand assets. |
| [`videos/readme-gif/`](videos/readme-gif/) | The animation above, rendered with `node videos/readme-gif/render.mjs`. |

The desktop shell runs the engine in a separate process. The engine drives browser contexts and model calls, and records events in SQLite and evidence in local files. The graph, activity views, persona inspector and reports are all built from that history. The UI uses React and Sigma.js, and model access goes through the Vercel AI SDK.

## Documentation

| Guide | Covers |
| --- | --- |
| [Interpreting simulations](docs/interpreting-simulations.md) | What a run's outputs do and do not tell you. |
| [Points of interest](docs/pois.md) | Web, text, design, competitor and Figma inputs. |
| [Persona generation](docs/persona-generation.md) | Audience generation, saved profiles, retries and diagnostics. |
| [CI gate](docs/ci-gate.md) | What `gnomi gate` decides, with a GitHub Actions example. |
| [Product idea](docs/idea.md) | The problem, intended users and simulation design. |
| [Technical design](docs/tech.md) | Architecture, data flow, containment and model integration. |
| [Behavioural model (ODD)](docs/odd.md) | The simulation model described in the ODD protocol. |
| [Roadmap](docs/roadmap.md) · [Features roadmap](docs/features_roadmap.md) | Milestones, measured progress and what comes next. |
| Acceptance: [audience](docs/m2-acceptance.md) · [friction](docs/m3-acceptance.md) · [social](docs/m4-acceptance.md) · [text/design](docs/m5-acceptance.md) | What has been measured, and what still needs review. |
| [Brand guide](docs/brand.md) | Visual identity and writing principles. |

Gnomi is under active development. Some design documents describe intended or future work. The input and acceptance guides record current limits and validation status.

## Contributing

Bug reports, ideas and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and open an issue before starting anything large. This project follows a [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Gnomi is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). You can use, study, modify and share it. If you distribute a modified version, or let others use one over a network, you must make its complete source available under the same license.

For a commercial license without these obligations, contact the maintainer through [GitHub](https://github.com/svichas).
