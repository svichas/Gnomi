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
  <a href="#install">Install</a> ·
  <a href="https://youtu.be/qgSt7nscow4">Watch the intro (1:27)</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

**Gnomi is an open-source desktop app for social simulation and product research.** Give it an idea, a staging app or a Figma design. It builds an audience of simulated people who explore your product, talk about it with each other, and leave behind evidence of where they got stuck.

It is for product teams, designers, founders and engineers who want to know what to test next, before they recruit real participants.

> [!IMPORTANT]
> Findings come from simulated users. Treat them as hypotheses, and validate important decisions with real people. [Interpreting simulations](docs/interpreting-simulations.md) explains what a run does and does not tell you.

## Install

Download the installer for macOS, Windows or Linux from the [latest release](https://github.com/svichas/Gnomi/releases/latest), open **Settings**, and add a provider key.

<details>
<summary>The installers are not code-signed yet, so your operating system warns you the first time.</summary>

- **macOS:** if Gnomi is blocked, open **System Settings → Privacy & Security** and choose **Open Anyway**.
- **Windows:** in the SmartScreen dialog, choose **More info → Run anyway**.
- **Linux:** make the AppImage executable with `chmod +x Gnomi-*.AppImage`.

</details>

### Run from source

You need [Node.js 24.15 or newer](https://nodejs.org/).

```sh
git clone https://github.com/svichas/Gnomi.git
cd Gnomi
npm ci
npx playwright-core install chromium
npm run dev
```

No API key yet? Start it with `GNOMI_FAKE_LLM=1 npm run dev` for scripted personas that cost nothing. [Development](docs/development.md) covers the rest, including a local demo app with seeded UX defects to run against.

## What you can test

| Input | What Gnomi does with it |
| --- | --- |
| **An idea or product copy** | Reads pasted text, Markdown or a text file, and explores comprehension, objections, pricing and buying intent. |
| **Your staging app** | Opens a web URL with the hosts you allow and an optional recorded login. Personas navigate, click and type to reach a goal. |
| **Design images** | Shows an ordered sequence of PNG, JPEG or WebP frames. Personas say what they see, what they would do, and what they expect next. |
| **Your Figma design** | Imports selected frames as images through the Figma API. Frame names become step names. |
| **A competitor's website** | Browses in observe-only mode for comparison. Write requests are blocked and robots rules are respected. |

See [Points of interest](docs/pois.md) for formats and limits.

## How it works

1. **Describe the product and the goal.** Add the material you want feedback on and say what people should try to do.
2. **Define your audience.** Choose segments, roles, countries, languages, devices and profile attributes. Gnomi builds individual personas with their own goals and perspectives.
3. **Let them explore.** Each persona works through the inputs while Gnomi records actions, thoughts, expectations, screenshots and frictions.
4. **Watch the conversation.** Personas post, reply and react in social rounds. You can see who heard an opinion, who repeated it, and who changed their view.
5. **Review the evidence.** Read ranked friction themes with affected segments, quotes, screenshots and suggested changes, and export them as HTML, PDF, Markdown or JSON.

Everything is saved in a project folder on your machine.

## Model providers

Bring your own key for **Anthropic**, **OpenAI**, **Google** or **DeepSeek**, or point a project at a **local OpenAI-compatible server** such as Ollama or LM Studio. Add and test providers in **Settings**, then pick the models each project uses. Design inputs need an image-capable model.

## Command line and AI agents

Everything the app runs is also available from the terminal:

```sh
npm run gnomi -- run --url https://staging.example.com --audience ./audience.json --project ./my-project
```

Coding agents such as Claude Code, Codex and Cursor can drive it for you through [the Gnomi skill](.claude/skills/gnomi/SKILL.md). See [Command line](docs/cli.md) for every command.

## Privacy and safety

- **Local first.** Projects, run history and evidence stay on your machine. Model inputs go only to the provider you configure, and web runs only reach the hosts you allow.
- **Keys stay out of projects.** Provider keys and Figma tokens are encrypted with your operating system's secure storage. Recorded logins are encrypted separately and never shown to the model.
- **Contained browsers.** Runs are meant for staging or test environments. Production hosts are refused, CAPTCHAs and bot protection are never bypassed, and competitor sites are observe-only.
- **Budgets.** A cost budget stops new work at the threshold, but requests already in flight may still be billed by your provider.

[Technical design](docs/tech.md) explains each safeguard. Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Documentation

- [Interpreting simulations](docs/interpreting-simulations.md): what a run does and does not tell you
- [Points of interest](docs/pois.md): web, text, design, competitor and Figma inputs
- [Command line](docs/cli.md): every CLI command, and running Gnomi from AI agents
- [Development](docs/development.md): run from source, test, and find your way around the code
- [Releasing](docs/releasing.md): cut a release and sign installers
- [All docs](docs/README.md), including the technical design and behavioural model

## Contributing

Bug reports, ideas and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and open an issue before starting anything large. This project follows a [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Gnomi is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). You can use, study, modify and share it. If you distribute a modified version, or let others use one over a network, you must make its complete source available under the same license.

For a commercial license without these obligations, contact the maintainer through [GitHub](https://github.com/svichas).
