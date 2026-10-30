# Gym research pack

**Everything here is invented.** No real person said any of it, and no real person, company or phone number is named. The notes exist so that Gnomi's grounding pipeline has something to read in its `grounded` evaluation arm.

| File | Segment |
|---|---|
| `recruiting.md` | Recruiting (`seg-1`) |
| `hiring-managers.md` | Hiring management (`seg-2`) |
| `admins.md` | Workspace administration (`seg-3`) |
| `coordinators.md` | Department coordination (`seg-4`) |

`digest.json` is a stored digest of these files, one entry per segment, in the form of `Segment.grounding`, so the arm needs no extraction call. A test in [engine/src/audience/ground.test.ts](../../../engine/src/audience/ground.test.ts) checks that its hashes match the files and that every remark is word for word in the redacted text.

This pack shows that the pipeline works: remarks reach the prompts and the report names its sources. It cannot show that grounded personas are more realistic, because the Gym has no real users.
