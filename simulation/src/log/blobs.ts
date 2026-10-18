import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { BlobStore } from '../seams.ts';

export function createFsBlobStore(root: string): BlobStore {
  const base = resolve(root);
  // The UI requests blobs by path, so every path must name a file strictly inside root.
  // shortcut: lexical check, so a symlink inside root is followed; use realpath if blobs come from outside the app
  const locate = (path: string): string => {
    const full = resolve(base, path);
    if (isAbsolute(path) || !full.startsWith(base + sep)) throw new Error(`Blob path is outside the project: ${path}`);
    return full;
  };
  return {
    async put(path, data) {
      const full = locate(path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, data);
    },
    async get(path) {
      return readFile(locate(path));
    },
  };
}
