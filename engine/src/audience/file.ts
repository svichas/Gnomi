// An audience kept in a file for the CLI: the app's saved-audience shape (app/src/audiences.ts) plus the personas written
// from it and the product they were written for, so a run reuses them for as long as they are current.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { validateCountries } from '@gnomi/simulation/audience/locations.ts';
import { validatePersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import type { Audience, Persona, PersonaSchema } from '@gnomi/simulation/types.ts';

export interface AudienceFile {
  id: string;
  name: string;
  savedAt: number;
  audience: Audience;
  schema: PersonaSchema;
  product: { name: string; description: string; goal: string }; // what the personas were written for
  personas: Persona[];
}

/** Reads and checks an audience file; anything that is not one is an error, so writing over it is never silent. */
export function readAudienceFile(path: string): AudienceFile {
  let file: AudienceFile;
  try {
    file = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} could not be read as an audience file: ${err instanceof Error ? err.message : err}`);
  }
  const bad = (what: string) => new Error(`${path} is not an audience file: ${what}.`);
  if (!file || typeof file !== 'object') throw bad('it holds no object');
  if (!file.audience || !Array.isArray(file.audience.segments) || !file.audience.segments.length) throw bad('its audience has no segments');
  const { product } = file;
  if (!product || typeof product.name !== 'string' || typeof product.description !== 'string' || typeof product.goal !== 'string') throw bad('it does not name the product');
  if (!Array.isArray(file.personas) || file.personas.some((p) => !p || typeof p.id !== 'string' || typeof p.segment_id !== 'string')) throw bad('its personas are not a list of personas');
  validateCountries(file.audience.countries);
  validatePersonaSchema(file.schema);
  return file;
}

// Written beside and renamed over, so a crash mid-write leaves the previous file whole.
export function writeAudienceFile(path: string, file: AudienceFile): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
