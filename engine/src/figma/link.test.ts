import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FigmaError } from './client.ts';
import { parseFigmaLink } from './link.ts';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv';

test('file, design, proto and branch links give the file key, and the frame in node-id as the API writes it', () => {
  assert.deepEqual(parseFigmaLink(`https://www.figma.com/design/${KEY}/Acme-checkout?node-id=12-345&t=abc-1`), { key: KEY, node: '12:345' });
  assert.deepEqual(parseFigmaLink(`https://www.figma.com/file/${KEY}/Acme?type=design&node-id=1%3A2&mode=design`), { key: KEY, node: '1:2' });
  assert.deepEqual(parseFigmaLink(`  https://figma.com/design/${KEY}  `), { key: KEY, node: null });
  assert.deepEqual(parseFigmaLink(`figma.com/proto/${KEY}/Flow?node-id=3-4&starting-point-node-id=3-4`), { key: KEY, node: '3:4' });
  assert.deepEqual(parseFigmaLink(`https://www.figma.com/design/${KEY}/branch/BrAnChKeY0123456789ab/Acme?node-id=5-6`), { key: 'BrAnChKeY0123456789ab', node: '5:6' }, 'a branch is read as its own file');
  assert.equal(parseFigmaLink(`https://www.figma.com/design/${KEY}/x?node-id=I5666-180910%3B1-10515`).node, null, 'a layer inside an instance is not a frame id');
});

test('anything else is a malformed link with a sentence that says what to paste', () => {
  const bad = (text: string, message: RegExp) =>
    assert.throws(() => parseFigmaLink(text), (err) => err instanceof FigmaError && err.kind === 'bad_link' && message.test(err.message), text);
  bad('', /Paste a link/);
  bad('   ', /Paste a link/);
  bad('hello there', /not a Figma link/);
  bad(`https://evil.example/design/${KEY}/x`, /not a Figma link/);
  bad(`https://figma.com.evil.example/design/${KEY}/x`, /not a Figma link/);
  bad(`javascript:alert(1)//figma.com/design/${KEY}`, /not a Figma link/);
  bad('https://www.figma.com/', /does not point at a design file/);
  bad('https://www.figma.com/files/recent', /does not point at a design file/);
  bad('https://www.figma.com/design/', /does not point at a design file/);
  bad(`https://www.figma.com/board/${KEY}/Brainstorm`, /FigJam board/);
  bad(`https://www.figma.com/slides/${KEY}/Deck`, /Slides/);
  bad('https://www.figma.com/design/short/x', /no file key/);
  bad(`https://www.figma.com/design/${KEY}%2F..%2F/x`, /no file key/);
});
