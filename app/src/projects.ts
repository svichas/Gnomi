import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import type { RunRow } from '@gnomi/simulation/types.ts';

export interface ProjectEntry {
  id: string;
  name: string;
  updatedAt: number;
  configured: boolean;
  canDelete: boolean;
}

/** A saved run listed with the project it belongs to; run IDs are only unique within a project. */
export type WorkspaceRun = RunRow & { project_id: string; project_name: string };

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
