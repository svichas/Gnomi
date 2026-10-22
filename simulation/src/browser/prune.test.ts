import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pruneSnapshot, snapshotTargets } from './prune.ts';

// Fixture strings copy the line shapes Playwright 1.64 really emits.
const lines = (...l: string[]) => l.join('\n');
const jobs = (n: number, top: number) =>
  Array.from({ length: n }, (_, i) =>
    lines(`  - listitem [ref=e${100 + i}] [box=48,${top + i * 18},1224,18]:`, `    - link "Backend engineer ${i}" [ref=e${200 + i}] [cursor=pointer] [box=48,${top + i * 18},127,18]:`, `      - /url: /job/${i}`),
  ).join('\n');

test('collapses a long run of same-role siblings to the first few plus a count', () => {
  const out = pruneSnapshot(lines('- list [ref=e1] [box=8,1000,1264,720]:', jobs(40, 2000)));
  assert.match(out, /- … \(×35 more\)/);
  assert.match(out, /Backend engineer 4"/);
  assert.doesNotMatch(out, /Backend engineer 5"/);
  assert.equal(out.split('\n').filter((l) => l.includes('listitem')).length, 5);
});

test('leaves a short run alone, so no marker line costs more than it saves', () => {
  const out = pruneSnapshot(lines('- list [ref=e1] [box=8,1000,1264,100]:', jobs(7, 2000)));
  assert.doesNotMatch(out, /more\)/);
  assert.equal(out.split('\n').filter((l) => l.includes('listitem')).length, 7);
});

test('keeps what is on screen addressable inside a collapsed run', () => {
  // 40 items from y=700: those below the 800px fold are hidden, those on screen keep their refs.
  const out = pruneSnapshot(lines('- list [ref=e1] [box=8,700,1264,720]:', jobs(40, 700)), { viewportHeight: 800 });
  assert.match(out, /Backend engineer 5"/);
  assert.match(out, /Backend engineer 5" \[ref=e205\]/);
  assert.doesNotMatch(out, /Backend engineer 39"/);
  assert.match(out, /… \(×\d+ more\)/);
});

test('a collapsed <select> still shows its selected option', () => {
  const options = Array.from({ length: 60 }, (_, i) => `  - option "Country ${i}"${i === 41 ? ' [selected]' : ''} [box=0,0,0,0]`).join('\n');
  const out = pruneSnapshot(lines('- combobox "Country" [ref=e1] [box=80,200,84,19]:', options));
  assert.match(out, /option "Country 41" \[selected\]/);
  assert.match(out, /… \(×54 more\)/);
});

test('collapses runs of generic card wrappers, but never a run of form fields', () => {
  const card = (i: number) => lines(`  - generic [ref=e${10 + i}] [cursor=pointer] [box=17,${2000 + i * 100},1246,73]:`, `    - heading "Candidate ${i}" [level=3] [ref=e${300 + i}] [box=17,0,1,1]`);
  const field = (i: number) => lines(`  - generic [ref=e${10 + i}] [box=8,${2000 + i * 22},1264,21]:`, `    - text: Field ${i}`, `    - textbox "Field ${i}" [ref=e${300 + i}] [box=63,0,153,21]`);
  const cards = pruneSnapshot(lines('- main [ref=e1] [box=0,0,1,1]:', ...Array.from({ length: 24 }, (_, i) => card(i))));
  assert.match(cards, /… \(×19 more\)/);
  const form = pruneSnapshot(lines('- main [ref=e1] [box=0,0,1,1]:', ...Array.from({ length: 12 }, (_, i) => field(i))));
  assert.doesNotMatch(form, /more\)/);
  assert.match(form, /textbox "Field 11"/);
});

test('truncates names, values and text over 200 characters', () => {
  const long = 'x'.repeat(500);
  const out = pruneSnapshot(lines(`- link "${long}" [ref=e1] [box=1,2,3,4]:`, `  - /url: https://example.com/${long}`, `- paragraph [ref=e2] [box=1,2,3,4]: ${long}`, `- text: ${long}`, `- link "short" [ref=e3] [box=1,2,3,4]`)).split('\n');
  for (const line of out.slice(0, 4)) {
    assert.ok(line.includes('…'), line.slice(0, 40));
    assert.ok(line.length < 260, `${line.length}`);
  }
  assert.equal(out[4], '- link "short" [ref=e3] [box=1,2,3,4]');
  assert.match(out[0], /^- link "x{200}…" \[ref=e1\] \[box=1,2,3,4\]:$/);
});

test('caps the total size by dropping whole lines from the end', () => {
  const raw = lines('- list [ref=e1] [box=8,1000,1264,720]:', jobs(40, 2000));
  const full = pruneSnapshot(raw);
  const capped = pruneSnapshot(raw, { maxChars: 300 });
  assert.ok(capped.length <= 300, `${capped.length}`);
  assert.ok(capped.endsWith('\n… (truncated)'));
  const kept = capped.split('\n').slice(0, -1);
  assert.deepEqual(kept, full.split('\n').slice(0, kept.length));
  assert.ok(kept.length > 0);
});

test('over the cap, keeps what the persona scrolled to and drops what is furthest from it', () => {
  // Scrolled to the bottom: the top of the page sits far above the viewport, the credits section is on screen.
  const raw = lines(
    '- main [ref=e1] [box=0,-3000,1280,3800]:',
    ...Array.from({ length: 30 }, (_, i) => `  - paragraph [ref=e${10 + i}] [box=0,${-3000 + i * 100},1280,20]: Plan detail ${i}`),
    '  - heading "AI credits" [ref=e2] [box=0,100,1280,28]',
    '  - paragraph [ref=e3] [box=0,140,1280,20]: 5,000 AI credits $0.12/credit',
  );
  const capped = pruneSnapshot(raw, { maxChars: 600 });
  assert.ok(capped.length <= 600, `${capped.length}`);
  assert.match(capped, /^- main \[ref=e1\].*\n… \(truncated\)\n/);
  assert.match(capped, /heading "AI credits"[\s\S]*\$0\.12\/credit$/);
  assert.doesNotMatch(capped, /Plan detail 0\b/);
  assert.match(capped, /Plan detail 29/);
});

test('strips a password value, inline or as a "- text:" child, and nothing else', () => {
  const raw = lines(
    '- textbox "Password" [ref=e24] [box=69,348,153,21]: hunter2-secret',
    '- textbox "Confirm" [ref=e25] [box=69,370,153,21]:',
    '  - /placeholder: Repeat it',
    '  - text: hunter2-secret',
    '- textbox "Job title" [ref=e26] [box=59,327,153,21]: Backend engineer',
  );
  const out = pruneSnapshot(raw, { passwordFields: new Map([['e24', 'filled'], ['e25', 'filled']]) });
  assert.doesNotMatch(out, /hunter2/);
  assert.match(out, /- textbox "Password" \[ref=e24\] \[box=69,348,153,21\] \[password: filled\]$/m);
  assert.match(out, /- textbox "Confirm" \[ref=e25\] \[box=69,370,153,21\] \[password: filled\]:\n {2}- \/placeholder: Repeat it/);
  assert.match(out, /textbox "Job title" \[ref=e26\] \[box=59,327,153,21\]: Backend engineer/);
});

test('password state distinguishes empty, filled and unreadable fields without exposing their values', () => {
  const out = pruneSnapshot(lines(
    '- textbox "New password" [ref=e1]',
    '- textbox "Filled" [ref=e2]: secret-canary',
    '- textbox "Unreadable" [ref=e3]: another-canary',
  ), { passwordFields: new Map([['e1', 'empty'], ['e2', 'filled'], ['e3', 'hidden']]) });
  assert.match(out, /"New password" \[ref=e1\] \[password: empty\]/);
  assert.match(out, /"Filled" \[ref=e2\] \[password: filled\]/);
  assert.match(out, /"Unreadable" \[ref=e3\] \[password: hidden\]/);
  assert.doesNotMatch(out, /canary/);
});

test('prints the value of a custom slider or stepper the caller read, and none for other lines', () => {
  const out = pruneSnapshot(lines(
    '- slider "Group size" [ref=e1]: ●',
    '- slider "Price" [ref=e2]',
    '- slider [ref=e3]',
    '- button "Save" [ref=e4]',
  ), { values: new Map([['e1', '5'], ['e2', '€80'], ['e3', '30']]) });
  assert.match(out, /^- slider "Group size" \[ref=e1\] \[value=5\]: ●$/m);
  assert.match(out, /^- slider "Price" \[ref=e2\] \[value=€80\]$/m);
  assert.match(out, /^- slider \[ref=e3\] \[value=30\]$/m);
  assert.match(out, /^- button "Save" \[ref=e4\]$/m);
});

test('drops lines that carry nothing, but keeps an unlabelled control', () => {
  const out = pruneSnapshot(
    lines(
      '- main [ref=e1] [box=0,0,9,9]:',
      '  - paragraph [ref=e2] [box=0,0,1,1]',
      '  - list [ref=e3] [box=0,0,1,1]:',
      '    - listitem [ref=e4] [box=0,0,1,1]',
      '  - button [ref=e5] [box=72,460,16,6]',
      '  - heading "Title" [level=1] [ref=e6] [box=0,0,1,1]',
    ),
  );
  assert.equal(out, lines('- main [ref=e1] [box=0,0,9,9]:', '  - button [ref=e5] [box=72,460,16,6]', '  - heading "Title" [level=1] [ref=e6] [box=0,0,1,1]'));
});

test('hoists bare generic wrappers, keeping clickable and text-bearing ones', () => {
  const out = pruneSnapshot(
    lines(
      '- generic [active] [ref=e1] [box=8,8,1,1]:',
      '  - generic [ref=e2] [box=8,8,1,1]:',
      '    - text: Job title',
      '    - textbox "Job title" [ref=e3] [box=8,8,1,1]',
      '  - generic [ref=e4] [cursor=pointer] [box=8,8,1,1]:',
      '    - heading "Card" [level=3] [ref=e5] [box=8,8,1,1]',
      '  - generic [ref=e6] [box=8,8,1,1]: Senior Engineer Berlin',
    ),
  );
  assert.equal(
    out,
    lines(
      '- text: Job title',
      '- textbox "Job title" [ref=e3] [box=8,8,1,1]',
      '- generic [ref=e4] [cursor=pointer] [box=8,8,1,1]:',
      '  - heading "Card" [level=3] [ref=e5] [box=8,8,1,1]',
      '- generic [ref=e6] [box=8,8,1,1]: Senior Engineer Berlin',
    ),
  );
});

test('unquotes keys Playwright wraps in single quotes and keeps refs and boxes intact', () => {
  const raw = lines(`- 'link "Save: now" [ref=e4] [cursor=pointer] [box=8,46,116,18]':`, '  - /url: /x', `- 'button "It''s: here" [ref=e5] [box=1,2,3,4]'`, '- paragraph [ref=e6] [box=1,2,3,4]: "We use cookies: accept?"');
  assert.equal(
    pruneSnapshot(raw),
    lines('- link "Save: now" [ref=e4] [cursor=pointer] [box=8,46,116,18]:', '  - /url: /x', `- button "It's: here" [ref=e5] [box=1,2,3,4]`, '- paragraph [ref=e6] [box=1,2,3,4]: "We use cookies: accept?"'),
  );
});

test('snapshotTargets reads role, accessible name and box per ref', () => {
  const targets = snapshotTargets(
    lines('- main [ref=e1] [box=8,47,1264,237]:', `  - 'button "Say \\"hi\\": now" [ref=e2] [box=1.5,2,3,4]'`, '  - option "Design" [selected] [box=0,0,0,0]', '  - img [ref=e3]'),
  );
  assert.deepEqual(targets.get('e1'), { role: 'main', name: '', box: [8, 47, 1264, 237] });
  assert.deepEqual(targets.get('e2'), { role: 'button', name: 'Say "hi": now', box: [1.5, 2, 3, 4] });
  assert.deepEqual(targets.get('e3'), { role: 'img', name: '', box: null });
  assert.equal(targets.size, 3);
});

test('snapshotTargets names an unlabelled target by its inline text, never by a field value', () => {
  const targets = snapshotTargets(lines('- listitem [ref=e1] [cursor=pointer] [box=48,466,379,37]: 101 - 200 employees', '- textbox [ref=e2] [box=1,2,3,4]: hunter2-secret'));
  assert.equal(targets.get('e1')?.name, '101 - 200 employees');
  assert.equal(targets.get('e2')?.name, '');
});

test('marks lines off the viewport as off screen, above or below, and leaves what is on screen alone', () => {
  const out = pruneSnapshot(lines(
    '- heading "Top" [ref=e1] [box=0,-200,100,40]',
    '- button "Save" [ref=e2] [box=0,100,80,40]',
    '- link "Pricing" [ref=e3] [box=0,1200,80,20]:',
    '  - /url: /pricing',
  ), { viewportHeight: 800 });
  assert.equal(out, lines(
    '- heading "Top" [ref=e1] [box=0,-200,100,40] (off screen, above)',
    '- button "Save" [ref=e2] [box=0,100,80,40]',
    '- link "Pricing" [ref=e3] [box=0,1200,80,20] (off screen, below):',
    '  - /url: /pricing',
  ));
});

test('drops a link or button Playwright gave no ref, as in a collapsed menu, keeping any ref inside it', () => {
  // Line shapes from a real marketing site on a phone: the closed menu's links are pointer-events: none, so they carry no ref.
  const out = pruneSnapshot(lines(
    '- navigation [box=0,90,393,0]:',
    '  - button "menu button" [ref=e14] [cursor=pointer] [box=359,114,18,18]',
    '  - link "Pricing" [box=54,486,345,48]:',
    '    - /url: /pricing',
    '  - button "Flip card back" [box=24,500,0,272]:',
    '    - generic [ref=e178] [cursor=pointer] [box=34,510,24,24]',
  ));
  assert.equal(out, lines(
    '- navigation [box=0,90,393,0]:',
    '  - button "menu button" [ref=e14] [cursor=pointer] [box=359,114,18,18]',
    '  - generic [ref=e178] [cursor=pointer] [box=34,510,24,24]',
  ));
});
