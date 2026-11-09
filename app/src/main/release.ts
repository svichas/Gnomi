import type { AppUpdater } from 'electron-updater';

export const RELEASES_PAGE = 'https://github.com/svichas/Gnomi/releases/latest';

/**
 * Where the check for a newer release stands. `ready` installs on restart or quit; `available` is one this build cannot
 * install itself, so RELEASES_PAGE offers it; `failed` is offline or a broken check.
 */
export type UpdateState =
  | { status: 'checking' | 'current' | 'failed' }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready' | 'available'; version: string };

/**
 * Checks GitHub for a newer release and downloads it, unless the updater's autoDownload is off, reporting each step on
 * the way to the state it returns. `installable` settles once the platform accepts the download: Squirrel.Mac checks
 * the code signature only after electron-updater's download resolves.
 */
export async function fetchUpdate(updater: Pick<AppUpdater, 'checkForUpdates' | 'on' | 'off'>, installable: () => Promise<unknown>, report: (state: UpdateState) => void): Promise<UpdateState> {
  const end = (state: UpdateState) => { report(state); return state; };
  let version: string | undefined;
  report({ status: 'checking' });
  try {
    const result = await updater.checkForUpdates();
    if (!result) return end({ status: 'failed' }); // an inactive updater: a build without release information
    if (!result.isUpdateAvailable) return end({ status: 'current' });
    version = result.updateInfo.version;
    if (!result.downloadPromise) return end({ status: 'available', version }); // a build that cannot install it: the download page
    const progress = ({ percent }: { percent: number }) => report({ status: 'downloading', version: result.updateInfo.version, percent });
    updater.on('download-progress', progress);
    progress({ percent: 0 });
    try { await Promise.all([result.downloadPromise, installable()]); } finally { updater.off('download-progress', progress); }
    return end({ status: 'ready', version });
  } catch {
    return end(version ? { status: 'available', version } : { status: 'failed' }); // a failed download: the download page
  }
}
