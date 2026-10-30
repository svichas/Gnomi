// Real data behind a segment. Source files are read once and never copied into a project, because project copies carry assets/ unredacted.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { GroundingSource } from '@gnomi/simulation/types.ts';

/** What a segment keeps of a file: its basename and the hash of its bytes. */
export const sourceOf = (path: string, data: Uint8Array): GroundingSource => ({ name: basename(path), sha256: createHash('sha256').update(data).digest('hex') });
