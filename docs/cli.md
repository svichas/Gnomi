# Command line

Everything the desktop app runs is also available from the terminal. From the repository root:

```sh
npm run gnomi -- <command> [options]
```

Run `npm run gnomi` with no command for every option. [Development](development.md#the-gym-demo) has a complete example against the local Gym demo.

## Commands

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
| `gate` | For CI: exit non-zero on a new high-severity theme across two repeat sets. No model calls. See [CI gate](ci-gate.md). |
| `study` | Plan a study with real people from a run's top findings and write `study-plan.md`. |
| `outcome` | Record what your own study found about a finding. No model calls. |
| `edit` | Hide or reword a finding in the shared copy of a report. No model calls. |

## Options worth knowing

- **Provider keys** come from the environment: `ANTHROPIC_API_KEY` for the default routing, or `OPENAI_API_KEY`, `GOOGLE_API_KEY` or `DEEPSEEK_API_KEY` when `--settings` routes to them.
- **`--fake-llm`** uses scripted answers. Runs show the workflow working but produce no real findings, and cost nothing.
- **`--pois <file.json>`** replaces `--url` for text, design or several inputs. See [Points of interest](pois.md).
- **`--json`** prints one JSON object per line, ending with the command's result.

Recording logins and exporting HTML or PDF reports are only available in the desktop app.

## With AI coding agents

Coding agents can run Gnomi for you. Open one in this repository and ask in plain language:

> Test the pricing copy in `copy/pricing.md` with 20 simulated small-business owners and tell me the top frictions. Keep it under $3.

**Claude Code** loads [the Gnomi skill](../.claude/skills/gnomi/SKILL.md) automatically, or invoke it with `/gnomi`. **Codex, Cursor** and other agents that read [AGENTS.md](../AGENTS.md) are pointed to the same skill. The skill estimates before running, asks before going over your budget, and presents findings as hypotheses. Set your provider key in the shell the agent uses.
