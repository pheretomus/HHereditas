/**
 * Self-update (desktop app only). At startup the app asks the release feed named in tauri.conf.json
 * (plugins.updater.endpoints, a `latest.json` next to the installers of the newest GitHub release)
 * whether a newer signed build exists; `UpdateDialog` then offers to download, install and relaunch.
 *
 * In the browser build, and whenever the feed cannot be reached (offline, no release yet), there is
 * simply no update: the check never throws to its caller.
 */
import { platform } from '../platform';

export interface AvailableUpdate {
  /** Version of the newest release, e.g. "0.2.0". */
  version: string;
  /** Version of the running app. */
  currentVersion: string;
  /** Release notes, when the release has a body. */
  notes?: string;
  /** Downloads the installer (reporting progress 0–1) and installs it. The app must relaunch afterwards. */
  install: (onProgress?: (fraction: number) => void) => Promise<void>;
}

/** The newer release on the feed, or null when the app is current or the feed is unavailable. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (platform.kind !== 'tauri') return null;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check({ timeout: 15_000 });
    if (!update) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body?.trim() || undefined,
      install: async (onProgress) => {
        let total = 0;
        let received = 0;
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started') {
            total = event.data.contentLength ?? 0;
            received = 0;
          } else if (event.event === 'Progress') {
            received += event.data.chunkLength;
            if (total > 0) onProgress?.(Math.min(1, received / total));
          } else if (event.event === 'Finished') {
            onProgress?.(1);
          }
        });
      },
    };
  } catch (error) {
    console.warn('Update check failed', error);
    return null;
  }
}

/** Quits and starts the newly installed version. */
export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
