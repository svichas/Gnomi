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
- **Analytics.** `audience analytics <audience.json> --file export.csv [--segment <id>] [--dry-run] --json` sets numbers from a CSV export with no model call. The file needs a count column (`users`, `total users`, `active users` or `sessions`) and any of `country`, `language`, `device` or `device category`, and `segment`, whose values must match segment names. With a `segment` column it sets `share`, `mobile_share`, `countries` and `languages` for each segment it names, and a segment it does not name keeps its share. Without one, `--segment` names the segment it describes, and shares stay. The last line has `changes`, `skipped` (values it could not map, which it never guesses) and `stale`, the personas that `audience update` would write again. Use `--dry-run` to read the changes first. The file is not copied: only its name and hash go into the segment's `grounding.sources`.
- **Research notes.** `audience sources <audience.json> --segment <id> --file notes.md [--file tickets.txt] [--budget <usd>] --json` condenses `.md` or `.txt` files into `grounding` on that segment: at most 8 `facts` and 5 `remarks`, the remarks word for word from the text. It is one `persona_writer` call. Ask the user first: emails and phone numbers are removed, but **names and other details are not, and the text goes to their model provider**. A `note` says so before the call. It is refused if it could cost more than `--budget` (default $1), and a failure leaves the file as it was. The last line has `kind: "sources"` with `facts`, `remarks`, `dropped` (remarks not found word for word), `sources`, `cost_usd` and `stale`. The files are not kept, and a new digest replaces the last. Run `audience update` afterwards to write that segment's personas. Advise keeping some interviews back for a study, because data used to write personas cannot also test them. Grounded personas are still fictional, and their findings are still hypotheses.
- A run reuses the file's personas while they are current for the product name, description and goal. Passing a different `--goal`, `--name` or `--product` to `run` writes them again for that run only (a `note` says so) and costs model calls; re-run `audience create` with the new values to keep them.

## Repeat runs

One run is one sample of a noisy model. A repeat set shows which findings come back:

```bash
npm run -s gnomi -- estimate --pois pois.json --audience audiences/acme.json --repeats 3 --also-model deepseek:deepseek-flash --json
npm run -s gnomi -- run --pois pois.json --audience audiences/acme.json --project runs/acme --repeats 3 --also-model deepseek:deepseek-flash --json > runs/acme.log 2>&1
```

- `--repeats n` makes n runs one after another with the same personas and follow graph. `--also-model provider:model` adds one more run with the navigator and socialiser on that model (it must have a price, and its key must be set). The judge and author stay the same for every run. A text-only model such as `deepseek:deepseek-v4-pro` gets no screenshots while the others do, so a `note` says the runs differ in images as well as model; prefer a model that reads images.
- `--also-trait-free` adds one more run of the same personas and seeds with every trait stripped to their segment and no remarks from a digest, on the project's own models. It needs `--audience`, works on `run` and `estimate` only, and takes a share of the budget. The audience file and project stay as they are; the stripped personas exist only in that run's snapshot. It is in no count: `of`, `compared`, `seen_in` and `findings` leave it out, and the `repeats` line names it in `trait_free`. A finding it matched on more than one shared key has `trait_free: true`: say "personas with no traits hit this too, so it may say more about the model than this audience". That removes nothing and changes no rank. With no `--run`, `report`, `rejudge` and `study` pass it over, though it is the newest. It cannot be run again, so `rerun` another run of the set.
- Each run gets `cost_budget_usd` divided by the number of runs (`run_budget_usd` in the `estimate` result), stops when it has spent that, and has its own report and `run` line. `estimate` takes the same flags and gives the total, but the total fitting the budget is not enough: the most expensive run's high estimate, `run_high_usd`, has to fit `run_budget_usd` too. Otherwise that run, usually the `--also-model` one, can stop and leave the set incomplete while the others leave budget unused. Ask the user before such a set, as for a run over budget.
- A run that stops ends the set: no further run starts. So does a stop that lands just after a run ended; that run stays finished.
- The last line has `"kind":"repeats"`: `group`, `of` (runs planned), `compared` (runs that finished), `running` (true while the set is still going, when read from another process), `incomplete` (the set ended with fewer finished than planned), `families`, and `findings`, each with `seen_in`, `of`, its model `families` and its `titles`. A stopped run is not compared.
- `report <project dir> --repeat <group> --json` reads a set again; `--format md` gives a table. `report --run <id> --format md` adds "Appeared in 3 of 3 runs" to each finding of a run in a set. Each run's own files stay as they were written.
- Say "appeared in 2 of 3 runs", and flag a finding only one model family produced. Repeats test robustness inside the simulation: a finding that comes back is still a hypothesis, so never call it confidence, or validated. When `titles` holds different problems, the match was wrong: read those themes before counting them as one.

## Earlier runs

- `runs <project dir> --json` lists runs, newest first, with each run's `repeat` (`group`, `index`, `of`), or null for a lone run. In a set with a trait-free run, `repeat.trait_free` gives that run's index. It only reads the folder, so a run the app is running stays `running`; so does one whose process was killed, until the next `run --project` on that folder or the app opens it.
- `report <project dir> [--run r-0002] --format summary|md|json` rebuilds a run's report; `summary` is the default and the same object a run returns.
- `rejudge <project dir> [--run r-0002] --json` runs an ended run's judge and author again with the current prompts and the run's own judge and author models, without browsing, and rewrites its report files. Use it after the theming rules change; it needs the judge's and author's keys and costs a few model calls (the result line gives `cost_usd`, and `runs` counts it in the run's cost). It spends at most what is left of the run's cost budget; when that is used up it refuses, and `--budget <usd>` sets what this rejudge may spend instead.
- `rejudge … --check` also runs the evidence check between the judge and the author, whatever the run's `finding_check` setting: a model reviews the top friction themes against their evidence and moves those it puts down to a persona's mistake or the test setup into `set_aside`, a section of the report that keeps each one's reason. That is a model's review, so report such a theme as set aside, never as disproved. It adds up to five calls per POI, on `check_model` or else the judge's model. A rejudge without `--check` drops an earlier check on a run whose setting is off, because the check is older than the new judge answer.

## Checking findings with real people

- `study <project dir> [--run r-0002] [--budget <usd>] --json` turns an ended run's top five friction findings into a study plan: neutral tasks, a screener built from the segment descriptions, and what a researcher should watch for. It makes one call on the run's author model and spends under `rejudge`'s rule: at most what is left of the run's cost budget, or `--budget`. The `study` result line gives `plan`, `cost_usd` and `study_plan_md`, a file to hand a researcher without the findings. It refuses a set's trait-free run, which only a named `--run` reaches. It costs money, so run it only when asked.
- The plan leaves out objections, competitors, set-aside and scan-only findings, and says so. Code drops any task or screener entry that repeats four or more consecutive words of a finding and counts them in `dropped` and `screener_dropped`, so a hypothesis can come back with no tasks, which the plan says. Read the tasks before passing them on: a paraphrase can still lead a participant. Never show the hypotheses to participants.
- `outcome <project dir> --run <run id> --theme <theme id> --status supported|contradicted|unresolved --date YYYY-MM-DD [--note "<text>"] --json` records what the team's own study found. Theme ids are in `report --format json`. It makes no model call. The date must be a real day that is not in the future, and a note can be 2,000 characters. Record only what the user tells you a real study found: never infer an outcome from a simulated result. Keep names and contact details out of a note: it stays in the project's log, even after a correction, and appears in reports and exports.
- The latest outcome for a finding wins, so correct one by recording another. A `rejudge` keeps outcomes. One with no finding of its own left, as when two studied findings merge, moves to `unmatched_outcomes` with its title and stays in the report, in the `report` summary too. A theme's outcome is its `validation`, and `study_count` says how the top five stand. An outcome belongs to its run: a repeat set, `rerun` or `compare` does not carry it across.

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
- `--returning` on `rerun` has the personas remember the base run, to see whether a change confuses people who learned the old version. Offer it only when that is the question, because prior knowledge can hide first-use problems. Estimate with `estimate <project dir> --base <run id> --returning`, as each prompt carries more input. It is never on by default: without it a rerun of a returning run remembers nothing. With `--repeats` every run remembers the base run. It refuses a trait-free run and a comparison study, and `run`, or `estimate` with no `--base`, refuses the flag. Memory goes one visit deep. The summary has `returning` with the notice to pass on, and the report's `methods.prior`, or a repeat set's `prior`, names the base run and counts the personas in `fresh`, who had nothing to remember. A theme's `remembered` counts personas who only repeated their earlier complaint, which are not in `first_hand` or `prevalence`: say "2 more reported it after remembering it from an earlier visit". It can still be a real problem that is still there, so never say it went away. A returning run says little about first use, and findings stay hypotheses.
- `compare <project dir> --base <run id> --run <run id> --json` reads two runs and calls no model. A run of a repeat set stands for that set's finished runs, so `seen_in` and `of` compare how often each theme appeared. Prefer sets on both sides: one run is one sample of a noisy model. Without `--json` it prints Markdown.
- Each entry of `themes` has a `status`, `before_title`, `after_title`, `before` and `after` (each `seen_in`, `of`), `severity`, `pages` and `reached`, the most personas who reached all its pages in one later run, or for a theme with no pages who answered a survey on its POI. Read the `notes` first: they say when the two sides differ in model, personas, goal or POIs, when a run stopped early, or when one side's personas remember an earlier run and the other's do not, or remember another one. `gaps` holds the ones that make the sides not like for like, each with a `kind`.
  - `fixed` is the data's word and never yours. **Say "not seen again", with the reach: "was in 3 of 4 runs, not seen in 3 of 3, 6 personas reached its page".** The personas may simply not have tried the failing path, and simulated findings are hypotheses.
  - `not_retested`: the later run did not show it, but fewer than 3 personas reached its pages, or for a theme with no pages answered a survey, so its absence says nothing. Never count it as gone. A theme on a page only the defect created, such as a 404, ends here once fixed.
  - `unchanged` with `weak: true`: the two sides share only one key, or a side's runs were grouped on only one key with `grouped_with`, so they may be different problems. Show every title and say so.
  - `unchanged` with `set_aside`: the evidence check set it aside on that side. That is the check's reading, so it says nothing either way about a change in the product.
  - `new`: only the later side showed it. It can also be an old problem on a page the earlier run never reached. Its `sightings` give each later run's severity, and `weak: true` on one that only one shared key ties to the rest.

## CI gate

For a CI job, or when asked whether a build should pass. It reads saved runs and calls no model, but the runs behind it cost money, so estimate and ask as for any run. [docs/ci-gate.md](../../../docs/ci-gate.md) has a GitHub Actions example.

```bash
npm run -s gnomi -- gate runs/acme --base r-0001 --run r-0004 --json
```

- A run id stands for its whole repeat set, and each side needs at least 3 finished runs of one set, so make both with `--repeats 3`.
- The last line has `kind: "gate"`, `decision`, `base`, `run`, `failing`, `warnings` and `reasons`. The exit code is 0 for `passed`, 1 for `failed` and 2 for `could_not_decide`.
- `failed`: a theme with status `new` was high severity, a severity that rounds to 3 or more of 4, in at least 2 later runs tied to each other by more than one shared key. Its `sightings` list those runs. It is still a hypothesis: never say users hit it.
- `could_not_decide`: read `reasons`, which say which side had too few finished runs, was cut short or had no valid model answers, or how the sides differ in model, personas, goal, POIs or what their personas remember. Any other error is exit 2 as well. This is not a pass, and on it `failing` lists what would have failed.
- `passed`: say what it prints. With no `warnings` that is "No new high-severity theme in these simulated runs. This does not show that people will not hit one." With `warnings` it is "No new high-severity problem clearly came back in at least 2 of these simulated runs. This does not show that people will not hit one." Never say the build is safe or validated. `warnings` holds high-severity themes too thin to fail on: name them.

## Settings and keys

- Keys come from the environment: `ANTHROPIC_API_KEY` for the default routing, or `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY` when `--settings` routes to them. If a key is missing the command says which variable to set; ask the user, never guess or print a key.
- `--settings settings.json` lays an object over the defaults, e.g. `{ "rounds": 3, "cost_budget_usd": 2, "concurrency": 6 }`. A `routing` names only the roles it changes, e.g. `{ "routing": { "navigator": { "provider": "openai", "model": "gpt-6-luna" } } }`; the other roles keep their default model. `{ "finding_check": true }` runs the evidence check in every report, and an optional `check_model`, shaped like a routing entry, gives it another model; it stays off by default until measured. `{ "accessibility_checks": true }` adds an axe-core scan of each page state, Chromium's vision emulation for colour-blind and low-vision personas, and no screenshots for screen-reader personas; it adds no model call, and it too stays off until measured. A theme the scan found alone is `scan_only`, with `personas` and `share` null: report it as found by the scan, never as something a number of personas met.
- `--fake-llm` uses scripted answers and calls no model. It is for checking the workflow only: its findings are fixtures, never report them as results.

## Reporting back

A theme or piece of evidence tagged "possibly interference between personas" (`interference` in `report_json`) rests on a failed action on something another persona had just changed, so one persona may have caused it rather than the product. Say so when you pass it on. Nothing tagged is removed or ranked lower, and the tag cannot tell a shared record from a private draft.

Findings come from simulated users. Present them as hypotheses to check with real people, with how many personas met each one (`personas`, `share`, `evidence`), not as facts about users. Keep the report's banner in mind and say what the run did not cover (inputs, segments, logged-out only). `report_md` opens with a short template summary, and its Fix now, Next and Later labels suggest where to look first within that run: pass one on as that, never as how much a problem matters to real users. The methods' coverage lines say whether the last personas still found new problems and which pages few reached: pass that on as being about this run, never as proof that nothing is left to find. A finding's "more common among" line gives counts within the run, so pass on the counts, never a cause. Keep what a team's study found apart from what personas did, and say whose it is: "Your team's study, 12 Oct 2026: supported". An outcome changes no simulated number, and `study_count` gives counts, so never turn it into a percentage or an accuracy.
