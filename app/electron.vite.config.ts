import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import engine from '../engine/package.json' with { type: 'json' };

export default defineConfig({
  main: {
    build: {
      // The engine is bundled from its TypeScript source; only its npm dependencies stay external.
      externalizeDeps: { include: Object.keys(engine.dependencies) },
      rolldownOptions: {
        // host.js is the entry that utilityProcess.fork() starts, so it is built next to index.js.
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          host: resolve(import.meta.dirname, '../engine/src/host.ts'),
        },
      },
    },
  },
  // A sandboxed preload cannot be an ES module.
  preload: { build: { rolldownOptions: { output: { format: 'cjs' } } } },
  renderer: { plugins: [react(), tailwindcss()] },
});
