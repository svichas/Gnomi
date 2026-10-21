// Regenerates the Gym v3 assets under demo/GymSite/assets: the pricing copy, the design frames as 1280 px wide PNGs, and manifest.json (a hash of each frame's HTML).
// Run: npm run assets -w @gnomi/gym. Needs Playwright's Chromium (npx playwright install chromium).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright-core";
import { assetFile } from "./assets.ts";
import { copyPlan, framePlan } from "./design.ts";

export const frameManifest = () => Object.fromEntries(framePlan().map(({ key, html }) => [key, createHash("sha256").update(html).digest("hex")]));

export async function renderPages(htmls: string[]): Promise<Buffer[]> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const pngs: Buffer[] = [];
    for (const html of htmls) {
      await page.setContent(html, { waitUntil: "load" });
      pngs.push(await page.screenshot({ type: "png", animations: "disabled", caret: "hide" }));
    }
    return pngs;
  } finally {
    await browser.close();
  }
}

function write(key: string, data: string | Buffer) {
  mkdirSync(dirname(assetFile(key)), { recursive: true });
  writeFileSync(assetFile(key), data);
}

if (import.meta.main) {
  for (const { key, text } of copyPlan()) write(key, text);
  const plan = framePlan();
  const pngs = await renderPages(plan.map((f) => f.html));
  plan.forEach((f, i) => write(f.key, pngs[i]));
  write("manifest.json", JSON.stringify(frameManifest(), null, 2) + "\n");
  console.log(`Wrote ${plan.length} frames and ${copyPlan().length} copy files to demo/GymSite/assets`);
}
