import type { z } from 'zod';

// Gnomi's records and reports are in English whatever a persona's first language, and some models (DeepSeek) drift into
// that language anyway. A letter of another script (Han, Cyrillic, Greek…) fails validation, so the gateway asks again.
const FOREIGN = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u;
const QUOTED = /"[^"]*"|“[^”]*”/g;

/** How prompts ask for it. */
export const ENGLISH = 'English, in Latin letters, quoting any on-screen text in another script in double quotes';

/** Free text a model writes: English in Latin letters, except on-screen text quoted in double quotes. */
export const isEnglish = (text: string) => !FOREIGN.test(text.replace(QUOTED, ''));
export const english = (s: z.ZodString) => s.refine(isEnglish, `must be in ${ENGLISH}`);

/** A name or profile field: Latin letters only, with no quoted exception. */
export const latin = (s: z.ZodString) => s.refine((v) => !FOREIGN.test(v), 'must be in English, in Latin letters: romanize a name from another script');
