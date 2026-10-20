import { autoUpdater } from 'electron-updater';
import { BrowserWindow } from 'electron';
import log from 'electron-log';
import { execSync } from 'child_process';
import path from 'path';

// 'downloading' and 'ready' come back with Developer ID signing: macOS's updater (Squirrel.Mac) refuses to install
// one ad hoc signed build over another, so until then the app only says a new version is out
export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'up-to-date' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

let currentStatus: UpdateStatus = { state: 'checking' };
let mainWindow: BrowserWindow | null = null;

export function getUpdateStatus(): UpdateStatus {
  return currentStatus;
}

function setStatus(status: UpdateStatus) {
  currentStatus = status;
  mainWindow?.webContents.send('update-status-changed', status);
}

export function initUpdater(win: BrowserWindow) {
  mainWindow = win;

  autoUpdater.logger = log;
  // nothing to install it with yet (see UpdateStatus), so don't download 120 MB for nothing
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    setStatus({ state: 'available', version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    const prev = currentStatus;
    const version = (prev.state === 'available' || prev.state === 'downloading') ? prev.version : '';
    setStatus({
      state: 'downloading',
      version,
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    // strip macOS quarantine so the updated app isn't blocked on relaunch
    try {
      const appPath = path.join('/Applications', 'notiskin.app');
      execSync(`xattr -rd com.apple.quarantine "${appPath}"`, { stdio: 'ignore' });
    } catch {
      // non-fatal, continue anyway
    }
    setStatus({ state: 'ready', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    setStatus({ state: 'up-to-date' });
  });

  autoUpdater.on('error', (err) => {
    setStatus({ state: 'error', message: err.message });
  });

  // check on launch, then every 4 hours
  checkForUpdates();
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
}

// Settings' Check now, and the timer
export function checkForUpdates() {
  setStatus({ state: 'checking' });
  autoUpdater
    .checkForUpdates()
    .then(result => {
      // null when it skipped the check (running from source), no event follows
      if (!result && currentStatus.state === 'checking') setStatus({ state: 'up-to-date' });
    })
    .catch(() => {});
}

export function installUpdate() {
  autoUpdater.quitAndInstall(false, true);
}
