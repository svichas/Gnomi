# Persona generation

Updated 2026-10-18.

## How simulated users are made

Gnomi creates fictional profiles from audience assumptions supplied or approved by the team. It does not recruit participants, copy actual customers, or establish that the generated population represents real users.

1. **Define the audience.** Enter segments and their shares, or review the model's optional suggestions. Configure traits such as language, device, patience and access needs, along with the product description and task. Defaults and model suggestions are assumptions until checked against research or audience data. An analytics export can replace some of those assumptions with counts: it sets segment shares, phone shares, and each segment's countries and languages, with no model call. Values Gnomi cannot map are skipped and listed, never guessed, and only the file's name and hash are kept.
2. **Sample traits in code.** Gnomi allocates the requested population across segments and samples each profile's enabled traits from configured distributions using saved seeds. Segment shares control allocation; they do not prove that those shares match the market.
3. **Write candidate profiles.** The configured `persona_writer` model receives the product, segment, task and sampled traits, plus the segment's research digest if it has one (see [Grounding a segment in real data](#grounding-a-segment-in-real-data)). It proposes four short fictional candidates with identities, contexts, goal interpretations, voices and selection weights. Those model-generated weights are not measured probabilities of real people existing.
4. **Select and expand.** Seeded code chooses a candidate using those weights, excluding already-used names where possible. A second model call expands only the chosen biography; the sampled traits remain fixed. Name repair handles collisions.
5. **Review before running.** Inspect the profiles and diversity report, then edit, regenerate, add or remove personas. A diversity check detects similarities in generated profiles; it does not validate their behaviour against people.

The resulting profile conditions an agent's actions and generated comments during a run. A seed makes code-level sampling repeatable for the same inputs; fresh model responses may still differ. Reusing saved personas preserves their profiles, but neither that nor a seed guarantees identical behaviour in later runs.

## Grounding a segment in real data

A team can add interview notes or support tickets to a segment, as `.md` or `.txt` files, in the app or with `audience sources`.

1. **Redaction.** Code removes emails and phone numbers, in international and national formats, before any model call. Dates, ids and prices stay. Names and other details are **not** removed, and the redacted text goes to the team's model provider. The app and the CLI say so before the call.
2. **Digest.** One `persona_writer` call reads the redacted text, which is marked as untrusted, and returns at most 8 facts about the segment's goals, vocabulary, objections and tools, and at most 5 remarks. Its most possible cost is shown first, and a call that could cost more than its budget is refused.
3. **Remarks must be real.** A remark is kept only if it is a word-for-word part of the redacted text, ignoring whitespace. The rest are dropped and counted, so a model that makes up a quote cannot put it in a persona's prompt.
4. **What stays.** The digest stays on the segment, with each file's name and hash. The files are not copied into the project. A segment's digest replaces the one before it.

The digest goes to the writer with the instruction that personas stay fictional and must not copy a real person's name, employer, contact details or life story. Adding one rewrites only that segment's personas, and personas of other segments stay current.

Data used to write personas cannot also test them, so keep some interviews back for a study. A report's methods list the source names, so a team can check which were used. Grounded personas look more credible whether or not they are more accurate: they are still fictional, and their findings are still hypotheses.

Generated biographies, quotes, opinions and findings remain synthetic. Use them to formulate questions for real participants, not as participant testimony or evidence of customer needs. See [Interpreting simulations](interpreting-simulations.md) for report terminology and validation.

## Writer implementation history

The earlier writer generated four full biographies per persona, kept one, and ran six requests at a time. Duplicate names triggered another complete write in a serial pass after the progress counter reached 100%. DeepSeek requests did not specify thinking mode, allowing the provider's high-thinking default. Setup requests had no durable per-call diagnostics.

## Call flow

The persona count accepts 1–200, including when the audience has several segments. Generation allocates exactly that count by segment share, preferring three per active segment when the total allows it and lowering that minimum for smaller runs. One persona goes to the largest segment (the first segment breaks equal-share ties). Personas added by hand remain extra. Changing the count requires clicking Generate personas before reviewing or starting a run, including after saving or reopening the project. The count used for the last successful generation is saved with the population; individual edits, additions and removals do not change it. Reducing the count and clicking Generate personas keeps matching profiles without making new model calls for them.

Traits and candidate selection remain seeded in code. Model calls use the project's `persona_writer` route:

| Stage | Purpose | Calls for 50 new personas | Output |
|---|---|---:|---|
| Optional audience suggestion | `propose_audience` | 1 | 3–6 proposed segments for review |
| Candidate sketches | `write_persona` | 50 | Four candidates, each with a 30–45 word sketch, identity, context, goals, voice and probability |
| Name repair, when needed | `rename_persona` | One per clashed slot | Four names only |
| Selected biography | `expand_persona` | 50 | One 150–200 word biography for the sampled candidate |

The ordinary generation path now makes 100 shorter calls. It avoids writing three discarded full biographies, at the cost of an extra request and repeated input context per persona. The stages overlap: each persona's biography starts as soon as its sketch is in and every earlier slot holds its name, so the first persona is written after about one sketch and one biography instead of after all 50 sketches. Names settle in slot order, making selection repeatable for the same seed and candidate responses. Biographies and renames take a free request slot before the next sketch does. A clashed slot is renamed with every name settled so far excluded, so compliant suggestions always give it a fresh name. Noncompliant suggestions can still produce a duplicate, which the existing diversity report flags.

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
