# Gym

A deliberately flawed demo ATS (`server.ts`) plus, for Gnomi's M5 text and static-design POIs, design frames and copy (`assets/`). The defect catalogue is `defects.yaml`: each entry has a `poi` (`web`, `text` or `design`) and a `toggle`, and `none` is the defect-free control.

## Design frames and copy (Gym v3)

| Defect | POI | What it seeds |
|---|---|---|
| D26 | design | `checkout`, 6 frames: frame 4 is a sign-in prompt where an order confirmation is expected |
| D27 | design | `invite`, 4 frames: from frame 2 the Invite control is an icon-only button with an abstract glyph |
| D28 | text | `pricing`: the Team plan card lists SSO, the comparison table and FAQ give it to Business only |

```ts
import { gymAssets } from "./gym/assets.ts";

gymAssets({ defects: "D26" }); // checkout with D26, everything else control
gymAssets({ defects: "none" }); // the control build; "all" (default) switches on D26 to D28
// => { frames: { checkout: string[], invite: string[] }, copy: { pricing: string } }, absolute paths, frames in order
```

Files are `assets/frames/<sequence>/<control|Dxx>/NN.png` (1280 px wide) and `assets/copy/<sample>/<control|Dxx>.md`. Web defects (D01 to D25) are accepted by `gymAssets` and ignored. The M5 acceptance mode ([guide](../docs/m5-acceptance.md)) runs D26 and D28 against these controls.

## Regenerating

The HTML for every frame and the pricing copy are in `design.ts`. After editing it:

```sh
npx playwright install chromium   # once
npm run assets -w @gnomi/gym
```

This rewrites the PNGs, the copy and `assets/manifest.json`. The manifest holds a hash of each frame's HTML, and `assets.test.ts` fails when it no longer matches `design.ts`, so a change without a regenerate cannot be committed unnoticed. Rendering is deterministic on one machine (two renders give identical bytes), but the text uses system fonts, so a regenerate on another OS changes glyph shapes. Commit the PNGs from one machine and treat them as the reference.
