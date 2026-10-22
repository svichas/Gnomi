import type { ActionTarget } from '../types.ts';

// Input is Playwright's `ariaSnapshot({ mode: 'ai', boxes: true })`: one node per line,
//   - role "name" [flags] [ref=e5] [cursor=pointer] [box=x,y,w,h]: inline text
// with a node's properties as child lines ("- /url: …", "- text: …") and any key containing ": "
// wrapped in single quotes. Nothing in it says an input is a password, so the caller passes those refs.

const MAX_TEXT = 200;
const KEEP_RUN = 5; // leading siblings of a long run that always stay
const MIN_HIDDEN = 3; // hiding fewer than this costs more tokens (the marker line) than it saves
const CLOSED_RUN = 30; // options of a closed native <select> that always stay: a person who opens it sees them all
const HIDDEN_NAMES = 300; // characters of the labels a longer one hides that its marker still names
const TRUNCATED = '… (truncated)';
// Roles that repeat as items. A run of `generic` wrappers (card grids, div-soup rows) collapses too, unless it holds form fields.
const REPEATED = new Set(['listitem', 'row', 'option', 'article']);
const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'spinbutton', 'slider']);
const TAPPABLE = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);
// Worth showing even with no name or text: an unlabelled button is a finding, not noise.
const CONTROLS = new Set([...TAPPABLE, ...FIELDS, 'option']);

const LINE = /^( *)- (?:'((?:[^']|'')*)'|((?:[^:]|:(?!\s|$))*))(?::(?: (.*))?)?$/;
const NAME = /^(\S+ )"((?:[^"\\]|\\.)*)"/;
const REF = /\[ref=([^\]]+)\]/;
const BOX = /\[box=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/;

interface Line {
  role: string;
  head: string; // role, "name" and [flags], without the YAML quoting
  value?: string; // inline text after ": "
  kids: Line[];
}

interface Printed {
  text: string;
  dist: number; // px from the viewport, 0 when on screen
  parent: number; // index of the enclosing line, -1 at the top
}

interface Options {
  secrets: ReadonlyMap<string, PasswordState>;
  values: ReadonlyMap<string, string>; // aria-valuetext or aria-valuenow of a custom slider or stepper, by ref
  viewportHeight: number;
}

export type PasswordState = 'empty' | 'filled' | 'hidden';

function parse(raw: string): Line[] {
  const root: Line = { role: '', head: '', kids: [] };
  const parents = [root];
  for (const text of raw.split('\n')) {
    const m = LINE.exec(text);
    if (!m) continue;
    const head = m[2]?.replaceAll("''", "'") ?? m[3];
    const line: Line = { role: head.split(' ', 1)[0], head, value: m[4], kids: [] };
    parents.length = Math.min(m[1].length / 2 + 1, parents.length);
    parents.at(-1)!.kids.push(line);
    parents.push(line);
  }
  return root.kids;
}

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s);
const hasField = (line: Line): boolean => FIELDS.has(line.role) || line.kids.some(hasField);
const hasRef = (line: Line): boolean => REF.test(line.head) || line.kids.some(hasRef);
const collapsible = (line: Line) => REPEATED.has(line.role) || (line.role === 'generic' && !hasField(line));

const closedOption = (line: Line) => line.role === 'option' && line.head.includes('[box=0,0,0,0]');

function onScreen(line: Line, viewportHeight: number): boolean {
  const box = BOX.exec(line.head);
  return !!box && +box[2] + +box[4] > 0 && +box[2] < viewportHeight;
}

function keep(line: Line, opts: Options): Line[] {
  let { value, kids } = line;
  const ref = REF.exec(line.head)?.[1];
  const password = ref ? opts.secrets.get(ref) : undefined;
  if (password) {
    // An input's value is inline, or a "- text:" child when it also has a placeholder.
    value = undefined;
    kids = kids.filter((kid) => kid.role !== 'text');
  }
  kids = visit(kids, opts);
  // Playwright refs every element that is visible and takes pointer events, so a link or button without one cannot be
  // tapped: a collapsed menu (pointer-events: none) would otherwise read as open. Keep only what inside it can be.
  if (!ref && TAPPABLE.has(line.role)) return kids.filter(hasRef);
  if (!NAME.test(line.head) && value === undefined && !line.head.includes('[cursor=pointer]')) {
    if (line.role === 'generic') return kids; // a bare wrapper: hoist its children
    if (!kids.length && !CONTROLS.has(line.role)) return [];
  }
  const shown = ref ? opts.values.get(ref) : undefined;
  const head = line.head.replace(NAME, (_, role, name) => `${role}"${clip(name)}"`) + (password ? ` [password: ${password}]` : '') + (shown === undefined ? '' : ` [value=${clip(shown)}]`);
  return [{ role: line.role, head, value: value === undefined ? undefined : clip(value), kids }];
}

function visit(lines: Line[], opts: Options): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < lines.length; ) {
    let run = 1;
    if (collapsible(lines[i])) while (lines[i + run]?.role === lines[i].role && collapsible(lines[i + run])) run++;
    const items = lines.slice(i, i + run);
    // A closed native <select> has no box, so none of its options is on screen, yet a person who opens it sees them all.
    const closed = items.every(closedOption);
    // What the persona can see stays addressable, and so does the selected option: a long <select> must show its value.
    let shown = items.filter((l, k) => k < KEEP_RUN || l.head.includes('[selected]') || onScreen(l, opts.viewportHeight));
    if (items.length - shown.length < MIN_HIDDEN || (closed && run <= CLOSED_RUN)) shown = items;
    for (const line of shown) out.push(...keep(line, opts));
    // A longer one names what it hides, so the persona can select a country it does not see.
    const hidden = closed ? items.filter((l) => !shown.includes(l)).map((l) => NAME.exec(l.head)?.[2] ?? '').join(', ') : '';
    const names = hidden && `: ${hidden.length > HIDDEN_NAMES ? `${hidden.slice(0, HIDDEN_NAMES)}…` : hidden}`;
    if (shown.length < run) out.push({ role: '…', head: `… (×${run - shown.length} more${names})`, kids: [] });
    i += run;
  }
  return out;
}

// A line without a box (a text or /url child, a "… more" marker) sits where the line printed before it does.
// A line with a box off the viewport says so: the persona sees only the screen until it scrolls.
function print(lines: Line[], depth: number, parent: number, viewportHeight: number, out: Printed[]): void {
  for (const line of lines) {
    const tail = line.value !== undefined ? `: ${line.value}` : line.kids.length ? ':' : '';
    const box = BOX.exec(line.head);
    const dist = box ? Math.max(-(+box[2] + +box[4]), +box[2] - viewportHeight, 0) : (out.at(-1)?.dist ?? 0);
    const where = box && dist > 0 ? ` (off screen, ${+box[2] < 0 ? 'above' : 'below'})` : '';
    out.push({ text: `${'  '.repeat(depth)}- ${line.head}${where}${tail}`, dist, parent });
    print(line.kids, depth + 1, out.length - 1, viewportHeight, out);
  }
}

/** The lines within `limit` px of the viewport plus the lines enclosing them, each dropped run marked. */
function render(lines: Printed[], limit: number): string {
  const kept = new Set<number>();
  lines.forEach(({ dist }, i) => {
    if (dist > limit) return;
    for (let j = i; j >= 0 && !kept.has(j); j = lines[j].parent) kept.add(j);
  });
  const out: string[] = [];
  lines.forEach(({ text }, i) => {
    if (kept.has(i)) out.push(text);
    else if (i === 0 || kept.has(i - 1)) out.push(TRUNCATED);
  });
  return out.join('\n');
}

export function pruneSnapshot(
  raw: string,
  { maxChars = 16000, passwordFields = new Map<string, PasswordState>(), values = new Map<string, string>(), viewportHeight = 800 }: { maxChars?: number; passwordFields?: ReadonlyMap<string, PasswordState>; values?: ReadonlyMap<string, string>; viewportHeight?: number } = {},
): string {
  const lines: Printed[] = [];
  print(visit(parse(raw), { secrets: passwordFields, values, viewportHeight }), 0, -1, viewportHeight, lines);
  const text = lines.map((l) => l.text).join('\n');
  if (text.length <= maxChars) return text;
  // Over the cap: drop what lies furthest from the viewport first (tech.md §6.2), so what the persona scrolled to stays.
  const limits = [...new Set(lines.map((l) => l.dist))].sort((a, b) => a - b);
  let best = '';
  for (let lo = 0, hi = limits.length - 1; lo <= hi; ) {
    const mid = (lo + hi) >> 1;
    const capped = render(lines, limits[mid]);
    if (capped.length <= maxChars) [best, lo] = [capped, mid + 1];
    else hi = mid - 1;
  }
  if (best) return best;
  // Even the screen alone is over the cap: cut it from the end.
  const screen = render(lines, limits[0]);
  const cut = screen.lastIndexOf('\n', maxChars - TRUNCATED.length - 1);
  return `${screen.slice(0, Math.max(cut, 0))}\n${TRUNCATED}`;
}

/** Role, accessible name (else its inline text, never a field's value) and box of every ref in a raw snapshot: the evidence for what an action touched. */
export function snapshotTargets(raw: string): Map<string, ActionTarget> {
  const targets = new Map<string, ActionTarget>();
  const walk = (lines: Line[]) => {
    for (const { role, head, value, kids } of lines) {
      const ref = REF.exec(head)?.[1];
      const box = BOX.exec(head);
      if (ref) {
        const name = NAME.exec(head)?.[2];
        const text = FIELDS.has(role) ? '' : clip(value ?? '');
        targets.set(ref, { role, name: name === undefined ? text : JSON.parse(`"${name}"`), box: box ? [+box[1], +box[2], +box[3], +box[4]] : null });
      }
      walk(kids);
    }
  };
  walk(parse(raw));
  return targets;
}
