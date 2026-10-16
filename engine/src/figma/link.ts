import { FigmaError } from './client.ts';

/** A file key and, when the link points at a layer, its node id ("1:2"). The link itself is never requested: only the REST API is. */
export interface FigmaLink {
  key: string;
  node: string | null;
}

export const FILE_KEY = /^[A-Za-z0-9]{10,64}$/;
export const NODE_ID = /^\d+:\d+$/;

const KINDS = new Set(['file', 'design', 'proto']);
const OTHER: Record<string, string> = { board: 'a FigJam board', slides: 'a Figma Slides deck', make: 'a Figma Make file' };
const HELP = 'Copy it from Figma with Share → Copy link, or right-click a frame → Copy link to selection.';

/**
 * The key and node of a pasted Figma link: figma.com/design/<key>/<name>?node-id=1-2, the older /file/ form, /proto/ links,
 * and branches (/design/<key>/branch/<branchKey>/<name>, where the branch's own key is the file to read).
 */
export function parseFigmaLink(text: string): FigmaLink {
  const raw = text.trim();
  if (!raw) throw new FigmaError('bad_link', `Paste a link to a Figma file or frame. ${HELP}`);
  const url = URL.canParse(raw) ? new URL(raw) : URL.canParse(`https://${raw}`) ? new URL(`https://${raw}`) : null;
  if (!url || !/^https?:$/.test(url.protocol) || !/^(www\.)?figma\.com$/.test(url.hostname)) throw new FigmaError('bad_link', `That is not a Figma link. ${HELP}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const [kind, key] = parts;
  if (kind && Object.hasOwn(OTHER, kind)) throw new FigmaError('bad_link', `That link is ${OTHER[kind]}. Gnomi imports frames from Figma design files.`);
  if (!KINDS.has(kind) || !key) throw new FigmaError('bad_link', `That Figma link does not point at a design file. ${HELP}`);
  const file = parts[2] === 'branch' && parts[3] ? parts[3] : key;
  if (!FILE_KEY.test(file)) throw new FigmaError('bad_link', `That Figma link has no file key Gnomi can read. ${HELP}`);
  const id = url.searchParams.get('node-id')?.replace('-', ':') ?? ''; // the page writes 1-2, the API wants 1:2
  return { key: file, node: NODE_ID.test(id) ? id : null };
}
