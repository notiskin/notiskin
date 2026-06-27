import * as dotenv from 'dotenv';
import { join } from 'path';
import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { app, BrowserWindow, ipcMain } from 'electron';
import { startServer } from '../gui/server';
import { initUpdater, installUpdate, getUpdateStatus } from '../updater/index';

function debugLog(msg: string): void {
  const dir = join(homedir(), '.notiskin');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'debug.log'), `[${new Date().toISOString()}] ${msg}\n`);
}

const GUI_PORT = 3845;
let win: BrowserWindow | null = null;

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    dotenv.config({ path: join(app.getAppPath(), '.env') });
    debugLog(`app.getAppPath() = ${app.getAppPath()}`);
    await startServer(false, app.getAppPath());

    win = new BrowserWindow({
      width: 1024,
      height: 768,
      title: 'notiskin',
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    win.loadURL(`http://localhost:${GUI_PORT}`);

    win.once('ready-to-show', () => {
      win?.show();
    });

    win.on('closed', () => {
      app.quit();
    });

    initUpdater(win);
  });

  ipcMain.handle('get-update-status', () => getUpdateStatus());
  ipcMain.handle('install-update', () => installUpdate());
}
