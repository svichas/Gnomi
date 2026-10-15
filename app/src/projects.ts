import type { ProjectInfo } from '@gnomi/engine/protocol.ts';

export interface ProjectEntry {
  id: string;
  name: string;
  updatedAt: number;
  configured: boolean;
  canDelete: boolean;
}

export interface ProjectCatalog {
  projects: ProjectEntry[];
  currentId: string;
}

export type ProjectAction =
  | { action: 'create'; name: string }
  | { action: 'open' | 'delete' | 'export'; id: string }
  | { action: 'rename' | 'duplicate'; id: string; name: string };

export interface ProjectActionResult {
  catalog: ProjectCatalog;
  project: ProjectInfo | null;
  exportedTo?: string;
  canceled?: boolean;
}
