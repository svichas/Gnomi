---
name: gnomi
description: Run Gnomi social simulations from the terminal - build an audience of simulated personas, estimate the cost, run them against a staging web app, text or design images, and read the friction report. Use when asked to test a product, page, copy or design with simulated users, to create or edit personas, or to read a Gnomi report.
---

# Gnomi from the CLI

Gnomi simulates people using a product: personas explore it, report friction, talk in social rounds, and a report ranks what they ran into. Everything here runs from the repo root with `npm run -s gnomi -- <command>` (the same as `node engine/src/cli.ts <command>`). Run a command with no arguments to see every option.

Always pass `--json`: every stdout line is then one JSON object, and **the last line is the command's result**. Errors go to stderr with exit code 1.

## Workflow

1. **Describe the inputs** in a points-of-interest file (below), or use `--url` for one web app.
2. **Create the audience** and its personas:
   ```bash
   npm run -s gnomi -- audience create --out audiences/acme.json --name Acme --product "One sentence about the product." --goal "What people should try to do" --pois pois.json --count 20 --propose --json
   ```
   `--propose` asks the model for segments that fit the product; without it there is one "Everyone" segment. Writing personas costs model calls; the result line gives `cost_usd`.
3. **Estimate** before running, and tell the user the cost range:
   ```bash
   npm run -s gnomi -- estimate --pois pois.json --audience audiences/acme.json --json
   ```
   Ask the user before a run whose high estimate is over the budget they gave you; without one, over `budget_usd` in the result (the run's hard cap, $5 by default).
4. **Run** in the background, since runs take minutes and shell calls time out:
   ```bash
   npm run -s gnomi -- run --pois pois.json --audience audiences/acme.json --project runs/acme --json > runs/acme.log 2>&1
   ```
   Check on it by reading the last lines of the log. It is done when the last line has `"kind":"run"` (`"kind":"repeats"` for a [repeat set](#repeat-runs)), or when the process has exited with an error on stderr.
5. **Read the result.** The `run` line carries a `summary`: completion, friction rate, each POI's top five themes, sentiment by segment, cost. A rate is `null`, not 0, when nobody it covers started (for example a segment a stopped run never reached). Read `report_md` only for the detail behind a theme (quotes, evidence, suggested changes). Screenshot paths are in `report_json` if you need to look at what a persona saw.

## Points of interest

`--pois` is a JSON array, used in that order. Ids default to `poi-1`, `poi-2`…, and `segments: null` means every segment that would use that kind of input.

```json
[
  { "type": "web", "start_url": "http://localhost:4317", "allowed_hosts": ["localhost"] },
  { "type": "text", "path": "copy/pricing.md", "name": "Pricing copy" },
  { "type": "design", "name": "Checkout", "frames": [{ "path": "designs/1.png", "name": "Cart" }, { "path": "designs/2.png", "name": "Pay" }] }
]
```

- **web**: a staging or local app only, never production. Personas click and type in a real browser, so they create real data there. Requests to hosts other than the start page's and `allowed_hosts` are blocked. Gnomi refuses only the hosts in `production_domains`, so list the product's production domain there (e.g. `["acme.com"]`). Add `"mode": "observe_only"` for a competitor's site (or a production marketing site), browsed without writes; its pages may load assets and scripts from public third-party hosts, so list only the hosts personas should browse.
- **text**: a `.md` or `.txt` file to read and react to (copy, pricing, an idea).
- **design**: PNG, JPEG or WebP frames shown in order.

Paths are relative to the POI file. Logins cannot be recorded from the CLI: web runs are logged out, and an audience whose segments name a `role` is refused.

## Personas

- `personas <audience.json> --json` lists them: one `persona` line each (id, name, segment, job title, device, country, tech skill, patience, `current`), then a total.
- `personas <audience.json> --id <id> --json` shows one in full: background, goal interpretation, voice, every sampled trait.
- **Editing.** You may edit the file directly:
  - A persona's written fields (`name`, `job_title`, `background`, `context_of_use`, `goal_interpretation`, `voice`) can be changed in place and stay current.
  - Do not edit sampled traits (`tech_skill`, `patience`, `device`, `seed`, `attributes`…): the persona would no longer match its slot and is written again.
  - To change who is in the audience, edit `audience.segments` (each has `id`, `name`, `description`, `share` in percent, the shares summing to 100, `typical_goals`, `mobile_share` 0–1, `patience` and `tech_skill` ranges 1–5, `usage_frequency`, `goal_override`, `kind` "user" or "buyer") or `audience.persona_count`, then run `audience update <audience.json> --json`. Unchanged personas are kept; new or changed slots are written.
- A run reuses the file's personas while they are current for the product name, description and goal. Passing a different `--goal`, `--name` or `--product` to `run` writes them again for that run only (a `note` says so) and costs model calls; re-run `audience create` with the new values to keep them.

## Repeat runs

One run is one sample of a noisy model. A repeat set shows which findings come back:

```bash
npm run -s gnomi -- estimate --pois pois.json --audience audiences/acme.json --repeats 3 --also-model deepseek:deepseek-flash --json
npm run -s gnomi -- run --pois pois.json --audience audiences/acme.json --project runs/acme --repeats 3 --also-model deepseek:deepseek-flash --json > runs/acme.log 2>&1
```

- `--repeats n` makes n runs one after another with the same personas and follow graph. `--also-model provider:model` adds one more run with the navigator and socialiser on that model (it must have a price, and its key must be set). The judge and author stay the same for every run. A text-only model such as `deepseek:deepseek-v4-pro` gets no screenshots while the others do, so a `note` says the runs differ in images as well as model; prefer a model that reads images.
- Each run gets `cost_budget_usd` divided by the number of runs (`run_budget_usd` in the `estimate` result), stops when it has spent that, and has its own report and `run` line. `estimate` takes the same flags and gives the total, but the total fitting the budget is not enough: the most expensive run's high estimate, `run_high_usd`, has to fit `run_budget_usd` too. Otherwise that run, usually the `--also-model` one, can stop and leave the set incomplete while the others leave budget unused. Ask the user before such a set, as for a run over budget.
- A run that stops ends the set: no further run starts. So does a stop that lands just after a run ended; that run stays finished.
- The last line has `"kind":"repeats"`: `group`, `of` (runs planned), `compared` (runs that finished), `running` (true while the set is still going, when read from another process), `incomplete` (the set ended with fewer finished than planned), `families`, and `findings`, each with `seen_in`, `of`, its model `families` and its `titles`. A stopped run is not compared.
- `report <project dir> --repeat <group> --json` reads a set again; `--format md` gives a table. `report --run <id> --format md` adds "Appeared in 3 of 3 runs" to each finding of a run in a set. Each run's own files stay as they were written.
- Say "appeared in 2 of 3 runs", and flag a finding only one model family produced. Repeats test robustness inside the simulation: a finding that comes back is still a hypothesis, so never call it confidence, or validated. When `titles` holds different problems, the match was wrong: read those themes before counting them as one.

## Earlier runs

- `runs <project dir> --json` lists runs, newest first, with each run's `repeat` (`group`, `index`, `of`), or null for a lone run. It only reads the folder, so a run the app is running stays `running`; so does one whose process was killed, until the next `run --project` on that folder or the app opens it.
- `report <project dir> [--run r-0002] --format summary|md|json` rebuilds a run's report; `summary` is the default and the same object a run returns.
- `rejudge <project dir> [--run r-0002] --json` runs an ended run's judge and author again with the current prompts and the run's own judge and author models, without browsing, and rewrites its report files. Use it after the theming rules change; it needs the judge's and author's keys and costs a few model calls (the result line gives `cost_usd`, and `runs` counts it in the run's cost). It spends at most what is left of the run's cost budget; when that is used up it refuses, and `--budget <usd>` sets what this rejudge may spend instead.
- `rejudge … --check` also runs the evidence check between the judge and the author, whatever the run's `finding_check` setting: a model reviews the top friction themes against their evidence and moves those it puts down to a persona's mistake or the test setup into `set_aside`, a section of the report that keeps each one's reason. That is a model's review, so report such a theme as set aside, never as disproved. It adds up to five calls per POI, on `check_model` or else the judge's model. A rejudge without `--check` drops an earlier check on a run whose setting is off, because the check is older than the new judge answer.

## Before and after

To see what a change did, run a finished run again on the new build, then compare the two:

```bash
npm run -s gnomi -- estimate runs/acme --base r-0001 --repeats 3 --json
npm run -s gnomi -- rerun runs/acme --base r-0001 --url poi-1=https://pr-12.staging.acme.io --repeats 3 --json > runs/acme-rerun.log 2>&1
npm run -s gnomi -- compare runs/acme --base r-0001 --run r-0002 --json
```

- `rerun <project dir> --base <run id>` keeps the base run's frozen settings, models, goal, seed and personas under a new run id, whatever the project has become since. It costs what a run costs, so estimate first with `estimate <project dir> --base <run id>`, which prices those frozen settings and personas, and ask the user as for any run. It has `run`'s guards and output: every key checked first, a `note` with the estimate and budget, then `run` lines, and a `repeats` line for `--repeats n`. Each run gets its share of the cost budget. Run it in the background.
- `--url <poi id>=<url>` gives a web POI a new address, such as a PR preview or a restarted Gym. Repeat it per POI. The new host joins that POI's allowed hosts, and production domains are still refused. POI ids are in the report's `pois`. Without it the run repeats the same address, which is how to measure how much a run varies on one build.
- Only a finished run can be run again, a run that logs in needs the app, and it is refused while another run is live in the folder.
- `compare <project dir> --base <run id> --run <run id> --json` reads two runs and calls no model. A run of a repeat set stands for that set's finished runs, so `seen_in` and `of` compare how often each theme appeared. Prefer sets on both sides: one run is one sample of a noisy model. Without `--json` it prints Markdown.
- Each entry of `themes` has a `status`, `before_title`, `after_title`, `before` and `after` (each `seen_in`, `of`), `severity`, `pages` and `reached`, the most personas who reached all its pages in one later run, or for a theme with no pages who answered a survey on its POI. Read the `notes` first: they say when the two sides differ in model, personas or POIs, or when a run stopped early.
  - `fixed` is the data's word and never yours. **Say "not seen again", with the reach: "was in 3 of 4 runs, not seen in 3 of 3, 6 personas reached its page".** The personas may simply not have tried the failing path, and simulated findings are hypotheses.
  - `not_retested`: the later run did not show it, but fewer than 3 personas reached its pages, or for a theme with no pages answered a survey, so its absence says nothing. Never count it as gone. A theme on a page only the defect created, such as a 404, ends here once fixed.
  - `unchanged` with `weak: true`: the two sides share only one key, or a side's runs were grouped on only one key with `grouped_with`, so they may be different problems. Show every title and say so.
  - `unchanged` with `set_aside`: the evidence check set it aside on that side. That is the check's reading, so it says nothing either way about a change in the product.
  - `new`: only the later side showed it. It can also be an old problem on a page the earlier run never reached.

## Settings and keys

- Keys come from the environment: `ANTHROPIC_API_KEY` for the default routing, or `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY` when `--settings` routes to them. If a key is missing the command says which variable to set; ask the user, never guess or print a key.
- `--settings settings.json` lays an object over the defaults, e.g. `{ "rounds": 3, "cost_budget_usd": 2, "concurrency": 6 }`. A `routing` names only the roles it changes, e.g. `{ "routing": { "navigator": { "provider": "openai", "model": "gpt-6-luna" } } }`; the other roles keep their default model. `{ "finding_check": true }` runs the evidence check in every report, and an optional `check_model`, shaped like a routing entry, gives it another model; it stays off by default until measured.
- `--fake-llm` uses scripted answers and calls no model. It is for checking the workflow only: its findings are fixtures, never report them as results.

## Reporting back

Findings come from simulated users. Present them as hypotheses to check with real people, with how many personas met each one (`personas`, `share`, `evidence`), not as facts about users. Keep the report's banner in mind and say what the run did not cover (inputs, segments, logged-out only). `report_md` opens with a short template summary, and its Fix now, Next and Later labels suggest where to look first within that run: pass one on as that, never as how much a problem matters to real users.
