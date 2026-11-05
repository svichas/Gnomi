import { createAvatar } from '@dicebear/core';
import * as lorelei from '@dicebear/lorelei';
import type { Persona } from '@gnomi/simulation/types.ts';

const numbered = (prefix: string, numbers: number[]) => numbers.map((n) => `${prefix}${String(n).padStart(2, '0')}`);
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

// Lorelei's hair sorted by eye into longer and shorter styles; the few that read either way are in both, and 'they' draws from all.
export const HAIR = {
  she: numbered('variant', [10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 26, 29, 30, 31, 32, 33, 35, 37, 38, 40, 41, 42, 43, 45, 46, 48]),
  he: numbered('variant', [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 20, 22, 25, 27, 28, 34, 36, 39, 43, 44, 47]),
  they: numbered('variant', upTo(48)),
} as Record<Persona['pronouns'], lorelei.Options['hair']>;
const LOOK = {
  she: { beardProbability: 0, earringsProbability: 40 },
  he: { beardProbability: 35, earringsProbability: 5 },
  they: { beardProbability: 10, earringsProbability: 20 },
};
const SMILES = numbered('happy', upTo(18)) as lorelei.Options['mouth']; // Lorelei's other mouths are sad
const faces = new Map<string, string>();

/**
 * A persona's face, drawn here rather than fetched, the same in every view and on the swarm graph. The seed is id and name
 * together, since slot ids repeat across audiences; the pronouns the run used (usedPronouns) pick the hair and how often a beard shows.
 */
export function personaFace(id: string, name: string, pronouns: Persona['pronouns'] = 'they'): string {
  const key = `${pronouns}:${id}:${name}`;
  let face = faces.get(key);
  if (!face) faces.set(key, (face = createAvatar(lorelei, {
    seed: `${id}:${name}`,
    size: 96, // a fixed pixel size for the graph's image layer; pages scale it with CSS
    hair: HAIR[pronouns],
    ...LOOK[pronouns],
    glasses: ['variant01', 'variant03', 'variant04', 'variant05'], // variant02 is sunglasses
    mouth: SMILES,
  }).toDataUri().replaceAll('(', '%28').replaceAll(')', '%29'))); // the SVG's own url(#mask) must not read as a fetch in the HTML export
  return face;
}
