import { crc32, deflateSync, inflateSync } from 'node:zlib';

// Design frames as the model sees them (tech.md §7: "downscaled copies for the model"): vision cost grows with pixels, so a frame
// goes at most FRAME_EDGE pixels on its long side. Pure Node, no image library: PNG is decoded and re-encoded here.
// shortcut: JPEG and WebP frames, and the rare PNGs this does not decode (interlaced, under 8 bits per channel), go at their own
// size, which providers cap themselves (Anthropic at 1,568 px); decode them too if such frames prove costly.

export const FRAME_EDGE = 1024;

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }; // by PNG colour type

/** The image as RGB over white, or null when it is not a PNG this decoder reads; a damaged one throws. */
export function decodePng(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } | null {
  const file = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!file.subarray(0, 8).equals(SIGNATURE)) return null;
  let width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const data: Buffer[] = [];
  for (let at = 8; at + 12 <= file.length; ) {
    const length = file.readUInt32BE(at);
    const type = file.toString('latin1', at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') [width, height, depth, colour, interlace] = [body.readUInt32BE(0), body.readUInt32BE(4), body[8], body[9], body[12]];
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = CHANNELS[colour];
  if (!channels || interlace || !width || !height || (depth !== 8 && (depth !== 16 || colour === 3)) || (colour === 3 && !palette)) return null;
  const bpp = (channels * depth) / 8; // bytes per pixel
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length < (stride + 1) * height) return null;

  // Undo the per-row filters (PNG spec §9): each byte was stored minus a prediction from its left (a), upper (b) and upper-left (c) bytes.
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const from = y * (stride + 1) + 1;
    const to = y * stride;
    const filter = raw[from - 1];
    const above = to - stride; // only read when y > 0
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[to + x - bpp] : 0;
      const b = y > 0 ? pixels[above + x] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const c = y > 0 && x >= bpp ? pixels[above + x - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[to + x] = raw[from + x] + predicted;
    }
  }

  // To RGB, transparent pixels over white; a 16-bit sample keeps its high byte.
  const rgb = new Uint8Array(width * height * 3);
  const step = depth / 8;
  for (let i = 0, at = 0, to = 0; i < width * height; i++, at += bpp, to += 3) {
    let r: number, g: number, b: number, alpha = 255;
    if (colour === 3) {
      const index = pixels[at] * 3;
      [r, g, b] = [palette![index], palette![index + 1], palette![index + 2]];
      alpha = transparency?.[index / 3] ?? 255;
    } else if (channels <= 2) {
      r = g = b = pixels[at];
      if (channels === 2) alpha = pixels[at + step];
    } else {
      r = pixels[at];
      g = pixels[at + step];
      b = pixels[at + 2 * step];
      if (channels === 4) alpha = pixels[at + 3 * step];
    }
    if (alpha === 255) {
      rgb[to] = r;
      rgb[to + 1] = g;
      rgb[to + 2] = b;
    } else {
      const white = 255 * (255 - alpha);
      rgb[to] = (r * alpha + white) / 255;
      rgb[to + 1] = (g * alpha + white) / 255;
      rgb[to + 2] = (b * alpha + white) / 255;
    }
  }
  return { width, height, rgb };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** An 8-bit RGB PNG. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height); // filter byte 0 (none) before every row
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

/** Averages each target pixel's box of source pixels, so thin lines and small text fade rather than vanish. */
function shrink(width: number, height: number, rgb: Uint8Array, toWidth: number, toHeight: number): Uint8Array {
  const out = new Uint8Array(toWidth * toHeight * 3);
  for (let ty = 0; ty < toHeight; ty++) {
    const y0 = Math.floor((ty * height) / toHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / toHeight));
    for (let tx = 0; tx < toWidth; tx++) {
      const x0 = Math.floor((tx * width) / toWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / toWidth));
      let r = 0, g = 0, b = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const at = (y * width + x) * 3;
          r += rgb[at];
          g += rgb[at + 1];
          b += rgb[at + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const to = (ty * toWidth + tx) * 3;
      out[to] = r / n + 0.5;
      out[to + 1] = g / n + 0.5;
      out[to + 2] = b / n + 0.5;
    }
  }
  return out;
}

/** The frame as sent to the model: a PNG larger than `edge` on its long side comes back shrunk to it, anything else as it is. */
export function frameForModel(data: Uint8Array, mediaType: ImageType, edge = FRAME_EDGE): { data: Uint8Array; mediaType: ImageType } {
  let image: ReturnType<typeof decodePng> = null;
  try {
    if (mediaType === 'image/png') image = decodePng(data);
  } catch {} // a damaged PNG goes as it is: the provider decides what it can read
  if (!image) return { data, mediaType };
  const scale = edge / Math.max(image.width, image.height);
  if (scale >= 1) return { data, mediaType };
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  return { data: encodePng(width, height, shrink(image.width, image.height, image.rgb, width, height)), mediaType };
}
