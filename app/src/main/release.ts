import type { AppUpdater } from 'electron-updater';

export const RELEASES_PAGE = 'https://github.com/svichas/Gnomi/releases/latest';

/** A newer release: ready when it is downloaded and installs on restart or quit, else the page links to RELEASES_PAGE. */
export type Release = { version: string; ready: boolean };

/**
 * Checks GitHub for a newer release and downloads it, unless the updater's autoDownload is off. `installable` settles once
 * the platform accepts the download: Squirrel.Mac checks the code signature only after electron-updater's download resolves.
 */
export async function fetchUpdate(updater: Pick<AppUpdater, 'checkForUpdates'>, installable: () => Promise<unknown>): Promise<Release | null> {
  let version: string | undefined;
  try {
    const result = await updater.checkForUpdates();
    if (!result?.isUpdateAvailable) return null;
    version = result.updateInfo.version;
    if (!result.downloadPromise) return { version, ready: false }; // a build that cannot install it: the download page
    await Promise.all([result.downloadPromise, installable()]);
    return { version, ready: true };
  } catch {
    return version ? { version, ready: false } : null; // offline: no banner; a failed download: the download page
  }
}
