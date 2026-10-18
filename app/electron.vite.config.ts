import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import engine from '../engine/package.json' with { type: 'json' };
import simulation from '../simulation/package.json' with { type: 'json' };

export default defineConfig({
  main: {
    build: {
      // The engine and the simulation are bundled from their TypeScript source; only their npm dependencies stay external.
      externalizeDeps: { include: [...Object.keys(engine.dependencies), ...Object.keys(simulation.dependencies)].filter((dep) => !dep.startsWith('@gnomi/')) },
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
