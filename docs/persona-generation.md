# Persona generation

Updated 2026-10-16. The earlier writer generated four full biographies per persona, kept one, and ran six requests at a time. Duplicate names triggered another complete write in a serial pass after the progress counter reached 100%. DeepSeek requests did not specify thinking mode, allowing the provider's high-thinking default. Setup requests had no durable per-call diagnostics.

## Call flow

The persona count accepts 1–200, including when the audience has several segments. Generation allocates exactly that count by segment share, preferring three per active segment when the total allows it and lowering that minimum for smaller runs. One persona goes to the largest segment (the first segment breaks equal-share ties). Personas added by hand remain extra. Reducing the count and clicking Generate personas keeps matching profiles without making new model calls for them.

Traits and candidate selection remain seeded in code. Model calls use the project's `persona_writer` route:

| Stage | Purpose | Calls for 50 new personas | Output |
|---|---|---:|---|
| Optional audience suggestion | `propose_audience` | 1 | 3–6 proposed segments for review |
| Candidate sketches | `write_persona` | 50 | Four candidates, each with a 30–45 word sketch, identity, context, goals, voice and probability |
| Name repair, when needed | `rename_persona` | One per clashed slot | Four names only |
| Selected biography | `expand_persona` | 50 | One 150–200 word biography for the sampled candidate |

The ordinary generation path now makes 100 shorter calls. It avoids writing three discarded full biographies, at the cost of an extra request and repeated input context per persona. The stages overlap: each persona's biography starts as soon as its sketch is in and every earlier slot holds its name, so the first persona is written after about one sketch and one biography instead of after all 50 sketches. Names still settle in slot order, so the same seed gives the same population. Biographies and renames take a free request slot before the next sketch does. A clashed slot is renamed with every name settled so far excluded, so compliant suggestions always give it a fresh name. Noncompliant suggestions can still produce a duplicate, which the existing diversity report flags.

DeepSeek persona writing explicitly disables thinking. Other providers use low effort (or no reasoning where the existing OpenAI model capability check allows it). Other DeepSeek roles explicitly request their configured low/high effort. No models or provider routes are changed. See the [DeepSeek thinking-mode documentation](https://api-docs.deepseek.com/guides/thinking_mode/).

`Settings → Persona generation → Writer concurrency` defaults to 32 (projects saved before 2026-10-16 keep their stored 12) and accepts 1–32 independently of run concurrency. A 429 halves the remaining worker count, down to one; already-started requests finish or use the gateway's existing retries. Local providers can use a lower setting. Each stage has a 120-second deadline covering its queue wait, provider attempts and retry backoff. Output caps are 4,096 tokens for audience suggestions, 3,072 for sketches, 1,024 for biographies on DeepSeek / 2,048 elsewhere, and 256 for names on DeepSeek / 1,024 elsewhere.

## Recovery and diagnostics

SQLite schema v4 adds `persona_draft` and `setup_call`. Successful model stages are cached by persona ID, seed, route/endpoint, purpose, schema and exact prompt inputs. Retrying after failure or app restart reuses matching stages. A completed population replaces the saved population atomically, then clears drafts. Unchanged saved personas continue to require zero calls. Project copies keep the configuration and personas but discard setup history and drafts; full exports keep them with the other history.

Only finished biographies advance the persona counter; the meter counts sketches as well, so it moves from the first sketch, and the panel names the latest people written. The UI reports the furthest stage reached, elapsed time and attempt/failure counts. Audience → Generation details shows the latest setup task that made calls: model, persona, stage, provider latency, limiter queue time, input/output/thinking tokens, failures and reported cost. Each retry is a separate row. Thinking tokens are part of total output tokens; unavailable thinking usage displays as `—`. Failed attempts without provider usage cannot be priced accurately and are marked as incomplete usage. Redacted request/response transcripts are stored alongside the metrics in SQLite.

Generation, population edits and run startup are mutually excluded during setup. App shutdown cancels generation and waits for active workers to settle before closing the database.

## Controlled benchmark

Run `node engine/src/audience/generation.perf.ts 4282295fe72cfc1cb5bd9ffccb138e0288c80da3` from the repository root. It loads the old writer from Git into a temporary sibling module, removes it afterwards, and exercises both writers with 50 fixed trait sets and collision-free scripted answers. Each request has a simulated 20ms overhead plus 1ms per 40 output characters. Baseline biographies contain 200 words; the updated writer uses 40-word sketches and 175-word biographies. No provider or API key is used.

Observed medians of three trials on 2026-10-16:

| Writer | Concurrency | Calls | Input characters | Output characters | Median |
|---|---:|---:|---:|---:|---:|
| Previous | 6 | 50 | 370,156 | 304,680 | 1,619ms |
| Updated, same concurrency | 6 | 100 | 644,275 | 171,203 | 1,192ms |
| Updated default | 12 | 100 | 644,275 | 171,203 | 662ms |

This simulation produced 44% less output text, 74% more input text, and 59% lower elapsed time at the new default. Character counts are not billable token counts. It does not model reasoning, real provider queueing, account rate limits, prompt-cache hits or response quality. Live-provider latency, cost and prose-quality improvements remain unmeasured; use the new diagnostics to assess them. Request-limited accounts or slower local models may benefit less from the extra call per persona.

Regression coverage checks staged calls, deterministic names, resume/invalidation, adaptive concurrency, deadlines, provider request bodies, usage, schema upgrades, project copies and run/setup exclusion. The Electron audience smoke test covers stages, attempts, failure/retry, diagnostics, persisted concurrency and narrow layouts. A temporary inversion of the cache-hit condition was caught by the regression tests and restored.
