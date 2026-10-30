# CI gate

`gnomi gate` tells a CI job whether a build's simulated runs show a new high-severity theme. It reads saved runs and calls no model, so the gate itself is free. The runs it reads cost what any run costs, and a person decides to start them.

```bash
npm run -s gnomi -- gate <project dir> --base <run id> --run <run id> [--json]
```

Each id stands for its whole repeat set, so any run of a set gives the same answer. Each side needs at least three finished runs of one set, because the [regression plan](roadmap.md#evaluation-plan) is a rolling window over three runs, not a single run. A set's trait-free run is in no count.

## What it decides

| Exit code | `decision` | When |
| --- | --- | --- |
| 0 | `passed` | No theme fails, and the two sides are like for like. |
| 1 | `failed` | A theme with status `new` is high severity in at least two later runs, and those runs share more than one key. |
| 2 | `could_not_decide` | A side has too few finished runs, a set was cut short, nobody got a valid model answer in a run, or the sides differ in model, personas or POIs. So does anything else that stops the gate, such as an unknown run id or a bad flag. |

High severity is the rule the priority labels use (`isSevere` in [report/themes.ts](../simulation/src/report/themes.ts)): a severity that rounds to 3 or more of 4. A theme's severity is a median, so 2.5 counts. Each later run's theme is judged on its own severity, so the verdict does not depend on which run came first.

These do not fail, and are printed as warnings:

- a new theme that was high severity in only one later run
- a new theme whose second sighting rests on one shared key, as personas meet unrelated problems at the same button
- a high-severity theme tied to an earlier theme by one shared key, which may be a new problem

A theme that reads `not_retested` does not fail or warn. An objection counts like any other theme, since a comparison does not tell them apart.

**A pass claims very little.** It prints "No new high-severity theme in these simulated runs. This does not show that people will not hit one." The personas may not have tried the failing path, and a theme below high severity passes silently. A failure is a hypothesis to check, not evidence about real users ([interpreting-simulations.md](interpreting-simulations.md)).

With `--json` the last line has `decision`, `base` and `run` (the run ids compared), `failing` and `warnings` (comparison rows, a new row with its `sightings`) and `reasons`. On `could_not_decide`, `failing` lists what would have failed, so a reader can still see it.

## GitHub Actions

This job tests a new address against a saved base set. A person starts it, as it spends money, and it never runs on a push. It fails on exit 1 and on exit 2, so "could not decide" never reads as green.

First make the base set on the build you trust, with `gnomi run ... --project project --repeats 3`, and save the `project` folder under the cache key below. The job throws its own runs away, so every job compares with that same base.

```yaml
name: Gnomi gate
on:
  workflow_dispatch:
    inputs:
      url:
        description: Address of the build to test, such as a PR preview
        required: true
      base:
        description: A run of the base set
        required: true

jobs:
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      PROJECT: ${{ github.workspace }}/project
      BASE: ${{ inputs.base }}
      URL: ${{ inputs.url }}
    steps:
      - uses: actions/checkout@v5
        with:
          repository: svichas/Gnomi
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
        env:
          ELECTRON_SKIP_BINARY_DOWNLOAD: '1'
      - run: npx playwright-core install --with-deps chromium
      - uses: actions/cache/restore@v4
        with:
          path: project
          key: gnomi-project
          fail-on-cache-miss: true
      - run: npm run -s gnomi -- estimate "$PROJECT" --base "$BASE" --repeats 3
      - run: npm run -s gnomi -- rerun "$PROJECT" --base "$BASE" --url "poi-1=$URL" --repeats 3 --json > rerun.log
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      # Naming bash adds pipefail, so tee keeps the gate's exit code.
      - shell: bash
        run: |
          RUN=$(tail -1 rerun.log | jq -r '.run_ids[0]')
          npm run -s gnomi -- gate "$PROJECT" --base "$BASE" --run "$RUN" | tee -a "$GITHUB_STEP_SUMMARY"
```

- `estimate` prints what the runs may cost. `rerun` shares the base set's whole cost budget across the three runs, so that budget caps what the job spends.
- `rerun` keeps the base set's frozen models, personas, goal and seed, so the two sides are like for like unless the provider moved a model alias, which reads as could not decide. Use a dated model id if that gets in the way.
- A project that logs in cannot run here, because recorded logins are only available in the app.
- The commands above were run locally on scripted models. The workflow itself has not run on GitHub, so try it on a throwaway address first.
