// A person uploads a file from their device; a persona has none, so it is handed one made here, of a kind the field accepts.
// An image is 1600×900, the size of a typical photo: a tiny one can fail a site's own size check and read as the product's friction.
import { crc32, deflateSync } from 'node:zlib';

export interface SampleFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const IMAGE = /^(?:png|jpe?g|gif|webp|heic|heif|avif|bmp|svg)$/;
// What can be made here, by extension.
const MADE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv' };

function png(width: number, height: number): Buffer {
  const stride = 1 + width * 3; // a filter byte, then RGB
  const pixels = Buffer.alloc(stride * height);
  // A sky-like gradient, top to bottom.
  for (let y = 0; y < height; y++) pixels.fill(Buffer.from([90 + (y * 100) / height, 150 + (y * 60) / height, 220]), y * stride + 1, (y + 1) * stride);
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2], 8); // 8 bits per channel, RGB
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

/** A baseline JPEG of one sky blue: every 8×8 block after the first repeats it, so each is a few zero bits. */
function jpeg(width: number, height: number): Buffer {
  let bits = '';
  // rgb(110, 170, 220) as Y, Cb and Cr less 128: each block's DC over a quantiser of 8. Its size's code (sizes 0, 5, 6 are
  // 00, 01, 10), its bits (a negative one less one), then end of block (0).
  for (const dc of [30, 35, -34]) {
    const size = Math.abs(dc).toString(2).length;
    bits += [0, 5, 6].indexOf(size).toString(2).padStart(2, '0') + (dc < 0 ? dc + (1 << size) - 1 : dc).toString(2).padStart(size, '0') + '0';
  }
  bits += '000'.repeat(3 * (Math.ceil(width / 8) * Math.ceil(height / 8) - 1));
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '1');
  const scan: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    const byte = parseInt(bits.slice(i, i + 8), 2);
    scan.push(...(byte === 0xff ? [0xff, 0] : [byte])); // a 0xff in the scan is stuffed
  }
  const segment = (marker: number, data: number[]) => [0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff, ...data];
  const counts = (...lengths: number[]) => [...lengths, ...Array(16 - lengths.length).fill(0)]; // codes of each bit length
  return Buffer.from([
    0xff, 0xd8,
    ...segment(0xe0, [...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [0, ...Array(64).fill(8)]),
    ...segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    ...segment(0xc4, [0x00, ...counts(0, 3), 0, 5, 6]),
    ...segment(0xc4, [0x10, ...counts(1), 0]),
    ...segment(0xda, [3, 1, 0, 2, 0, 3, 0, 0, 63, 0]),
    ...scan,
    0xff, 0xd9,
  ]);
}

/** One blank A4 page. */
function pdf(): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>'];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}

const images: Record<string, Buffer> = {}; // made once each, on the first upload

/**
 * The file a person would pick for a field that takes `accept`: named after `typed` when the persona typed one, of that name's
 * kind when the field takes it, else of the first kind it takes, an image first (a document first when the persona named one).
 */
export function sampleFile(accept: string, typed = ''): SampleFile {
  const tokens = accept.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
  const base = typed.trim().split(/[\\/]/).at(-1)!;
  const [, stem = base, ext = ''] = /^(.+)\.(\w+)$/.exec(base) ?? [];
  const named = ext.toLowerCase();
  const takes = (kind: string) => tokens.length === 0 || tokens.some((t) => t === '*/*' || t === MADE[kind] || t === `${MADE[kind].split('/')[0]}/*` || (t.startsWith('.') && MADE[t.slice(1)] === MADE[kind]));
  const order = [named, ...(named && !IMAGE.test(named) ? ['pdf', 'txt', 'csv', 'png', 'jpg'] : ['png', 'jpg', 'pdf', 'txt', 'csv'])];
  const kind = order.find((k) => Object.hasOwn(MADE, k) && takes(k));
  // shortcut: no Word, spreadsheet, audio or other file, upgrade with real samples per format if a target app asks only for one.
  if (!kind) throw new Error('unsupported_file');
  const mimeType = MADE[kind];
  const name = kind === named ? base : `${stem || (mimeType.startsWith('image/') ? 'photo' : kind === 'pdf' ? 'document' : 'notes')}.${kind}`;
  if (mimeType === 'image/png') return { name, mimeType, buffer: (images.png ??= png(1600, 900)) };
  if (mimeType === 'image/jpeg') return { name, mimeType, buffer: (images.jpeg ??= jpeg(1600, 900)) };
  if (kind === 'pdf') return { name, mimeType, buffer: pdf() };
  return { name, mimeType, buffer: Buffer.from('Sample notes.\n') };
}
