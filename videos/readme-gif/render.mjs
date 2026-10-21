// Renders scene.html frame by frame, then assembles the README GIF with ImageMagick.
// Usage (from the repo root): node videos/readme-gif/render.mjs
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const FPS = 12.5, SECONDS = 12;
const frames = mkdtempSync(join(tmpdir(), 'gnomi-gif-'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 600 } });
await page.goto(pathToFileURL(join(here, 'scene.html')).href);
await page.evaluate(() => document.fonts.ready);
for (let i = 0; i < FPS * SECONDS; i++) {
  await page.evaluate((t) => window.render(t), i / FPS);
  await page.screenshot({ path: join(frames, `f${String(i).padStart(4, '0')}.png`) });
}
await browser.close();

const out = join(here, 'gnomi-social-simulation.gif');
execFileSync('magick', ['-delay', String(100 / FPS), '-loop', '0', join(frames, 'f*.png'),
  '-resize', '960x480', '+dither', '-colors', '128', '-layers', 'Optimize', out], { stdio: 'inherit' });
rmSync(frames, { recursive: true });
console.log(out);
