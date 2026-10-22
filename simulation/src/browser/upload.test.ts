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
  assert.deepEqual(pick('.jpg, .jpeg'), ['photo.png', 'image/png']);
  assert.deepEqual(pick('application/pdf'), ['document.pdf', 'application/pdf']);
  assert.deepEqual(pick('.PDF,.doc'), ['document.pdf', 'application/pdf']);
  assert.deepEqual(pick('.csv'), ['notes.csv', 'text/plain']);
  assert.deepEqual(pick('.pdf', 'programme.pdf'), ['programme.pdf', 'application/pdf']);
  assert.deepEqual(pick('image/*', 'C:\\Users\\Eleni\\sunrise.JPG'), ['sunrise.png', 'image/png']);
  assert.deepEqual(pick('image/*', 'my cover photo'), ['my cover photo.png', 'image/png']);
  assert.deepEqual(pick('', 'cv.docx'), ['cv.docx', 'text/plain']);
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
