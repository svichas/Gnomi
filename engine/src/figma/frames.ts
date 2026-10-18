import { importAsset, type AssetInfo } from '@gnomi/simulation/assets.ts';
import type { BlobStore } from '@gnomi/simulation/seams.ts';
import { FigmaError, type FigmaClient } from './client.ts';
import { FILE_KEY, NODE_ID, parseFigmaLink } from './link.ts';

// Listing a Figma file's frames and turning the chosen ones into project assets (docs/pois.md). Requests per import:
// the file at depth 2 (pages and their top-level objects), one more for the contents of its sections, then image
// renders in batches. Nothing is fetched that the list does not need: no deep tree, no vector geometry.

const BATCH = 20; // ids per render request; not a documented limit, a caution from the spike (§2.2)
const SECTION_BATCH = 50;
const MAX_IMPORT = 100;
const MAX_SPLITS = 12; // extra requests an import may spend finding the frame that fails a render batch
const PNG_MAX = 20 * 1024 * 1024; // the assets store's limit for images (assets.ts)
const PREVIEW_PIXELS = 320;
const MAX_PREVIEWS = 60; // frames past this show a blank, which keeps a file with hundreds of frames to three render requests

export interface FigmaFrame {
  id: string;
  name: string;
  page: string;
  section: string | null;
  width: number | null;
  height: number | null;
}

export interface FigmaFile {
  key: string;
  name: string;
  version: string | null; // pinned on every later request, so the frames come from one version of the file
  node: string | null; // the layer the pasted link pointed at, if any
  frames: FigmaFrame[];
}

/** What the page sends back to ask for previews and an import: only the frames' ids and sizes, never the file's content. */
export type FigmaFrameRef = Pick<FigmaFrame, 'id' | 'width' | 'height'>;

export interface FigmaImport {
  frames: { id: string; asset: AssetInfo }[];
  failed: { id: string; name: string; reason: string }[];
}

interface Node {
  id?: string;
  name?: string;
  type?: string;
  visible?: boolean;
  absoluteBoundingBox?: { width?: number; height?: number } | null;
  children?: Node[];
}
interface FileResponse {
  name?: string;
  version?: string;
  document?: Node;
}
interface NodesResponse {
  nodes?: Record<string, { document?: Node } | null>;
}
interface ImagesResponse {
  err?: string | null;
  images?: Record<string, string | null>;
}

const chunks = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const key = (file: string) => {
  if (!FILE_KEY.test(file)) throw new FigmaError('bad_link', 'That is not a Figma file key.');
  return file;
};

/** The file's top-level frames: those on a page, and those directly inside a section. Hidden ones render nothing and are left out. */
export async function listFrames(client: FigmaClient, link: string): Promise<FigmaFile> {
  const { key: file, node } = parseFigmaLink(link);
  const response = await client.get<FileResponse>(`/v1/files/${file}`, { depth: '2' });
  const pages = response.document?.children;
  if (!Array.isArray(pages)) throw new FigmaError('failed', 'Figma sent a file Gnomi could not read.');
  const version = response.version ? String(response.version) : null;

  const sections = pages.flatMap((page) => (page.children ?? []).filter((child) => child.type === 'SECTION' && child.visible !== false && child.id));
  const inside = new Map<string, Node[]>();
  for (const batch of chunks(sections, SECTION_BATCH)) {
    const ids = batch.map((section) => section.id!).join(',');
    const loaded = await client.get<NodesResponse>(`/v1/files/${file}/nodes`, { ids, depth: '1', ...(version ? { version } : {}) });
    for (const section of batch) inside.set(section.id!, loaded.nodes?.[section.id!]?.document?.children ?? []);
  }

  const frameOf = (child: Node, page: string, section: string | null): FigmaFrame[] =>
    child.type === 'FRAME' && child.visible !== false && child.id && NODE_ID.test(child.id)
      ? [{ id: child.id, name: child.name || 'Untitled', page, section, width: child.absoluteBoundingBox?.width ?? null, height: child.absoluteBoundingBox?.height ?? null }]
      : [];
  const frames = pages.flatMap((page) =>
    (page.children ?? []).flatMap((child) =>
      child.type === 'SECTION' && child.id ? (inside.get(child.id) ?? []).flatMap((frame) => frameOf(frame, page.name ?? '', child.name ?? null)) : frameOf(child, page.name ?? '', null),
    ),
  );
  return { key: file, name: response.name || 'Figma file', version, node, frames };
}

const idsOf = (frames: { id: string }[], max: number) => {
  const ids = [...new Set(frames.map((frame) => frame.id))];
  if (!ids.length) throw new FigmaError('failed', 'Choose at least one frame.');
  if (ids.length > max || !ids.every((id) => NODE_ID.test(id))) throw new FigmaError('failed', `Choose between 1 and ${max} frames.`);
  return ids;
};

/** Small JPEG previews as data URLs, by frame id, in render batches. A preview that cannot be had is simply missing: they are only for looking at. */
export async function previews(client: FigmaClient, p: { file: string; version: string | null; frames: FigmaFrameRef[] }): Promise<Record<string, string>> {
  const file = key(p.file);
  const found: Record<string, string> = {};
  await Promise.all(
    chunks(p.frames.slice(0, MAX_PREVIEWS), BATCH).map(async (batch) => {
      try {
        // one scale per request: the batch's median long side comes out near PREVIEW_PIXELS
        const sides = batch.map((frame) => Math.max(frame.width ?? 0, frame.height ?? 0)).filter(Boolean).sort((a, b) => a - b);
        const scale = sides.length ? Math.min(1, Math.max(0.05, PREVIEW_PIXELS / sides[Math.floor(sides.length / 2)])) : 0.25;
        const { images } = await client.get<ImagesResponse>(`/v1/images/${file}`, {
          ids: idsOf(batch, BATCH).join(','), scale: String(Math.round(scale * 100) / 100), format: 'jpg', ...(p.version ? { version: p.version } : {}),
        });
        await mapLimit(Object.entries(images ?? {}), 8, async ([id, url]) => {
          try {
            if (url) found[id] = `data:image/jpeg;base64,${Buffer.from(await client.download(url, PNG_MAX)).toString('base64')}`;
          } catch {
            // this one stays blank
          }
        });
      } catch {
        // previews are cosmetic: a rate limit or a failed render leaves a gap, and the import reports its own errors
      }
    }),
  );
  return found;
}

/** Exports the frames as PNG, downloads them at once (render links expire after 30 days) and stores each as an asset. */
export async function importFrames(
  client: FigmaClient,
  blobs: BlobStore,
  p: { file: string; version: string | null; frames: (FigmaFrameRef & { name: string })[] },
): Promise<FigmaImport> {
  const file = key(p.file);
  idsOf(p.frames, MAX_IMPORT);
  const frames = [...new Map(p.frames.map((frame) => [frame.id, frame])).values()];
  const urls = new Map<string, string>();
  const reasons = new Map<string, string>();
  let splits = 0;

  /** One render request; when Figma fails the whole batch (400, 500) the batch is halved to find the frame that does. */
  async function render(ids: string[], scale: number): Promise<void> {
    try {
      const { images, err } = await client.get<ImagesResponse>(`/v1/images/${file}`, { ids: ids.join(','), scale: String(scale), format: 'png', ...(p.version ? { version: p.version } : {}) });
      if (err) throw new FigmaError('failed', `Figma could not render: ${err}`, 400);
      for (const id of ids) {
        const url = images?.[id];
        if (url) urls.set(id, url);
        else reasons.set(id, 'Figma could not render this frame. It may be hidden, empty or too large.');
      }
    } catch (err) {
      if (!(err instanceof FigmaError) || err.kind !== 'failed') throw err; // a token, rate limit or network problem stops the whole import
      if (ids.length > 1 && splits < MAX_SPLITS) {
        splits++;
        const half = Math.ceil(ids.length / 2);
        await render(ids.slice(0, half), scale);
        await render(ids.slice(half), scale);
      } else for (const id of ids) reasons.set(id, `Figma failed to render this frame (error ${err.status ?? 'unknown'}). It may be too large or too complex.`);
    }
  }
  // Wide frames at 1x, phone-sized ones at 2x: legible text without 5000-pixel-wide PNGs.
  const wide = (frame: FigmaFrameRef) => (frame.width ?? 0) > 800;
  for (const [scale, group] of [[1, frames.filter(wide)], [2, frames.filter((frame) => !wide(frame))]] as const) {
    for (const batch of chunks(group, BATCH)) await render(batch.map((frame) => frame.id), scale);
  }

  const stored = await mapLimit(frames.filter((frame) => urls.has(frame.id)), 4, async (frame) => {
    try {
      const data = await client.download(urls.get(frame.id)!, PNG_MAX);
      return { id: frame.id, asset: await importAsset(blobs, { name: `${frame.name.replace(/[\\/]/g, '-') || 'Frame'}.png`, data }) };
    } catch (err) {
      reasons.set(frame.id, err instanceof Error ? err.message : String(err));
      return null;
    }
  });
  return {
    frames: stored.filter((item) => item !== null),
    failed: frames.filter((frame) => reasons.has(frame.id)).map((frame) => ({ id: frame.id, name: frame.name, reason: reasons.get(frame.id)! })),
  };
}
