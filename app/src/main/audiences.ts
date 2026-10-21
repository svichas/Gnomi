import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Audience } from '@gnomi/simulation/types.ts';
import { checkSavedAudience, type SavedAudience } from '@gnomi/engine/audience/file.ts';

const MAX_BYTES = 1_000_000;

/** Saved audiences, newest first, in one JSON file beside the project library. What the page sends is checked here. */
export class AudienceLibrary {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  list(): SavedAudience[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    // Unreadable is an error rather than empty, so the next save cannot overwrite what is there.
    let saved: unknown;
    try { saved = JSON.parse(text); } catch { saved = null; }
    if (!Array.isArray(saved)) throw new Error(`Saved audiences could not be read. Fix or remove ${this.file}.`);
    return saved;
  }

  /** Saving under a name already in the library replaces that audience. */
  save(name: unknown, audience: unknown, schema: unknown): SavedAudience {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Give the audience a name of 1–80 characters.');
    const value = audience as Audience;
    checkSavedAudience(value, schema, 'Only an audience with segments can be saved.');
    const list = this.list();
    const same = list.find((entry) => entry.name.toLowerCase() === name.trim().toLowerCase());
    const entry: SavedAudience = { id: same?.id ?? randomUUID(), name: name.trim(), savedAt: Date.now(), audience: value, schema };
    if (JSON.stringify(entry).length > MAX_BYTES) throw new Error('This audience is too large to save.');
    this.write([entry, ...list.filter((other) => other !== same)]);
    return entry;
  }

  remove(id: unknown): SavedAudience[] {
    const list = this.list().filter((entry) => entry.id !== id);
    this.write(list);
    return list;
  }

  // Written beside and renamed over, so a crash mid-write leaves the previous file whole.
  private write(list: SavedAudience[]) {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(list));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
