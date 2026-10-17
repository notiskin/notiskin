import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { startServer } from '../gui/server';
import { initUpdater } from '../updater/index';
import { NOTISKIN_DIR, GUI_PORT } from '../utils/constants';

const GUI_ORIGIN = `http://localhost:${GUI_PORT}`;

function debugLog(msg: string): void {
  try {
    mkdirSync(NOTISKIN_DIR, { recursive: true });
    appendFileSync(join(NOTISKIN_DIR, 'debug.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function isAllowedInWindow(url: string): boolean {
  try {
    const { origin, protocol, hostname } = new URL(url);
    if (origin === GUI_ORIGIN) return true;
    return protocol === 'https:' && (hostname === 'github.com' || hostname.endsWith('.supabase.co'));
  } catch {
    return false;
  }
}

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
    try {
      await startServer(false, app.getAppPath());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`server failed to start: ${msg}`);
      dialog.showErrorBox('Notiskin could not start', msg);
      app.quit();
      return;
    }

    win = new BrowserWindow({
      width: 1024,
      height: 768,
      title: 'notiskin',
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    // target=_blank links (author profiles etc.) open in the real browser, never a new app window
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });

    // only the GUI itself and the GitHub sign-in round trip may load inside the window
    win.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedInWindow(url)) event.preventDefault();
    });

    win.loadURL(GUI_ORIGIN);

    win.once('ready-to-show', () => {
      win?.show();
    });

    win.on('closed', () => {
      app.quit();
    });

    initUpdater(win);
  });
}
