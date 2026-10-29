/**
 * "A new version is available" alert. Checks the release feed once when the app starts (desktop
 * build only) and offers to install the update and relaunch. "Later" keeps the running version; the
 * next launch asks again.
 */
import { Dialog } from '@hhereditas/ui';
import { useEffect, useState } from 'react';
import { checkForUpdate, relaunchApp, type AvailableUpdate } from '../../app/updater';
import { useApp } from '../../state/store';

export function UpdateDialog() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void checkForUpdate().then((found) => {
      if (!cancelled && found) setUpdate(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const install = async () => {
    if (!update || installing) return;
    setInstalling(true);
    setProgress(0);
    try {
      await update.install(setProgress);
      await relaunchApp();
    } catch (error) {
      setInstalling(false);
      useApp.getState().flash(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const percent = Math.round(progress * 100);
  const message = installing
    ? `Downloading and installing… ${percent}%`
    : [
        `You have version ${update?.currentVersion ?? ''}. Install the update now? The app restarts when it is done.`,
        update?.notes ? `\n\n${update.notes}` : '',
      ].join('');

  return (
    <Dialog
      open={!!update}
      onOpenChange={(o) => {
        if (!o && !installing) setUpdate(null);
      }}
      title={`HHereditas ${update?.version ?? ''} is available`}
      message={message}
      primaryAction={{ label: 'Install and Relaunch', onAction: () => void install(), loading: installing }}
      secondaryAction={{ label: 'Later', disabled: installing }}
      width={300}
    />
  );
}
