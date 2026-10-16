import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { BlobStore } from './seams.ts';

// The project's assets/ folder (tech.md §5.2): files a POI is made of, imported from the user's disk or pasted. Nothing here
// touches the network. An asset id is the file's name in assets/: a content hash and a known extension, so it is always a safe
// file name, the same file imported twice is one asset, and an id from a saved project cannot point outside the folder.

const MB = 1024 * 1024;
const TEXT = { max: 2 * MB };
const IMAGE = { max: 20 * MB };
/** What may be imported, by extension: text as UTF-8, images by their file signature. */
export const ASSET_TYPES = {
  '.md': { mime: 'text/markdown', ...TEXT },
  '.txt': { mime: 'text/plain', ...TEXT },
  '.png': { mime: 'image/png', ...IMAGE },
  '.jpg': { mime: 'image/jpeg', ...IMAGE },
  '.jpeg': { mime: 'image/jpeg', ...IMAGE },
  '.webp': { mime: 'image/webp', ...IMAGE },
} as const;
type Extension = keyof typeof ASSET_TYPES;

const ID = /^[0-9a-f]{16}\.(md|txt|png|jpe?g|webp)$/;

export interface AssetInfo {
  id: string; // e.g. '3f9a…c2.md', the file under assets/
  name: string; // the name it was imported under, for display only
  mime: string;
  bytes: number;
}

const kindOf = (name: string): Extension => {
  const ext = extname(name).toLowerCase();
  if (!(ext in ASSET_TYPES)) throw new Error(`Gnomi imports ${Object.keys(ASSET_TYPES).join(', ')} files, not "${basename(name)}".`);
  return ext as Extension;
};

const startsWith = (data: Uint8Array, bytes: number[], at = 0) => bytes.every((b, i) => data[at + i] === b);
const SIGNATURES: Partial<Record<Extension, (data: Uint8Array) => boolean>> = {
  '.png': (d) => startsWith(d, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  '.jpg': (d) => startsWith(d, [0xff, 0xd8, 0xff]),
  '.jpeg': (d) => startsWith(d, [0xff, 0xd8, 0xff]),
  '.webp': (d) => startsWith(d, [0x52, 0x49, 0x46, 0x46]) && startsWith(d, [0x57, 0x45, 0x42, 0x50], 8),
};

/** Stores one file's bytes under a content id, after checking its size and that its content is what its name says. */
export async function importAsset(blobs: BlobStore, file: { name: string; data: Uint8Array }): Promise<AssetInfo> {
  const ext = kindOf(file.name);
  const { mime, max } = ASSET_TYPES[ext];
  const name = basename(file.name);
  if (file.data.length === 0) throw new Error(`"${name}" is empty.`);
  if (file.data.length > max) throw new Error(`"${name}" is larger than ${max / MB} MB.`);
  const signature = SIGNATURES[ext];
  if (signature && !signature(file.data)) throw new Error(`"${name}" is not a ${ext.slice(1).toUpperCase()} image.`);
  if (!signature) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(file.data);
    } catch {
      throw new Error(`"${name}" is not UTF-8 text.`);
    }
  }
  const id = `${createHash('sha256').update(file.data).digest('hex').slice(0, 16)}${ext === '.jpeg' ? '.jpg' : ext}`;
  await blobs.put(`assets/${id}`, file.data);
  return { id, name, mime, bytes: file.data.length };
}

/** Imports pasted text as a Markdown asset. */
export const importText = (blobs: BlobStore, text: string, name = 'Pasted text.md') =>
  importAsset(blobs, { name: extname(name) ? name : `${name}.md`, data: new TextEncoder().encode(text) });

/** Imports a file from the user's disk, refusing anything but a regular file within the size limit before reading it all. */
export async function importLocalFile(blobs: BlobStore, path: string): Promise<AssetInfo> {
  const { max } = ASSET_TYPES[kindOf(path)];
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`"${basename(path)}" is not a file.`);
    if (stat.size > max) throw new Error(`"${basename(path)}" is larger than ${max / MB} MB.`);
    return await importAsset(blobs, { name: path, data: await handle.readFile() });
  } finally {
    await handle.close();
  }
}

/** The blob path of an asset id, refusing anything that is not an id this store could have made. */
export function assetPath(id: string): string {
  if (!ID.test(id)) throw new Error(`"${id}" is not an asset id.`);
  return `assets/${id}`;
}

export const assetMime = (id: string) => ASSET_TYPES[kindOf(id)].mime;

export const readAsset = (blobs: BlobStore, id: string) => blobs.get(assetPath(id));
