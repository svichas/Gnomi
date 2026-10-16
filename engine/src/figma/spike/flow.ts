// M5 spike (docs/figma-prototype-spike.md): turns the JSON of GET /v1/files/:key into a click-through model, the screens a persona
// can reach from each flow's starting point, with hotspot boxes and what a click does. Throwaway: nothing in product code imports
// this, and it was written against the documented REST schema and a hand-built fixture, never run on a real file.

/** [x, y, width, height] in frame pixels, the same tuple the engine uses for click targets. */
export type Box = [x: number, y: number, width: number, height: number];
export type Vec = { x: number; y: number };

// The part of the REST node schema this reads (developers.figma.com/docs/rest-api/file-node-types and file-property-types).
type FigmaAction = { type: string; destinationId?: string | null; navigation?: string; transition?: { type: string } | null; overlayRelativePosition?: Vec; url?: string; conditionalBlocks?: { actions: FigmaAction[] }[] };
type FigmaInteraction = { trigger: { type: string; timeout?: number } | null; actions: FigmaAction[] };
export type FigmaNode = {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  interactions?: FigmaInteraction[];
  scrollBehavior?: string;
  overflowDirection?: string;
  flowStartingPoints?: { nodeId: string; name: string }[];
};
export type FigmaFile = { name: string; document: FigmaNode };

type Conditional = { conditional?: true };
export type Action = Conditional &
  (
    | { kind: 'navigate' | 'swap' | 'overlay' | 'scroll_to'; to: string; transition: string | null; at: Vec | null }
    | { kind: 'back' | 'close' }
    | { kind: 'link'; url: string }
  );
export type Trigger = 'click' | 'press' | 'hover' | 'drag' | 'timeout' | 'key' | 'media' | 'other';
/** One interaction on one layer. `actions` is empty when the file wires the layer to something this cannot play (it is still tappable). */
export type Hotspot = { id: string; name: string; box: Box; fixed: boolean; trigger: Trigger; ms: number | null; actions: Action[] };
export type Screen = { id: string; name: string; size: [width: number, height: number]; scroll: 'none' | 'vertical' | 'horizontal' | 'both'; hotspots: Hotspot[] };
/** What the file does that the model drops: a Figma action type (CHANGE_TO, SET_VARIABLE, CONDITIONAL...) or MISSING_DESTINATION. `at` is the layer. */
export type Unsupported = { at: string; kind: string };
export type Prototype = { page: string; flows: { name: string; start: string }[]; screens: Record<string, Screen>; unsupported: Unsupported[] };

const TRIGGERS: Record<string, Trigger> = {
  ON_CLICK: 'click', ON_PRESS: 'press', MOUSE_DOWN: 'press', MOUSE_UP: 'press', ON_HOVER: 'hover', MOUSE_ENTER: 'hover', MOUSE_LEAVE: 'hover',
  ON_DRAG: 'drag', AFTER_TIMEOUT: 'timeout', ON_KEY_DOWN: 'key', ON_KEY_UP: 'key', ON_MEDIA_HIT: 'media', ON_MEDIA_END: 'media',
};
const NAVIGATION: Partial<Record<string, 'navigate' | 'swap' | 'overlay' | 'scroll_to'>> = { NAVIGATE: 'navigate', SWAP: 'swap', OVERLAY: 'overlay', SCROLL_TO: 'scroll_to' };
const SCROLL = { HORIZONTAL_SCROLLING: 'horizontal', VERTICAL_SCROLLING: 'vertical', HORIZONTAL_AND_VERTICAL_SCROLLING: 'both' } as const;

/** The prototype of every page that has a flow starting point; pages without one are not prototypes. */
export function parseFile(file: FigmaFile): Prototype[] {
  if (file?.document?.type !== 'DOCUMENT') throw new Error('not a Figma file response: no DOCUMENT node');
  return (file.document.children ?? []).filter((page) => page.type === 'CANVAS' && page.flowStartingPoints?.length).map(parsePage);
}

function parsePage(page: FigmaNode): Prototype {
  const byId = new Map<string, FigmaNode>();
  const index = (node: FigmaNode) => (byId.set(node.id, node), node.children?.forEach(index));
  index(page);
  const flows = (page.flowStartingPoints ?? []).map((f) => ({ name: f.name, start: f.nodeId }));
  const unsupported: Unsupported[] = [];
  const queue = flows.map((f) => f.start);
  const screens: Record<string, Screen> = {};

  const actionsOf = (list: FigmaAction[], at: string, conditional?: true): Action[] =>
    list.flatMap((a): Action[] => {
      const flag: Conditional = conditional ? { conditional } : {};
      switch (a.type) {
        case 'BACK':
        case 'CLOSE':
          return [{ kind: a.type === 'BACK' ? 'back' : 'close', ...flag }];
        case 'URL':
          return a.url ? [{ kind: 'link', url: a.url, ...flag }] : [];
        case 'NODE': {
          const kind = NAVIGATION[a.navigation ?? ''];
          if (!kind) return unsupported.push({ at, kind: a.navigation ?? 'NODE' }), []; // CHANGE_TO: a component state, not a screen
          if (!a.destinationId) return [];
          if (!byId.has(a.destinationId)) return unsupported.push({ at, kind: 'MISSING_DESTINATION' }), [];
          if (kind !== 'scroll_to') queue.push(a.destinationId);
          return [{ kind, to: a.destinationId, transition: a.transition?.type ?? null, at: a.overlayRelativePosition ?? null, ...flag }];
        }
        case 'CONDITIONAL': // Conditions need variable values this cannot read (Enterprise-only); keep every branch, marked.
          unsupported.push({ at, kind: a.type });
          return (a.conditionalBlocks ?? []).flatMap((block) => actionsOf(block.actions, at, true));
        default:
          return unsupported.push({ at, kind: a.type }), [];
      }
    });

  // shortcut: boxes are not clipped by ancestors with clipsContent, nor adjusted for rotation (absoluteBoundingBox is the axis-aligned
  // box); upgrade when a real file shows hotspots that are not visible in the exported frame.
  const screenOf = (frame: FigmaNode, origin: NonNullable<FigmaNode['absoluteBoundingBox']>): Screen => {
    const hotspots: Hotspot[] = [];
    const walk = (node: FigmaNode, fixed: boolean) => {
      if (node.visible === false) return;
      fixed ||= node.scrollBehavior === 'FIXED';
      const b = node.absoluteBoundingBox;
      for (const i of b ? (node.interactions ?? []) : []) {
        const box: Box = [b!.x - origin.x, b!.y - origin.y, b!.width, b!.height];
        hotspots.push({ id: node.id, name: node.name, box, fixed, trigger: TRIGGERS[i.trigger?.type ?? ''] ?? 'other', ms: i.trigger?.timeout ?? null, actions: actionsOf(i.actions, node.id) });
      }
      node.children?.forEach((child) => walk(child, fixed));
    };
    walk(frame, false);
    const scroll = SCROLL[frame.overflowDirection as keyof typeof SCROLL] ?? 'none';
    return { id: frame.id, name: frame.name, size: [origin.width, origin.height], scroll, hotspots };
  };

  for (const id of queue) {
    if (screens[id]) continue;
    const node = byId.get(id);
    if (!node?.absoluteBoundingBox) unsupported.push({ at: id, kind: 'MISSING_DESTINATION' });
    else screens[id] = screenOf(node, node.absoluteBoundingBox);
  }
  return { page: page.name, flows, screens, unsupported };
}
