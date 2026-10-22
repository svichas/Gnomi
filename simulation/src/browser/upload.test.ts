import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleFile } from './upload.ts';

test('a sample file is of the kind the persona named, else the kind the field accepts, an image when it says nothing', () => {
  const pick = (accept: string, typed?: string) => {
    const file = sampleFile(accept, typed);
    return [file.name, file.mimeType];
  };
  assert.deepEqual(pick('image/*'), ['photo.png', 'image/png']);
  assert.deepEqual(pick(''), ['photo.png', 'image/png']);
  assert.deepEqual(pick('.jpg, .jpeg'), ['photo.jpg', 'image/jpeg']);
  assert.deepEqual(pick('image/jpeg', 'me.png'), ['me.jpg', 'image/jpeg']);
  assert.deepEqual(pick('application/pdf'), ['document.pdf', 'application/pdf']);
  assert.deepEqual(pick('.PDF,.doc'), ['document.pdf', 'application/pdf']);
  assert.deepEqual(pick('.csv'), ['notes.csv', 'text/csv']);
  assert.deepEqual(pick('.pdf', 'programme.pdf'), ['programme.pdf', 'application/pdf']);
  assert.deepEqual(pick('image/*', 'C:\\Users\\Eleni\\sunrise.JPG'), ['sunrise.JPG', 'image/jpeg']);
  assert.deepEqual(pick('image/*', 'my cover photo'), ['my cover photo.png', 'image/png']);
  // A kind none can be made of here: one the field takes instead, else no file, never text under a Word document's name.
  assert.deepEqual(pick('.pdf,.doc,.docx', 'cv.docx'), ['cv.pdf', 'application/pdf']);
  assert.deepEqual(pick('', 'cv.docx'), ['cv.pdf', 'application/pdf']);
  for (const accept of ['.docx', 'audio/*']) assert.throws(() => sampleFile(accept), /^Error: unsupported_file$/, accept);
});

test('a JPEG is a 1600×900 baseline JPEG', () => {
  const jpeg = sampleFile('image/jpeg').buffer;
  assert.deepEqual([jpeg[0], jpeg[1], jpeg.at(-2), jpeg.at(-1)], [0xff, 0xd8, 0xff, 0xd9]);
  const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.deepEqual([jpeg.readUInt16BE(frame + 5), jpeg.readUInt16BE(frame + 7)], [900, 1600]);
});

test('the image is a 1600×900 PNG and the PDF a one-page document whose cross-reference table points at its objects', () => {
  const png = sampleFile('image/*').buffer;
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1600, 900]);
  const pdf = sampleFile('.pdf').buffer.toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4\n') && pdf.endsWith('%%EOF\n'));
  const xref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
  assert.ok(pdf.startsWith('xref', xref));
  const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(([, at]) => Number(at));
  assert.deepEqual(offsets.map((at, i) => pdf.startsWith(`${i + 1} 0 obj`, at)), [true, true, true]);
});
