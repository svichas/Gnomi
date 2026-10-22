// A person uploads a file from their device; a persona has none, so it is handed one made here, of the kind the field asks for.
// An image is a plain 1600×900 PNG, the size of a typical photo: a tiny one can fail a site's own size check and read as the
// product's friction.
// shortcut: images are always PNG, so a field that takes only JPEG gets a PNG it may refuse, upgrade to a JPEG sample if a target app does.
import { crc32, deflateSync } from 'node:zlib';

export interface SampleFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const IMAGE = /^(?:png|jpe?g|gif|webp|heic|heif|avif|bmp|svg)$/;

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

let image: Buffer | undefined; // made once, on the first upload

/**
 * The file a person would pick for a field that takes `accept`: named after `typed` when the persona typed one, its kind from
 * that name's extension, else from what the field accepts (an image when it says nothing).
 */
export function sampleFile(accept: string, typed = ''): SampleFile {
  const tokens = accept.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
  const base = typed.trim().split(/[\\/]/).at(-1)!;
  const [, stem = base, ext = ''] = /^(.+)\.(\w+)$/.exec(base) ?? [];
  const named = ext.toLowerCase();
  const takes = (mime: RegExp, exts: RegExp) => tokens.some((t) => mime.test(t) || (t.startsWith('.') && exts.test(t.slice(1))));
  const kind = named ? (IMAGE.test(named) ? 'image' : named === 'pdf' ? 'pdf' : 'text')
    : tokens.length === 0 || takes(/^image\//, IMAGE) ? 'image' : takes(/^application\/pdf$/, /^pdf$/) ? 'pdf' : 'text';
  if (kind === 'image') return { name: `${stem || 'photo'}.png`, mimeType: 'image/png', buffer: (image ??= png(1600, 900)) };
  if (kind === 'pdf') return { name: `${stem || 'document'}.pdf`, mimeType: 'application/pdf', buffer: pdf() };
  // shortcut: any other kind is a line of plain text under the name asked for (a .docx or .csv a site may parse), upgrade with real samples per format if a target app checks.
  const other = named || tokens.find((t) => t.startsWith('.'))?.slice(1) || 'txt';
  return { name: `${stem || 'notes'}.${other}`, mimeType: 'text/plain', buffer: Buffer.from('Sample notes.\n') };
}
