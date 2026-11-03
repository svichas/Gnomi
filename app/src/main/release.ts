export const LATEST_RELEASE_API = 'https://api.github.com/repos/svichas/Gnomi/releases/latest';
export const RELEASES_PAGE = 'https://github.com/svichas/Gnomi/releases/latest';

/** The latest release's version when its tag (such as "v0.3.0") is ahead of this build, else null. */
export function newerRelease(tag: unknown, current: string): string | null {
  if (typeof tag !== 'string') return null;
  const parse = (version: string) => version.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const latest = parse(tag);
  const mine = parse(current);
  if (latest.some(Number.isNaN)) return null;
  for (let i = 0; i < Math.max(latest.length, mine.length); i++) {
    const diff = (latest[i] ?? 0) - (mine[i] ?? 0);
    if (diff) return diff > 0 ? tag.replace(/^v/, '') : null;
  }
  return null;
}
