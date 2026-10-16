import { crc32, deflateSync } from 'node:zlib';

// A stand-in for Figma's REST API, shaped like its documented responses (developers.figma.com/docs/rest-api): tests and
// GNOMI_FAKE_FIGMA=1 use it so that no Figma token and no network are needed. Like the scripted model, every frame says plainly
// that it is fake (a flat colour). The one token it refuses is FAKE_EXPIRED_TOKEN.

export const FAKE_KEY = 'AbCdEfGhIjKlMnOpQrStUv';
export const FAKE_NO_ACCESS_KEY = 'NoAccessAbCdEfGhIjKlMn';
export const FAKE_EXPIRED_TOKEN = 'figd_expired';
export const FAKE_STORAGE = 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/';

export interface FakeFigmaOptions {
  frames?: number; // top-level frames listed, 3 of them inside a section (default 50)
  latencyMs?: number;
  /** Render requests naming one of these ids answer `images: { id: null }` for it, as Figma does for a node it cannot render. */
  nullRender?: string[];
  /** Render requests naming one of these ids fail as a whole with a 500. */
  crashRender?: string[];
}

export interface FakeFigma {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  calls: { url: string; token: string | null }[];
}

/** A flat-coloured PNG, so that every frame is a different, valid image. */
export function fakePng(seed: number, width = 36, height = 64) {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const pixel = [(seed * 67) % 200 + 40, (seed * 131) % 200 + 40, (seed * 197) % 200 + 40];
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => pixel).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const frame = (id: string, name: string, phone: boolean) => ({
  id, name, type: 'FRAME', scrollBehavior: 'SCROLLS', blendMode: 'PASS_THROUGH', clipsContent: true, children: [],
  absoluteBoundingBox: { x: Number(id.split(':')[1]) * 500, y: 0, width: phone ? 375 : 1440, height: phone ? 812 : 900 },
});

/** The file response at depth 2: pages and their top-level objects, with a section whose children come from the nodes endpoint. */
export function fakeFile(frames = 50) {
  const top = Math.max(0, frames - 3);
  return {
    name: 'Acme checkout', role: 'editor', lastModified: '2026-10-01T10:00:00Z', editorType: 'figma', thumbnailUrl: '', version: '4242424242',
    schemaVersion: 0, components: {}, componentSets: {}, styles: {},
    document: {
      id: '0:0', name: 'Document', type: 'DOCUMENT', scrollBehavior: 'SCROLLS',
      children: [
        {
          id: '0:1', name: 'Checkout flow', type: 'CANVAS', backgroundColor: { r: 0.96, g: 0.96, b: 0.96, a: 1 }, scrollBehavior: 'SCROLLS',
          children: [
            ...Array.from({ length: top }, (_, i) => frame(`1:${i + 2}`, `${String(i + 1).padStart(2, '0')} ${i % 3 ? 'Screen' : 'Cart'} ${i + 1}`, i % 5 !== 0)),
            { id: '2:1', name: 'Variants', type: 'SECTION', scrollBehavior: 'SCROLLS', children: [] },
            { id: '3:1', name: 'Hidden draft', type: 'FRAME', visible: false, children: [], absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 } },
            { id: '3:2', name: 'Note', type: 'TEXT', characters: 'Not a frame', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 } },
          ],
        },
        { id: '0:2', name: 'Archive', type: 'CANVAS', children: [{ id: '4:1', name: 'Old component', type: 'COMPONENT', children: [] }] },
      ],
    },
  };
}
const sectionFrames = () => ['A', 'B', 'C'].map((letter, i) => frame(`2:${i + 2}`, `Variant ${letter}`, true));

export function fakeFigma(opts: FakeFigmaOptions = {}): FakeFigma {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const token = new Headers(init?.headers).get('x-figma-token');
    fake.calls.push({ url: url.toString(), token });
    if (opts.latencyMs) await new Promise((resolve) => setTimeout(resolve, opts.latencyMs));

    if (url.host !== 'api.figma.com') {
      const match = /\/images\/frame-(\d+)-(\d+)-(\d+)$/.exec(url.pathname);
      if (!match) return json({ status: 404, err: 'Not found' }, 404);
      const wide = match[3] === '100'; // exported at 1x: the desktop-sized frames
      return new Response(fakePng(Number(match[2]) + Number(match[3]) * 7, wide ? 64 : 36, wide ? 40 : 64), { headers: { 'content-type': 'image/png' } });
    }
    if (!token || token === FAKE_EXPIRED_TOKEN) return json({ status: 403, err: 'Invalid token' }, 403);
    if (url.pathname === '/v1/me') return json({ id: '1', handle: 'Fake designer', img_url: '' });

    const [, , kind, key, sub] = url.pathname.split('/');
    if (kind === 'files' && key === FAKE_NO_ACCESS_KEY) return json({ status: 403, err: 'Forbidden' }, 403);
    if ((kind === 'files' || kind === 'images') && key !== FAKE_KEY) return json({ status: 404, err: 'Not found' }, 404);
    if (kind === 'files' && !sub) return json(fakeFile(opts.frames));
    if (kind === 'files' && sub === 'nodes') {
      const nodes = Object.fromEntries((url.searchParams.get('ids') ?? '').split(',').map((id) => [id, id === '2:1' ? { document: { id, name: 'Variants', type: 'SECTION', children: sectionFrames() } } : null]));
      return json({ name: 'Acme checkout', version: '4242424242', nodes });
    }
    if (kind === 'images') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      if (!ids.length) return json({ status: 400, err: 'Parameter ids is required' }, 400);
      if (ids.some((id) => opts.crashRender?.includes(id))) return json({ status: 500, err: 'Render timeout' }, 500);
      const scale = Number(url.searchParams.get('scale') ?? 1);
      const images = Object.fromEntries(ids.map((id) => [id, opts.nullRender?.includes(id) ? null : `${FAKE_STORAGE}frame-${id.split(':')[0]}-${id.split(':')[1]}-${Math.round(scale * 100)}`]));
      return json({ err: null, images });
    }
    return json({ status: 404, err: 'Not found' }, 404);
  }) as FakeFigma;
  fake.calls = [];
  return fake;
}
