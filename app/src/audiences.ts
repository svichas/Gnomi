import type { Audience, PersonaSchema } from '@gnomi/simulation/types.ts';

/** An audience kept outside any project, for other projects to start from. Personas stay behind: they are written for one product. */
export interface SavedAudience {
  id: string;
  name: string;
  savedAt: number;
  audience: Audience;
  schema: PersonaSchema;
}
