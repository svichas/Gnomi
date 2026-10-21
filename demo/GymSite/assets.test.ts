import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { COPY_SAMPLES, FRAME_SEQUENCES, GYM_V3_DEFECT_IDS, assetFile, gymAssets } from "./assets.ts";
import { copyPlan, framePlan, pricingCopy } from "./design.ts";
import { frameManifest, renderPages } from "./generate-assets.ts";

const none = gymAssets({ defects: "none" });
const readBytes = (path: string) => readFile(path);
const html = (sequence: keyof typeof FRAME_SEQUENCES, defect: boolean) =>
  framePlan().filter((f) => f.key.startsWith(`frames/${sequence}/${defect ? FRAME_SEQUENCES[sequence].defect : "control"}/`)).map((f) => f.html);

describe("Gym v3 catalogue", () => {
  it("defects.yaml gives every entry a poi, and the design and text entries are D26 to D28 with a toggle and the evaluation-plan fields", async () => {
    const yaml = await readFile(new URL("./defects.yaml", import.meta.url), "utf8");
    const entries = yaml.split(/^(?=- id: )/m).filter(Boolean);
    const field = (entry: string, name: string) => entry.match(new RegExp(`^ {2}${name}: (.*?)(?: +#.*)?$`, "m"))?.[1] ?? "";
    for (const entry of entries) assert.match(field(entry, "poi"), /^(web|text|design)$/, entry.slice(0, 12));
    const v3 = entries.filter((entry) => field(entry, "poi") !== "web");
    assert.deepEqual(v3.map((entry) => field(entry, "toggle")), GYM_V3_DEFECT_IDS);
    for (const entry of v3) {
      const id = field(entry, "toggle");
      assert.equal(entry.match(/^- id: (\S+)$/m)?.[1], id);
      assert.match(field(entry, "title"), /\S/, id);
      assert.match(field(entry, "type"), /^(flow|label|affordance|error-handling|performance|visual|content)$/, id);
      assert.match(field(entry, "severity"), /^(low|medium|high)$/, id);
      assert.match(field(entry, "affects"), /^\[.+\]$/, id);
      assert.match(field(entry, "visual_only"), /^(true|false)$/, id);
      // A design defect names the frame where it first appears, a text defect the sample.
      if (field(entry, "poi") === "design") {
        const [sequence, frame] = field(entry, "frames").slice(1, -1).split("/") as [keyof typeof FRAME_SEQUENCES, string];
        assert.equal(FRAME_SEQUENCES[sequence].defect, id);
        assert.ok(Number(frame) >= 1 && Number(frame) <= FRAME_SEQUENCES[sequence].frames, id);
      } else {
        assert.deepEqual(field(entry, "pages"), `[${Object.keys(COPY_SAMPLES)}]`);
      }
    }
  });
});

describe("Gym v3 generator", () => {
  it("builds the same HTML and copy on every call, and the same PNG bytes on every render", async () => {
    assert.deepEqual(framePlan(), framePlan());
    assert.deepEqual(copyPlan(), copyPlan());
    const pages = framePlan().map((f) => f.html);
    const [first, second] = [await renderPages(pages), await renderPages(pages)];
    assert.equal(first.length, 20);
    first.forEach((png, i) => assert.ok(png.equals(second[i]), framePlan()[i].key));
  });

  it("commits the frames the HTML describes: a PNG 1280 px wide under 300 KB for each, and the copy as generated", async () => {
    const manifest = JSON.parse(await readFile(assetFile("manifest.json"), "utf8"));
    assert.deepEqual(manifest, frameManifest(), "design.ts changed: run npm run assets -w @gnomi/gym");
    for (const key of Object.keys(manifest)) {
      const png = await readBytes(assetFile(key));
      assert.equal(png.readUInt32BE(16), 1280, key); // IHDR width
      assert.ok(png.length < 300_000, key);
    }
    for (const { key, text } of copyPlan()) assert.equal(await readFile(assetFile(key), "utf8"), text, key);
  });
});

describe("gymAssets", () => {
  it("none is the control build, all is every defect, and the default is all", () => {
    for (const path of [...none.frames.checkout, ...none.frames.invite, none.copy.pricing]) assert.match(path, /[/\\]control[/\\.]/);
    assert.deepEqual(gymAssets(), gymAssets({ defects: "all" }));
    assert.deepEqual(gymAssets({ defects: "all" }), gymAssets({ defects: GYM_V3_DEFECT_IDS.join(",") }));
    assert.equal(none.frames.checkout.length, 6);
    assert.equal(none.frames.invite.length, 4);
  });

  it("each defect's toggle swaps only its own frames or copy for a file with different content", async () => {
    const groups = (a: typeof none) => ({ checkout: a.frames.checkout, invite: a.frames.invite, pricing: [a.copy.pricing] });
    const owner = { checkout: FRAME_SEQUENCES.checkout.defect, invite: FRAME_SEQUENCES.invite.defect, pricing: COPY_SAMPLES.pricing.defect };
    for (const id of GYM_V3_DEFECT_IDS) {
      const on = groups(gymAssets({ defects: id }));
      for (const [name, paths] of Object.entries(groups(none)) as [keyof typeof owner, string[]][]) {
        if (owner[name] !== id) {
          assert.deepEqual(on[name], paths, `${id} must not touch ${name}`);
          continue;
        }
        const differs = await Promise.all(on[name].map(async (p, i) => p !== paths[i] && !(await readBytes(p)).equals(await readBytes(paths[i]))));
        assert.ok(differs.some(Boolean), `${id} changes nothing in ${name}`);
      }
    }
  });

  it("accepts a comma list and ignores web defects, rejects unknown ids", () => {
    assert.deepEqual(gymAssets({ defects: "D26, D01" }).frames.invite, none.frames.invite);
    assert.deepEqual(gymAssets({ defects: "D26" }).frames.checkout, gymAssets({ defects: "D26,D27" }).frames.checkout);
    assert.throws(() => gymAssets({ defects: "D99" }), /Unknown defect D99/);
  });
});

describe("Gym v3 defects and controls", () => {
  const same = (a: string[], b: string[]) => a.map((x, i) => x === b[i]);

  it("D26: only the sign-in prompt at frame 4 differs, and the control never shows one", async () => {
    const [control, defect] = [html("checkout", false), html("checkout", true)];
    assert.deepEqual(same(control, defect), [true, true, true, false, true, true]);
    assert.match(defect[3], /Sign in to continue/);
    assert.match(control[3], /Your order is placed/);
    assert.doesNotMatch(control.join(), /Sign in|Password/);
    // The committed PNGs differ at the same frame.
    const on = gymAssets({ defects: "D26" }).frames.checkout;
    const differs = await Promise.all(on.map(async (p, i) => !(await readBytes(p)).equals(await readBytes(none.frames.checkout[i]))));
    assert.deepEqual(differs, [false, false, false, true, false, false]);
  });

  it("D27: from frame 2 the Invite control is icon-only, and the control build labels it", () => {
    const [control, defect] = [html("invite", false), html("invite", true)];
    assert.deepEqual(same(control, defect), [true, false, false, false]);
    for (const frame of control.slice(1)) assert.match(frame, />Invite teammate</);
    for (const frame of defect) assert.doesNotMatch(frame, /Invite teammate|title=|aria-label/);
  });

  it("D28: the Team card lists SSO only in the defect copy, and the table and FAQ give it to Business in both", () => {
    const [control, defect] = [pricingCopy(false), pricingCopy(true)];
    const team = (md: string) => md.split("### Team")[1].split("### Business")[0];
    assert.doesNotMatch(team(control), /Single sign-on/);
    assert.match(team(defect), /Single sign-on/);
    for (const md of [control, defect]) {
      assert.match(md, /\| Single sign-on \(SAML SSO\) \| Not included \| Not included \| Included \|/);
      assert.match(md, /No\. Single sign-on \(SAML SSO\) is part of Business/);
    }
    assert.equal(defect.replace("- Google and Microsoft sign-in\n- Single sign-on (SAML SSO)\n", "- Google and Microsoft sign-in\n"), control);
  });
});
