# Contributing to Gnomi

Thanks for your interest. Gnomi is early and changes quickly, so open an issue before starting anything large: it saves you from building something that conflicts with work in progress.

## Set up

You need Node.js 24.15 or newer. From the repository root:

```sh
npm ci
npx playwright-core install chromium
npm run dev
```

[Development](docs/development.md) covers the commands, the Gym demo and the repository layout, and [Releasing](docs/releasing.md) how installers are published. Scripted runs (`GNOMI_FAKE_LLM=1`, or `--fake-llm` on the CLI) need no provider key and cost nothing; use them for everything except live acceptance.

## Before you open a pull request

Run the same checks as CI:

```sh
npm run lint
npm run typecheck
npm test
npm run build -w @gnomi/app
```

If you changed the desktop app, also run the Electron smoke check that covers it, for example `npm run smoke -w @gnomi/app` or `npm run smoke:report -w @gnomi/app`. The scripts open real windows and write screenshots to `app/test-results/`. CI does not run them, so say in the pull request which ones you ran.

## How changes are expected to look

- **Small and focused.** One change per pull request, with tests for new logic. Fix a bug with a test that fails without the fix.
- **Match the surrounding code.** Naming, comment density and idioms follow the file you are in. Comments explain why, not what.
- **Keep the boundaries.** `simulation/` never imports the engine, and `engine/` never imports Electron (both are enforced by tests). The renderer only imports pure modules from the other packages. Cross-package imports must be listed in the package's `exports`.
- **Prompts and reports are contracts.** Prompt text sent to models, emitted events and report output change only on purpose, and the pull request says so. The CLI's text and `--json` output are relied on by [the Gnomi skill](.claude/skills/gnomi/SKILL.md).
- **Findings are hypotheses.** Wording in the app and reports must not present simulated results as facts about real people.
- **Commits** use a short conventional prefix such as `feat(app):`, `fix(simulation):`, `refactor(engine):`, `docs:` or `chore:`, followed by an imperative summary.

## Safety rules that changes must keep

Gnomi drives real browsers with model-chosen actions, so some rules are not negotiable: the model never sees credentials, CAPTCHAs and bot protection are never bypassed, production hosts are refused, simulated browsers only reach hosts the user allowed, and keys stay in the operating system's secure storage. [docs/tech.md](docs/tech.md) explains each one. Report security problems privately as described in [SECURITY.md](SECURITY.md), not in an issue.

## Licensing of contributions

Gnomi is licensed under the [AGPL-3.0](LICENSE), and contributions are accepted under the same license. Gnomi is also offered under a commercial license, so before merging a contribution the maintainer may ask you to agree to a contributor license agreement that allows this.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By taking part, you agree to it.
