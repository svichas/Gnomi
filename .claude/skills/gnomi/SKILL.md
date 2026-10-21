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
   Check on it by reading the last lines of the log. It is done when the last line has `"kind":"run"`, or when the process has exited with an error on stderr.
5. **Read the result.** The `run` line carries a `summary`: completion, friction rate, each POI's top five themes, sentiment by segment, cost. Read `report_md` only for the detail behind a theme (quotes, evidence, suggested changes). Screenshot paths are in `report_json` if you need to look at what a persona saw.

## Points of interest

`--pois` is a JSON array, used in that order. Ids default to `poi-1`, `poi-2`…, and `segments: null` means every segment that would use that kind of input.

```json
[
  { "type": "web", "start_url": "http://localhost:4317", "allowed_hosts": ["localhost"] },
  { "type": "text", "path": "copy/pricing.md", "name": "Pricing copy" },
  { "type": "design", "name": "Checkout", "frames": [{ "path": "designs/1.png", "name": "Cart" }, { "path": "designs/2.png", "name": "Pay" }] }
]
```

- **web**: a staging or local app only, never production. Personas click and type in a real browser, so they create real data there. Requests to hosts other than the start page's and `allowed_hosts` are blocked. Gnomi refuses only the hosts in `production_domains`, so list the product's production domain there (e.g. `["acme.com"]`). Add `"mode": "observe_only"` for a competitor's site, browsed without writes.
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

## Earlier runs

- `runs <project dir> --json` lists runs, newest first.
- `report <project dir> [--run r-0002] --format summary|md|json` rebuilds a run's report; `summary` is the default and the same object a run returns.

## Settings and keys

- Keys come from the environment: `ANTHROPIC_API_KEY` for the default routing, or `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY` when `--settings` routes to them. If a key is missing the command says which variable to set; ask the user, never guess or print a key.
- `--settings settings.json` lays an object over the defaults, e.g. `{ "rounds": 3, "cost_budget_usd": 2, "concurrency": 6 }` or a different `routing`.
- `--fake-llm` uses scripted answers and calls no model. It is for checking the workflow only: its findings are fixtures, never report them as results.

## Reporting back

Findings come from simulated users. Present them as hypotheses to check with real people, with how many personas met each one (`personas`, `share`, `evidence`), not as facts about users. Keep the report's banner in mind and say what the run did not cover (inputs, segments, logged-out only).
