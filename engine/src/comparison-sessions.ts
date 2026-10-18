import type { ProjectConfig, SessionInfo, WebPoi } from '@gnomi/simulation/types.ts';

/** The target binding limits both login recording and verification to that target's permitted full-mode sources. */
export function comparisonSessionPois(config: ProjectConfig, target_id: string, role?: string): WebPoi[] {
  const target = config.comparison?.targets.find((target) => target.id === target_id);
  if (!target) throw new Error('Choose a configured comparison tool before recording its login.');
  if (target.access_scope !== 'authenticated_workflow') throw new Error('This comparison tool is not configured for an authenticated workflow.');
  if (role !== undefined && target.session_role !== role) throw new Error('The login name must match this comparison tool’s configured login.');
  const pois = config.pois.filter((poi): poi is WebPoi => target.poi_ids.includes(poi.id) && poi.type === 'web' && poi.mode === 'full');
  if (!pois.length) throw new Error('This comparison tool needs a full-access web source to record a login.');
  return pois;
}

export function comparisonSessionTarget(config: ProjectConfig, session: SessionInfo): string {
  const target = config.comparison?.targets.find((target) => target.session_role === session.role);
  if (!target || session.target_id !== target.id) throw new Error('This login is not bound to the comparison tool. Record a separate login in the tool’s comparison setup.');
  return target.id;
}
