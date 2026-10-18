![Gnomi](../../assets/brand/gnomi-logo.svg)

*Social simulation for product teams*

# Perspective before you ship.

Gnomi fills your staging app with **fictional personas based on your audience settings**, with their own languages, devices and access needs. They try to get a job done, hit friction and **talk about it with each other**. You get ranked friction hypotheses with simulation records, and a view of how generated opinions spread.

> **Hypothesis from a simulated run**
>
> **Hiring manager field needs an exact username and offers no suggestions**
>
> Within-run corroboration: generated complaint + validation error
>
> *„Keine Liste, kein Vorschlag – ich tippe einfach einen Namen ein und schaue, ob es klappt.“*
> “No list, no suggestion. I just type a name and see if it works.” Alex, simulated recruiter in Germany · step 8 · screenshot
>
> **Suggested change:** add autocomplete or a user picker to the field.

| 3½ min | 10¢ | 7 of 7 |
|---|---|---|
| for a 4-person friction run, from start to finished report | recorded model cost of that run, on your own provider key | other simulated users reached by one complaint in a social run |

## Feedback in minutes, not weeks

Time from “we have a build” to first findings.

| Method | Time to first findings |
|---|---|
| Moderated usability study | 3 days – 3 weeks |
| Unmoderated remote test | 4 hours – 3 days |
| **Gnomi** | **2–5 min measured** (target: 50 users in under 30 min) |

*Other methods: typical ranges including recruiting, not measurements. Gnomi: measured runs of 4–8 simulated users.*

## See how simulated opinions form

> “Assigning a hiring manager who has no account yet threw away my whole job draft. Has anyone else lost a job post this way?”

A simulated recruiter’s feed contained this complaint. It reached all 7 other simulated users:

| Segment | Saw it | Repeated it | Changed opinion |
|---|---|---|---|
| Recruiters (2 others) | 2 | – | 1 |
| Hiring managers (2) | 2 | 1 | – |
| Admins (2) | 2 | 1 | – |
| Coordinators (1) | 1 | – | – |

*A live run with 8 simulated users; a second had the same reach, 4 repeats and 2 changed opinions. This is not a prediction of human word of mouth.*

## What each method can tell you

| | Moderated study | Unmoderated test | Internal review | **Gnomi** |
|---|:-:|:-:|:-:|:-:|
| Offers explanations of friction *(Gnomi comments are generated)* | ● | ◐ | ◐ | ● |
| Explores opinion spread *(simulated posts and opinions in Gnomi)* | ○ | ○ | ○ | ● |
| Feedback before launch, with no recruiting | ○ | ○ | ● | ● |
| Fresh eyes, not the people who built it *(simulated first-timers)* | ● | ● | ○ | ● |
| Configurable segments, languages and access needs | ◐ | ◐ | ○ | ● |
| Real human behaviour *(use Gnomi to pick what to test with people)* | ● | ● | ◐ | ○ |

● Yes · ◐ Partly · ○ No · Ratings reflect how each method usually works, not a benchmark.

## How simulated users are generated

You set or approve audience segments, shares and trait distributions such as language, device and patience. Seeded code samples traits; the configured language model proposes four fictional profiles with selection weights. Code selects one and the model expands its biography. You review and edit the personas before running. The weights and profiles are model-generated assumptions, not measured audience probabilities. [Generation details](../persona-generation.md).

Screenshots and logs document agent activity; generated quotes are not participant testimony. “Confirmed” in an app report means corroboration within that simulation. Counts and social spread do not estimate real-world prevalence. [How to interpret and validate findings](../interpreting-simulations.md).

## How it works

1. **Describe your audience.** Set segments and shares. Seeded code samples traits; a model writes fictional profiles. Review and edit them.
2. **Point it at staging.** Record a login once. Gnomi visits only the hosts you allow.
3. **Watch the swarm.** A live graph of who used what, who talked to whom and who changed whose mind.
4. **Share the report.** Hypotheses ranked by simulated segment, with logs and generated quotes. Test key items with real people.

---

**Know what to test next.**

<sub>Runs on your machine with your own model keys; model inputs go only to the provider you configure. Today: web apps on staging. Next: prototypes, design frames, copy and run comparison. Simulated findings are hypotheses, not evidence about real users. Profiles encode audience assumptions; logs record agent actions; quotes are generated. Validate with real people. Figures measured on Gnomi’s test app, 16 Oct 2026.</sub>
