import { autoUpdater } from 'electron-updater';
import { BrowserWindow } from 'electron';
import log from 'electron-log';
import { execSync } from 'child_process';
import path from 'path';

export type UpdateStatus =
  | { state: 'up-to-date' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

let currentStatus: UpdateStatus = { state: 'up-to-date' };
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
  autoUpdater.autoDownload = true;
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
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

export function installUpdate() {
  autoUpdater.quitAndInstall(false, true);
}
