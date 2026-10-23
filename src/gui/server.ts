#!/usr/bin/env node
import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { readFileSync, existsSync, appendFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { randomBytes, timingSafeEqual } from 'crypto';
import type { Server } from 'http';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { readConfig, writeConfig } from '../utils/config';
import {
  NOTISKIN_DIR,
  CONFIG_PATH,
  GUI_HOST,
  GUI_PORT,
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  MAX_ITEM_BYTES,
  LOGS_DIR,
} from '../utils/constants';
import {
  applyConfig,
  CLI_SCRIPT,
  deleteItem,
  endThemePreview,
  isItemType,
  isNotionRunning,
  isValidItemName,
  itemExists,
  listPlugins,
  listThemes,
  previewTheme,
  quitNotion,
  writeItem,
  itemPath,
  ItemType,
} from '../core/library';
import { checkSettingValue, parseSettingDeclarations, resolveSettings } from '../core/plugin-settings';
import { checkDevFolder, devFileFor, isDevName, resolveDevFolder, scanDevFolder } from '../core/dev-plugins';
import {
  appBundlePath,
  findNotionBinary,
  getNotionStatus,
  hasLegacyWrapper,
  hasOldSignature,
  NotionStatus,
  watcherRunsThisCopy,
  wrapperRunsOtherCopy,
} from '../patcher/index';
import { installWatcher, uninstallWatcher } from '../patcher/agent';
import { AdminAction, errorFromOutput } from '../patcher/admin';
import { diagnosticsReport } from '../core/diagnostics';
import {
  findPulled,
  findUpdates,
  inBatches,
  installedIds,
  installFromMarketplace,
  ItemStatus,
  LatestInfo,
  MarketplaceItem,
  MarketplaceSort,
  parseSort,
  parseTags,
  updateFromMarketplace,
} from '../core/marketplace';
import { installedEntry } from '../core/installed';

let pagesDir = join(__dirname, '..', '..', 'src', 'gui');

// fresh secret every launch, pages get it baked in, so other websites and apps can't drive the API
const SESSION_TOKEN = randomBytes(32).toString('hex');
const ALLOWED_HOSTS = new Set([`localhost:${GUI_PORT}`, `127.0.0.1:${GUI_PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map(h => `http://${h}`));
const OPEN_EXTERNAL_HOSTS = new Set(['github.com', 'www.github.com', 'gist.github.com']);
// Notiskin's own docs (the site/ folder, published with GitHub Pages), and nothing else on github.io
const DOCS_HOST = 'notiskin.github.io';
const DOCS_PATH = '/notiskin/';

// links the app may open in the browser: GitHub, and Notiskin's own docs
export function isOpenableUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return OPEN_EXTERNAL_HOSTS.has(url.hostname) || (url.hostname === DOCS_HOST && url.pathname.startsWith(DOCS_PATH));
}
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

let _publicSupabase: SupabaseClient | null = null;
function publicSupabase(): SupabaseClient {
  if (!_publicSupabase) _publicSupabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  return _publicSupabase;
}

function userSupabase(token: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

function debugLog(msg: string): void {
  try {
    mkdirSync(NOTISKIN_DIR, { recursive: true });
    appendFileSync(join(NOTISKIN_DIR, 'debug.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// one Notion operation at a time, two overlapping restarts would fight over the process
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// postgrest filter syntax uses , ( ) and ilike uses % _, strip them so search text can't change the query
export function sanitizeSearch(q: unknown): string {
  return String(q ?? '').replace(/[,()%_*\\"']/g, ' ').trim().slice(0, 100);
}

function tokenMatches(given: unknown): boolean {
  if (typeof given !== 'string' || given.length !== SESSION_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(SESSION_TOKEN));
}

const BOOTSTRAP = `<script>
(() => {
  const token = ${JSON.stringify(SESSION_TOKEN)};
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.set('X-Notiskin-Token', token);
      init = { ...init, headers };
    }
    return originalFetch(input, init);
  };
})();
</script>`;

function sendPage(file: string) {
  return (_req: Request, res: Response) => {
    const html = readFileSync(join(pagesDir, file), 'utf-8');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html.replace(/<head>/i, `<head>\n${BOOTSTRAP}`));
  };
}

async function proxyToEdgeFunction(fn: string, req: Request, res: Response): Promise<void> {
  const token = bearerToken(req);
  const response = await fetch(new URL(`/functions/v1/${fn}`, SUPABASE_URL), {
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: `Marketplace server error (${response.status})` };
  }
  res.status(response.status).json(body);
}

function openExternal(url: string): Promise<void> {
  if (process.versions.electron) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron') as typeof import('electron');
    return shell.openExternal(url);
  }
  return new Promise((resolve, reject) => {
    execFile('open', [url], err => (err ? reject(err) : resolve()));
  });
}

// ---- signing in through the default browser ----
// GitHub sign-in can't happen inside the app window: Google sign-in refuses embedded windows and passkeys
// need a real browser. So Settings opens Supabase's GitHub sign-in in the default browser (PKCE flow),
// Supabase sends the browser back to /auth/callback with a one-time code, and the app picks the code up
// here and exchanges it. The code is useless without the PKCE verifier the app kept in its own storage

// swappable so tests never open a real browser
export const authBrowser = {
  open: (url: string): Promise<void> => openExternal(url),
};

const AUTH_WAIT_MS = 10 * 60 * 1000;
let pendingAuth: { startedAt: number; code: string | null; error: string | null } | null = null;

export function isSupabaseSignInUrl(raw: unknown): boolean {
  try {
    const url = new URL(String(raw));
    return (
      url.protocol === 'https:' &&
      url.host === new URL(SUPABASE_URL).host &&
      url.pathname === '/auth/v1/authorize' &&
      url.searchParams.get('provider') === 'github' &&
      url.searchParams.get('code_challenge_method')?.toLowerCase() === 's256' &&
      !!url.searchParams.get('code_challenge')
    );
  } catch {
    return false;
  }
}

function authWaiting(): boolean {
  return !!pendingAuth && Date.now() - pendingAuth.startedAt < AUTH_WAIT_MS;
}

const CODE_PATTERN = /^[A-Za-z0-9._-]{8,200}$/;

function callbackPage(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notiskin</title><link rel="stylesheet" href="/brand.css">
<style>body{background:var(--bg);color:var(--text);font-family:var(--font-body);display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
main{max-width:420px;text-align:center}h1{font-family:var(--font-display);font-weight:500;font-size:26px;margin:0 0 10px}p{color:var(--text-2);line-height:1.6;margin:0}</style>
</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

function loadUpdater(): typeof import('../updater/index') | null {
  // the updater needs Electron, the standalone `npm run gui` server runs without it
  if (!process.versions.electron) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../updater/index');
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, err => (err ? reject(err) : resolve()));
  });
}

export type SetupFailure = 'app-management' | 'not-owner';

export type SetupResult =
  | { status: 'ok'; output: string }
  | { status: 'error'; message: string; output: string };

// EPERM is macOS App Management refusing the change, EACCES means Notion.app belongs to another account
export function setupFailureReason(output: string): SetupFailure | null {
  if (/EPERM|operation not permitted/i.test(output)) return 'app-management';
  if (/EACCES|permission denied/i.test(output)) return 'not-owner';
  return null;
}

// App Management is granted to whichever app started the change
export function appManagementName(execPath = process.execPath, electron = Boolean(process.versions.electron)): string {
  if (execPath.includes('/node_modules/electron/')) return 'Electron';
  return electron ? 'Notiskin' : 'Terminal';
}

// runs the CLI as the current user, no admin prompt: macOS App Management refuses changes made
// from an admin shell, and Notion.app normally belongs to the user anyway (see patcher/admin.ts)
function runCli(action: AdminAction): Promise<SetupResult> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [CLI_SCRIPT, action],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 2 * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        if (!err) return resolve({ status: 'ok', output });
        resolve({ status: 'error', message: errorFromOutput(stderr || err.message), output });
      }
    );
  });
}

// swappable so tests never change a real Notion
export const notionSetup = {
  platform: (): NodeJS.Platform => process.platform,
  status: (): NotionStatus => getNotionStatus(),
  // wrappers from before the DevTools pipe, which opened a debug port, or a signature that blocked Notion's updates
  legacy: (): boolean => hasLegacyWrapper() || hasOldSignature(),
  // the downloaded app, its CLI sits in app.asar. Copies run from source leave Notion's setup to the installed app
  packaged: (): boolean => CLI_SCRIPT.includes('.asar/'),
  // Notion runs another copy of Notiskin, e.g. a source checkout or an older download
  otherCopy: (): boolean => wrapperRunsOtherCopy(process.execPath, CLI_SCRIPT),
  // the watcher's LaunchAgent runs this copy
  watcherIsOurs: (): boolean => watcherRunsThisCopy() === true,
  installWatcher: (): void => installWatcher(),
  removeWatcher: (): void => {
    uninstallWatcher();
  },
  // in the desktop app execPath is Electron (run as Node by the env var), under `npm run gui` it is Node itself
  run: (action: AdminAction): Promise<SetupResult> => runCli(action),
  // open the bundle like the Dock does, so the wrapper runs and starts the injector
  restart: async (): Promise<void> => {
    const bundle = appBundlePath(findNotionBinary());
    await quitNotion();
    await execFileAsync('open', [bundle]);
  },
  openAppManagement: (): Promise<void> =>
    execFileAsync('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles']),
};

const MAC_ONLY = 'Installing into Notion only works on macOS.';

function requireMac(res: Response): boolean {
  if (notionSetup.platform() === 'darwin') return true;
  res.status(400).json({ ok: false, error: MAC_ONLY });
  return false;
}

function logSetup(action: AdminAction, text: string): void {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(join(LOGS_DIR, 'inject.log'), `[${new Date().toISOString()}] [${action}] ${text.trim()}\n`);
  } catch {}
}

// one install or uninstall at a time, a double click must not start a second one
let notionSetupBusy = false;

async function runNotionSetup(action: AdminAction, res: Response): Promise<void> {
  if (!requireMac(res)) return;
  if (notionSetupBusy) {
    res.status(409).json({ ok: false, error: 'Already working on it.' });
    return;
  }
  notionSetupBusy = true;
  try {
    const result = await notionSetup.run(action);
    logSetup(action, result.output);
    if (result.status === 'ok') {
      if (action === 'patch') ensureWatcher();
      res.json({ ok: true, status: notionSetup.status() });
      return;
    }
    res.json({
      ok: false,
      error: result.message,
      reason: setupFailureReason(result.output),
      appName: appManagementName(),
    });
  } catch (err) {
    logSetup(action, errorMessage(err));
    res.json({ ok: false, error: errorMessage(err) });
  } finally {
    notionSetupBusy = false;
  }
}

// older versions opened a debug port any program on the Mac could use, and signed Notion in a way that made it
// refuse its own updates. The app fixes both on start, the same as clicking Repair: the port is gone the next time
// Notion starts and the next Notion update installs. If it fails (App Management was turned off, say), Settings
// still shows Repair for an old wrapper. Never restarts Notion
export async function repairLegacyWrapper(): Promise<boolean> {
  if (notionSetup.platform() !== 'darwin' || notionSetupBusy || !notionSetup.legacy()) return false;
  notionSetupBusy = true;
  try {
    const result = await notionSetup.run('patch');
    logSetup('patch', `automatic repair of an old install: ${result.status}\n${result.output}`);
    return result.status === 'ok';
  } catch (err) {
    logSetup('patch', `automatic repair of an old install failed: ${errorMessage(err)}`);
    return false;
  } finally {
    notionSetupBusy = false;
  }
}

// the watcher repairs Notion after its updates. It's a background process that runs even when Notion and Notiskin
// are closed, so the app only keeps one while "Repair automatically" is on (off by default). Then it's pointed at this
// app, and only when Notion runs this copy: a Notion installed from another copy is the user's call (Settings offers
// Repair). With it off the app removes its own watcher (0.7.0 set one up for everyone), never one another copy made.
// Runs after Install / Repair, on start, and when the switch changes. Never touches Notion itself, a failure only
// shows in the log. True when it changed something
export function ensureWatcher(): boolean {
  try {
    if (notionSetup.platform() !== 'darwin' || !notionSetup.packaged()) return false;
    if (!readConfig().autoRepair) {
      if (!notionSetup.watcherIsOurs()) return false;
      notionSetup.removeWatcher();
      logSetup('patch', 'watcher removed, repairing automatically is off');
      return true;
    }
    if (notionSetup.status() !== 'installed' || notionSetup.otherCopy() || notionSetup.watcherIsOurs()) return false;
    notionSetup.installWatcher();
    logSetup('patch', 'watcher set up to repair Notion after its updates');
    return true;
  } catch (err) {
    logSetup('patch', `could not set up the watcher: ${errorMessage(err)}`);
    return false;
  }
}

export const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  // blocks DNS rebinding, a malicious domain pointed at 127.0.0.1 still sends its own Host header
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
    res.status(403).send('Forbidden');
    return;
  }
  next();
});

app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    res.status(403).json({ error: 'Forbidden origin' });
    return;
  }
  if (!tokenMatches(req.headers['x-notiskin-token'])) {
    res.status(403).json({ error: 'Missing or invalid session token. Reload the page.' });
    return;
  }
  next();
});

app.use(express.json({ limit: MAX_ITEM_BYTES * 2 }));

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many submissions. Wait a few minutes.' },
});

const debugLogLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});

// served from the installed package instead of a CDN, so the version is pinned by package-lock
const SUPABASE_UMD = require.resolve('@supabase/supabase-js/dist/umd/supabase.js');
app.get('/vendor/supabase.js', (_req, res) => {
  // a fixed path, never from the request. Running from a folder like .claude/worktrees would otherwise 404,
  // because send refuses any path with a dot folder in it
  res.type('application/javascript').sendFile(SUPABASE_UMD, { dotfiles: 'allow' });
});

app.get('/', sendPage('themes.html'));
app.get('/plugins.html', sendPage('plugins.html'));
app.get('/review.html', sendPage('review.html'));
app.get('/settings.html', sendPage('settings.html'));

// where the default browser lands after GitHub sign-in. Not under /api: it's a page the browser opens
app.get('/auth/callback', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!authWaiting()) {
    return res.status(400).type('html').send(callbackPage('Nothing to finish', 'No sign-in was waiting. Start again from Settings in Notiskin.'));
  }
  const code = req.query.code;
  const error = req.query.error_description ?? req.query.error;
  if (typeof code === 'string' && CODE_PATTERN.test(code)) {
    pendingAuth = { ...pendingAuth!, code };
    return res.type('html').send(callbackPage("You're signed in", 'You can close this tab and go back to Notiskin.'));
  }
  pendingAuth = { ...pendingAuth!, error: typeof error === 'string' ? error.slice(0, 200) : 'Sign in was cancelled.' };
  res.status(400).type('html').send(callbackPage("Sign in didn't finish", 'Go back to Notiskin and try again.'));
});

// files the pages share: the look (brand.css and its fonts) and the welcome tour. A fixed list,
// nothing else in the folder is reachable, and read the same way as the pages so it works from app.asar
const ASSETS: Record<string, string> = {
  '/brand.css': 'css',
  '/tour.js': 'js',
  '/marketplace.js': 'js',
  '/theme-editor.js': 'js',
  '/fonts/fraunces.woff2': 'font/woff2',
  '/fonts/inter.woff2': 'font/woff2',
};
for (const [path, type] of Object.entries(ASSETS)) {
  app.get(path, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type(type).send(readFileSync(join(pagesDir, path)));
  });
}

app.get('/api/status', (_req, res) => {
  const config = readConfig();
  res.json({
    notionRunning: isNotionRunning(),
    activeTheme: config.activeTheme,
    enabledPlugins: config.enabledPlugins,
    safeMode: config.safeMode,
  });
});

// the tour starts on its own only for new users: never finished or skipped, and Notion not installed yet,
// so people who set Notiskin up before the tour existed aren't interrupted (they can replay it from Settings)
app.get('/api/setup', (_req, res) => {
  let installed = false;
  if (notionSetup.platform() === 'darwin') {
    try { installed = notionSetup.status() === 'installed'; } catch {}
  }
  res.json({ showTour: !readConfig().setupDone && !installed });
});

app.post('/api/setup-done', (_req, res) => {
  writeConfig({ ...readConfig(), setupDone: true });
  res.json({ ok: true });
});

// pauses every theme and plugin; turning it on reloads Notion's page because plugins can't be un-run
app.post('/api/safe-mode', async (req, res) => {
  const on = (req.body as { on?: unknown })?.on;
  if (typeof on !== 'boolean') return res.status(400).json({ ok: false, error: 'on must be true or false' });
  writeConfig({ ...readConfig(), safeMode: on });
  try {
    const applied = await serialized(() => applyConfig({ reload: on }));
    res.json({ ok: true, safeMode: on, applied });
  } catch (err) {
    // the setting is saved either way, Notion picks it up when it next starts
    res.json({ ok: true, safeMode: on, applied: false, error: errorMessage(err) });
  }
});

app.get('/api/diagnostics', async (_req, res) => {
  res.json({ report: await diagnosticsReport() });
});

app.get('/api/notion/status', (_req, res) => {
  if (!requireMac(res)) return;
  let status = notionSetup.status();
  // offered as a Repair, which points Notion at this copy. Never done on its own, the other copy may be on purpose
  const otherCopy = status === 'installed' && notionSetup.packaged() && notionSetup.otherCopy();
  if (otherCopy) status = 'needs-repair';
  const config = readConfig();
  res.json({
    status,
    otherCopy,
    notionRunning: isNotionRunning(),
    blockNative: config.blockNativeNotion,
    // only the packaged app keeps a watcher, copies run from source use `npm run watch:install`
    autoRepair: config.autoRepair,
    autoRepairAvailable: notionSetup.packaged(),
  });
});

// the setting lives in Notion's signature, so a patched Notion is re-signed (the same CLI patch as Repair).
// Saved either way: an unpatched Notion gets it at Install, and if signing fails the app retries on its next start
app.post('/api/notion/block-native', async (req, res) => {
  if (!requireMac(res)) return;
  const on = (req.body as { on?: unknown })?.on;
  if (typeof on !== 'boolean') return res.status(400).json({ ok: false, error: 'on must be true or false' });
  writeConfig({ ...readConfig(), blockNativeNotion: on });
  if (notionSetup.status() !== 'installed') return res.json({ ok: true, blockNative: on, applied: false });
  if (notionSetupBusy) return res.status(409).json({ ok: false, blockNative: on, error: 'Already working on it.' });
  notionSetupBusy = true;
  try {
    const result = await notionSetup.run('patch');
    logSetup('patch', `block native Notion ${on ? 'on' : 'off'}: ${result.status}\n${result.output}`);
    if (result.status === 'ok') {
      ensureWatcher();
      return res.json({ ok: true, blockNative: on, applied: true });
    }
    res.json({
      ok: false,
      blockNative: on,
      error: result.message,
      reason: setupFailureReason(result.output),
      appName: appManagementName(),
    });
  } catch (err) {
    res.json({ ok: false, blockNative: on, error: errorMessage(err) });
  } finally {
    notionSetupBusy = false;
  }
});

// nothing from the request goes into the command, it is built from this process's own paths
// sets up or removes the watcher right away. Saved either way: with Notion not installed from this app yet, the
// watcher is set up at Install
app.post('/api/notion/auto-repair', (req, res) => {
  if (!requireMac(res)) return;
  const on = (req.body as { on?: unknown })?.on;
  if (typeof on !== 'boolean') return res.status(400).json({ ok: false, error: 'on must be true or false' });
  if (notionSetupBusy) return res.status(409).json({ ok: false, error: 'Already working on it.' });
  writeConfig({ ...readConfig(), autoRepair: on });
  ensureWatcher();
  res.json({ ok: true, autoRepair: on, running: notionSetup.watcherIsOurs() });
});

app.post('/api/notion/install', (_req, res) => runNotionSetup('patch', res));
app.post('/api/notion/uninstall', (_req, res) => runNotionSetup('unpatch', res));

app.post('/api/notion/app-management', async (_req, res) => {
  if (!requireMac(res)) return;
  try {
    await notionSetup.openAppManagement();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: errorMessage(err) });
  }
});

app.post('/api/notion/restart', async (_req, res) => {
  if (!requireMac(res)) return;
  try {
    await serialized(() => notionSetup.restart());
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: errorMessage(err) });
  }
});

app.get('/api/state', (_req, res) => {
  const config = readConfig();
  res.json({
    activeTheme: config.activeTheme || null,
    safeMode: config.safeMode,
    themes: listThemes().map(name => ({ name, active: name === config.activeTheme })),
    plugins: listPlugins().map(name => ({ name, active: config.enabledPlugins.includes(name) })),
  });
});

async function searchMarketplace(table: 'themes' | 'plugins', q: string, sort: MarketplaceSort, tags: string[]) {
  let query = publicSupabase().from(table).select('*').eq('status', 'approved');
  if (q) query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%,author_github.ilike.%${q}%`);
  // items that have every picked tag
  if (tags.length) query = query.contains('tags', tags);
  if (sort === 'rating') query = query.order('avg_rating', { ascending: false }).order('rating_count', { ascending: false });
  if (sort === 'downloads') query = query.order('download_count', { ascending: false });
  return query.order('created_at', { ascending: false }).limit(200);
}

app.get('/api/themes/search', async (req, res) => {
  const { data, error } = await searchMarketplace('themes', sanitizeSearch(req.query.q), parseSort(req.query.sort), parseTags(req.query.tags));
  if (error) return res.status(502).json({ error: error.message });
  res.json({ themes: data ?? [] });
});

app.get('/api/plugins/search', async (req, res) => {
  const { data, error } = await searchMarketplace('plugins', sanitizeSearch(req.query.q), parseSort(req.query.sort), parseTags(req.query.tags));
  if (error) return res.status(502).json({ error: error.message });
  res.json({ plugins: data ?? [] });
});

app.get('/api/themes', (_req, res) => {
  res.json({ themes: listThemes(), activeTheme: readConfig().activeTheme });
});

// the source of an installed plugin, or of a developer plugin ("dev/<file>", from the developer folder). null if there is none
function pluginSource(name: string): string | null {
  if (isDevName(name)) {
    const config = readConfig();
    if (!config.developerMode || !config.developerFolder) return null;
    return scanDevFolder(config.developerFolder).plugins.find(p => p.name === name)?.content ?? null;
  }
  return itemExists('plugin', name) ? readFileSync(itemPath('plugin', name), 'utf-8') : null;
}

// what a plugin declares in its header comment, read as text, the plugin is never run for this
function pluginSettingsOf(name: string, source: string) {
  const { settings, problems } = parseSettingDeclarations(source);
  return { settings, problems, values: resolveSettings(settings, readConfig().pluginSettings[name]) };
}

// developer mode as the Plugins and Settings pages see it
function developerState() {
  const config = readConfig();
  const scan = config.developerMode && config.developerFolder ? scanDevFolder(config.developerFolder) : null;
  return {
    enabled: config.developerMode,
    folder: config.developerFolder,
    error: scan?.error ?? null,
    skipped: scan?.skipped ?? [],
    plugins: (scan?.plugins ?? []).map(p => ({ name: p.name, file: devFileFor(p.name), hasSettings: parseSettingDeclarations(p.content).settings.length > 0 })),
  };
}

app.get('/api/plugins', (_req, res) => {
  const plugins = listPlugins();
  res.json({
    plugins,
    enabledPlugins: readConfig().enabledPlugins,
    // the ones that get a Settings button
    withSettings: plugins.filter(name => pluginSettingsOf(name, pluginSource(name) ?? '').settings.length > 0),
    dev: developerState(),
  });
});

app.get('/api/plugin-settings/:name', (req, res) => {
  const { name } = req.params;
  const source = pluginSource(name);
  if (source === null) return res.status(404).json({ error: 'Plugin not found' });
  const { settings, problems, values } = pluginSettingsOf(name, source);
  res.json({ name, settings, problems, values, enabled: isDevName(name) || readConfig().enabledPlugins.includes(name) });
});

// saves what the user picked (only keys the plugin declares, every value checked) and shows it in Notion right away,
// no reload, a plugin that listens with notiskin.settings.onChange hears about it. { reset: true } goes back to the defaults
app.post('/api/plugin-settings/:name', async (req, res) => {
  const { name } = req.params;
  const source = pluginSource(name);
  if (source === null) return res.status(404).json({ error: 'Plugin not found' });
  const { settings } = pluginSettingsOf(name, source);
  const body = req.body ?? {};
  const config = readConfig();
  const saved = { ...(config.pluginSettings[name] ?? {}) };

  if (body.reset === true) {
    delete config.pluginSettings[name];
  } else {
    const incoming = body.values;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return res.status(400).json({ error: 'Nothing to save.' });
    const errors: string[] = [];
    for (const [key, value] of Object.entries(incoming)) {
      const decl = settings.find(d => d.key === key);
      if (!decl) {
        errors.push(`This plugin has no setting called "${key}".`);
        continue;
      }
      const checked = checkSettingValue(decl, value);
      if (checked.ok) saved[key] = checked.value;
      else errors.push(checked.error);
    }
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    config.pluginSettings[name] = saved;
  }
  writeConfig(config);
  if (isDevName(name) || config.enabledPlugins.includes(name)) {
    try { await serialized(() => applyConfig()); } catch {}
  }
  res.json({ ok: true, values: pluginSettingsOf(name, source).values });
});

app.post('/api/theme/clear', async (_req, res) => {
  writeConfig({ ...readConfig(), activeTheme: '' });
  try {
    await serialized(() => applyConfig());
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: errorMessage(err) });
  }
});

app.post('/api/theme/:name', async (req, res) => {
  const { name } = req.params;
  if (!itemExists('theme', name)) return res.json({ ok: false, error: 'Theme not found' });
  writeConfig({ ...readConfig(), activeTheme: name });
  try {
    await serialized(() => applyConfig({ restartIfNeeded: true }));
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: errorMessage(err) });
  }
});

// the theme editor. A theme made here is an ordinary file in ~/.notiskin/themes, the editor only writes the file and previews CSS
app.get('/api/theme-editor/:name', (req, res) => {
  const { name } = req.params;
  if (!itemExists('theme', name)) return res.status(404).json({ error: 'Theme not found' });
  res.json({
    name,
    css: readFileSync(itemPath('theme', name), 'utf-8'),
    // files installed from the marketplace are updated by the marketplace, an edit would be overwritten or lost
    fromMarketplace: !!installedEntry('theme', name),
  });
});

app.post('/api/theme-editor/save', async (req, res) => {
  const { name, css, replace } = req.body ?? {};
  if (!isValidItemName(name)) return res.status(400).json({ error: 'Use letters, numbers, spaces, dashes, dots and underscores in the name.' });
  if (typeof css !== 'string' || !css.trim()) return res.status(400).json({ error: 'The theme is empty.' });
  if (installedEntry('theme', name)) {
    return res.status(409).json({ error: 'That theme came from the marketplace. Save it under a new name to make your own copy.', reason: 'marketplace' });
  }
  if (itemExists('theme', name) && replace !== true) {
    return res.status(409).json({ error: 'You already have a theme with that name.', reason: 'exists' });
  }
  try {
    writeItem('theme', name, css);
  } catch (err) {
    return res.status(400).json({ error: errorMessage(err) });
  }
  // the injector watches the folder, this only makes sure the active theme is on screen before the answer
  if (readConfig().activeTheme === name) {
    try { await serialized(() => applyConfig()); } catch {}
  }
  res.json({ ok: true, name });
});

// shows the editor's CSS in Notion without changing the config, the editor repeats it every few seconds
// and it ends by itself if the editor goes away. Never restarts Notion
app.post('/api/theme-editor/preview', async (req, res) => {
  const { css } = req.body ?? {};
  if (typeof css !== 'string' || !css.trim()) return res.status(400).json({ error: 'Nothing to preview.' });
  if (readConfig().safeMode) return res.json({ ok: false, live: false, safeMode: true });
  try {
    res.json(await previewTheme(css));
  } catch (err) {
    res.json({ ok: false, live: false, error: errorMessage(err) });
  }
});

app.post('/api/theme-editor/preview/end', async (_req, res) => {
  try { await endThemePreview(); } catch {}
  res.json({ ok: true });
});

app.delete('/api/themes/:name', async (req, res) => {
  if (!deleteItem('theme', req.params.name)) return res.json({ success: false, error: 'Theme not found' });
  try { await serialized(() => applyConfig()); } catch {}
  res.json({ success: true });
});

// developer mode. Plugins in the folder run like installed ones and Notion's tabs reload when a file is saved.
// Turning it on or off or moving the folder reloads the tabs too, because a plugin that has run can't be un-run
app.get('/api/developer', (_req, res) => {
  res.json(developerState());
});

// the native folder picker, only inside the desktop app (the server runs in its main process)
export const folderPicker = {
  async choose(): Promise<string | null | undefined> {
    if (!process.versions.electron) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({ title: 'Choose your plugins folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
};

app.post('/api/developer/choose-folder', async (_req, res) => {
  try {
    const folder = await folderPicker.choose();
    if (folder === undefined) return res.json({ ok: false, unsupported: true });
    res.json({ ok: true, folder });
  } catch (err) {
    res.json({ ok: false, error: errorMessage(err) });
  }
});

app.post('/api/developer', async (req, res) => {
  const { enabled, folder } = req.body ?? {};
  if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
  if (folder !== undefined && typeof folder !== 'string') return res.status(400).json({ error: 'folder must be a path.' });
  const config = readConfig();
  const next = {
    ...config,
    developerMode: enabled ?? config.developerMode,
    developerFolder: folder !== undefined ? (folder.trim() ? resolveDevFolder(folder.trim()) : '') : config.developerFolder,
  };
  // a folder has to be good to be turned on, one that is only being remembered while it is off can be anything
  if (next.developerMode) {
    const problem = checkDevFolder(next.developerFolder);
    if (problem) return res.status(400).json({ error: problem });
  }
  if (next.developerFolder && folder !== undefined) {
    const problem = checkDevFolder(next.developerFolder);
    if (problem) return res.status(400).json({ error: problem });
  }
  writeConfig(next);
  try {
    await serialized(() => applyConfig({ reload: true }));
  } catch {}
  res.json({ ok: true, ...developerState() });
});

app.delete('/api/plugins/:name', async (req, res) => {
  const { name } = req.params;
  const wasEnabled = readConfig().enabledPlugins.includes(name);
  if (!deleteItem('plugin', name)) return res.json({ success: false, error: 'Plugin not found' });
  if (wasEnabled) {
    try { await serialized(() => applyConfig({ reload: true })); } catch {}
  }
  res.json({ success: true });
});

app.post('/api/plugin/enable/:name', async (req, res) => {
  const { name } = req.params;
  if (!itemExists('plugin', name)) return res.json({ ok: false, error: 'Plugin not found' });
  const config = readConfig();
  if (!config.acknowledgedPlugins.includes(name)) return res.json({ ok: false, needsWarning: true });
  if (!config.enabledPlugins.includes(name)) {
    config.enabledPlugins.push(name);
    writeConfig(config);
  }
  try {
    // already-running plugins are skipped by the injector, only the new one actually runs
    await serialized(() => applyConfig({ restartIfNeeded: true }));
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: errorMessage(err) });
  }
});

app.post('/api/plugin/disable/:name', async (req, res) => {
  const { name } = req.params;
  const config = readConfig();
  config.enabledPlugins = config.enabledPlugins.filter(p => p !== name);
  writeConfig(config);
  try {
    // JS can't be un-run, reload the page to drop the plugin
    await serialized(() => applyConfig({ reload: true }));
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: errorMessage(err) });
  }
});

app.post('/api/plugin/acknowledge/:name', (req, res) => {
  const { name } = req.params;
  if (!itemExists('plugin', name)) return res.json({ ok: false, error: 'Plugin not found' });
  const config = readConfig();
  if (!config.acknowledgedPlugins.includes(name)) {
    config.acknowledgedPlugins.push(name);
    writeConfig(config);
  }
  res.json({ ok: true });
});

app.post('/api/apply', async (_req, res) => {
  try {
    await serialized(() => applyConfig({ restartIfNeeded: true }));
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: errorMessage(err) });
  }
});

// the server fetches the code itself, so only approved marketplace items (their live, approved version)
// can ever be written to disk
function countDownload(token: string, type: ItemType, id: string): void {
  fetch(new URL('/functions/v1/count-download', SUPABASE_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type, id }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

async function fetchApprovedItem(type: ItemType, id: string): Promise<MarketplaceItem | null> {
  const table = type === 'theme' ? 'themes' : 'plugins';
  const codeColumn = type === 'theme' ? 'css' : 'js';
  const { data, error } = await publicSupabase()
    .from(table)
    .select(`id, name, version, ${codeColumn}`)
    .eq('id', id)
    .eq('status', 'approved')
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as Record<string, unknown> | null;
  const code = row?.[codeColumn];
  if (!row || typeof row.name !== 'string' || typeof code !== 'string') return null;
  return { id: String(row.id), name: row.name, code, version: Number.isInteger(row.version) ? (row.version as number) : 1 };
}

app.post('/api/marketplace/install', async (req, res) => {
  const { type, id } = (req.body ?? {}) as { type?: unknown; id?: unknown };
  if (!isItemType(type)) return res.status(400).json({ success: false, error: 'type must be "theme" or "plugin"' });
  if (typeof id !== 'string' && typeof id !== 'number') {
    return res.status(400).json({ success: false, error: 'Missing item id' });
  }
  if (!ID_PATTERN.test(String(id))) return res.status(400).json({ success: false, error: 'Invalid item id' });

  let item: MarketplaceItem | null;
  try {
    item = await fetchApprovedItem(type, String(id));
  } catch (err) {
    return res.status(502).json({ success: false, error: errorMessage(err) });
  }
  if (!item) return res.status(404).json({ success: false, error: 'That item is not available in the marketplace.' });

  try {
    const result = installFromMarketplace(type, item);
    if (result.outcome === 'conflict') {
      return res.status(409).json({
        success: false,
        conflict: true,
        error: `You already have a ${type} called "${result.name}" that didn't come from this marketplace item. Rename or delete it first.`,
      });
    }
    // a signed-in install counts as a download (once per user per item per day, the function decides).
    // Never waits on it or fails the install because of it
    const token = bearerToken(req);
    if (token && result.outcome === 'installed') countDownload(token, type, item.id);
    const needsWarning = type === 'plugin' && !readConfig().acknowledgedPlugins.includes(result.name);
    res.json({ success: true, name: result.name, needsWarning });
  } catch (err) {
    res.json({ success: false, error: errorMessage(err) });
  }
});

// what the marketplace says about installed items, swappable so tests don't need Supabase
export const marketplaceRemote = {
  // id, status and live version for up to 200 ids, approved, hidden and rejected items only.
  // null means item_statuses() isn't on the server yet (the migration isn't applied)
  statuses: async (type: ItemType, ids: string[]): Promise<{ id: string; status: ItemStatus; version: number }[] | null> => {
    const { data, error } = await publicSupabase().rpc('item_statuses', { p_item_type: type, p_ids: ids });
    if (error?.code === 'PGRST202') return null;
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; status: ItemStatus; version: number }[];
  },
  // the old way, approved items only, for a server without item_statuses()
  approved: async (type: ItemType, ids: string[]): Promise<{ id: string; version: number }[]> => {
    const table = type === 'theme' ? 'themes' : 'plugins';
    const { data, error } = await publicSupabase().from(table).select('id, version').in('id', ids).eq('status', 'approved');
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; version: number }[];
  },
  changes: async (type: ItemType, ids: string[]): Promise<{ item_id: string; version: number; changelog: string }[]> => {
    const { data, error } = await publicSupabase()
      .from('item_versions')
      .select('item_id, version, changelog')
      .eq('item_type', type)
      .in('item_id', ids)
      .eq('status', 'approved')
      .order('version', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as { item_id: string; version: number; changelog: string }[];
  },
};

interface RemoteInfo {
  latest: Map<string, LatestInfo>;
  // null when the server can't say (no item_statuses() yet), then nothing is called pulled
  statuses: Map<string, ItemStatus> | null;
}

// the pages ask every time they list installed items, so answers are kept for a while. The key is the
// set of ids, so installing something new asks again; updating or deleting needs nothing new
const REMOTE_CACHE_MS = 30 * 60 * 1000;
const remoteCache = new Map<string, { at: number; info: RemoteInfo }>();

export function clearMarketplaceCache(): void {
  remoteCache.clear();
}

async function remoteInfo(type: ItemType, ids: string[]): Promise<RemoteInfo> {
  const key = `${type}:${[...ids].sort().join(',')}`;
  const cached = remoteCache.get(key);
  if (cached && Date.now() - cached.at < REMOTE_CACHE_MS) return cached.info;

  const latest = new Map<string, LatestInfo>();
  let statuses: Map<string, ItemStatus> | null = new Map();
  for (const batch of inBatches(ids)) {
    const [rows, changes] = await Promise.all([marketplaceRemote.statuses(type, batch), marketplaceRemote.changes(type, batch)]);
    let live: { id: string; version: number }[];
    if (rows && statuses) {
      for (const row of rows) statuses.set(String(row.id), row.status);
      live = rows.filter(row => row.status === 'approved');
    } else {
      statuses = null;
      live = await marketplaceRemote.approved(type, batch);
    }
    for (const row of live) latest.set(String(row.id), { version: Number(row.version) || 1, changes: [] });
    for (const v of changes) latest.get(String(v.item_id))?.changes.push({ version: v.version, changelog: v.changelog ?? '' });
  }
  const info = { latest, statuses };
  remoteCache.set(key, { at: Date.now(), info });
  return info;
}

// installed marketplace items with a newer approved version, with what changed, and installed items that
// were hidden after reports, rejected by a reviewer or removed, so the GUI can warn about them
app.get('/api/marketplace/updates', async (_req, res) => {
  const updates = [];
  const pulled = [];
  try {
    for (const type of ['theme', 'plugin'] as const) {
      const ids = installedIds(type);
      if (ids.length === 0) continue;
      const info = await remoteInfo(type, ids);
      updates.push(...findUpdates(type, info.latest));
      if (info.statuses) pulled.push(...findPulled(type, info.statuses));
    }
    res.json({ updates, pulled });
  } catch (err) {
    res.status(502).json({ error: errorMessage(err) });
  }
});

// updates an installed marketplace item to its live version. Plugins run code, so the GUI shows the
// plugin warning and the changes first and sends confirmed: true
app.post('/api/marketplace/update', async (req, res) => {
  const { type, name, confirmed } = (req.body ?? {}) as { type?: unknown; name?: unknown; confirmed?: unknown };
  if (!isItemType(type)) return res.status(400).json({ success: false, error: 'type must be "theme" or "plugin"' });
  if (!isValidItemName(name)) return res.status(400).json({ success: false, error: 'Invalid name' });
  if (type === 'plugin' && confirmed !== true) {
    return res.status(400).json({ success: false, error: 'Confirm the plugin update first.' });
  }
  const entry = installedEntry(type, name);
  if (!entry) return res.status(404).json({ success: false, error: `That ${type} didn't come from the marketplace.` });

  let item: MarketplaceItem | null;
  try {
    item = await fetchApprovedItem(type, entry.id);
  } catch (err) {
    return res.status(502).json({ success: false, error: errorMessage(err) });
  }
  if (!item) return res.status(404).json({ success: false, error: 'That item is no longer in the marketplace.' });

  try {
    updateFromMarketplace(type, name, item);
  } catch (err) {
    return res.json({ success: false, error: errorMessage(err) });
  }

  // the injector re-applies theme files on its own; an enabled plugin needs a reload to run the new code
  const config = readConfig();
  try {
    if (type === 'theme' && config.activeTheme === name) await serialized(() => applyConfig());
    if (type === 'plugin' && config.enabledPlugins.includes(name)) await serialized(() => applyConfig({ reload: true }));
  } catch {}
  res.json({ success: true, name, version: item.version });
});

app.get('/api/review/pending', (req, res) => proxyToEdgeFunction('review-pending', req, res));
app.post('/api/review/decide', (req, res) => proxyToEdgeFunction('review-decide', req, res));
app.post('/api/submit/theme', submitLimiter, (req, res) => proxyToEdgeFunction('submit-theme', req, res));
app.post('/api/submit/plugin', submitLimiter, (req, res) => proxyToEdgeFunction('submit-plugin', req, res));
app.post('/api/submit/version', submitLimiter, (req, res) => proxyToEdgeFunction('submit-version', req, res));
app.post('/api/item/details', (req, res) => proxyToEdgeFunction('update-details', req, res));
app.post('/api/report', submitLimiter, (req, res) => proxyToEdgeFunction('report-item', req, res));

app.post('/api/debug-log', debugLogLimiter, (req, res) => {
  const msg = String((req.body as { msg?: unknown })?.msg ?? '').replace(/[\r\n]+/g, ' ').slice(0, 2000);
  debugLog(`[frontend] ${msg}`);
  res.json({ ok: true });
});

function submissionTable(type: unknown): 'themes' | 'plugins' | null {
  if (type === 'theme') return 'themes';
  if (type === 'plugin') return 'plugins';
  return null;
}

app.get('/api/submissions', async (req, res) => {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'No auth token' });
  const table = submissionTable(req.query.type);
  if (!table) return res.status(400).json({ error: 'type must be theme or plugin' });

  // row level security also lets everyone read approved items, so filter by the GitHub identity
  // Supabase vouches for (never user_metadata)
  const client = userSupabase(token);
  const { data: auth, error: authError } = await client.auth.getUser(token);
  const username = auth?.user?.identities?.find(i => i.provider === 'github')?.identity_data?.user_name;
  if (authError || typeof username !== 'string' || !username) return res.status(401).json({ error: 'Sign in again' });
  const { data, error } = await client
    .from(table)
    .select('id,name,description,status,rejection_reason,created_at,version,tags,link')
    .ilike('author_github', username.replace(/[\\%_]/g, '\\$&'))
    .order('created_at', { ascending: false });
  if (error) return res.status(502).json({ error: error.message });
  res.json({ submissions: data ?? [] });
});

// your new versions that are waiting for review or were rejected (approved ones are live already).
// Row level security only shows unapproved versions to their author
app.get('/api/submissions/versions', async (req, res) => {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'No auth token' });
  const type = req.query.type;
  if (type !== 'theme' && type !== 'plugin') return res.status(400).json({ error: 'type must be theme or plugin' });

  const { data, error } = await userSupabase(token)
    .from('item_versions')
    .select('id,item_id,version,changelog,status,rejection_reason,created_at')
    .eq('item_type', type)
    .in('status', ['pending', 'rejected'])
    .order('created_at', { ascending: false });
  if (error) return res.status(502).json({ error: error.message });
  res.json({ versions: data ?? [] });
});

app.delete('/api/submissions/:id', async (req, res) => {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'No auth token' });
  const { id } = req.params;
  if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid id' });
  const table = submissionTable(req.query.type);
  if (!table) return res.status(400).json({ error: 'type must be theme or plugin' });

  const { data, error } = await userSupabase(token).from(table).delete().eq('id', id).select('id');
  if (error) return res.status(502).json({ error: error.message });
  if (!data || data.length === 0) return res.status(403).json({ error: "This submission can't be deleted" });
  res.json({ ok: true });
});

app.get('/api/update-status', (_req, res) => {
  const updater = loadUpdater();
  res.json(updater ? updater.getUpdateStatus() : { state: 'up-to-date' });
});

app.post('/api/update/check', (_req, res) => {
  const updater = loadUpdater();
  if (!updater) return res.status(400).json({ ok: false, error: 'Updates are only available in the desktop app' });
  updater.checkForUpdates();
  res.json({ ok: true });
});

app.post('/api/update/install', (_req, res) => {
  const updater = loadUpdater();
  if (!updater) return res.status(400).json({ ok: false, error: 'Updates are only available in the desktop app' });
  res.json({ ok: true });
  setTimeout(() => updater.installUpdate(), 500);
});

app.get('/api/version', (_req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { version } = require('../../package.json') as { version: string };
  res.json({ version });
});

// Settings asks for Supabase's GitHub sign-in page to open in the default browser
app.post('/api/auth/start', async (req, res) => {
  const url = (req.body as { url?: unknown })?.url;
  if (!isSupabaseSignInUrl(url)) return res.status(400).json({ error: 'That sign-in link is not allowed' });
  pendingAuth = { startedAt: Date.now(), code: null, error: null };
  try {
    await authBrowser.open(String(url));
    res.json({ ok: true });
  } catch (err) {
    pendingAuth = null;
    res.status(500).json({ error: `Couldn't open the browser: ${errorMessage(err)}` });
  }
});

// Settings polls this while the browser sign-in is open. The code is handed out once
app.get('/api/auth/result', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!pendingAuth) return res.json({ state: 'idle' });
  if (!authWaiting()) {
    pendingAuth = null;
    return res.json({ state: 'expired' });
  }
  if (pendingAuth.code) {
    const { code } = pendingAuth;
    pendingAuth = null;
    return res.json({ state: 'done', code });
  }
  if (pendingAuth.error) {
    const { error } = pendingAuth;
    pendingAuth = null;
    return res.json({ state: 'failed', error });
  }
  res.json({ state: 'waiting' });
});

app.post('/api/auth/cancel', (_req, res) => {
  pendingAuth = null;
  res.json({ ok: true });
});

app.post('/api/open-external', async (req, res) => {
  const raw = (req.body as { url?: unknown })?.url;
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (!isOpenableUrl(url)) {
    return res.status(400).json({ error: 'That link is not allowed' });
  }
  await openExternal(url.toString());
  res.json({ ok: true });
});

function clearItems(type: ItemType): void {
  const names = type === 'theme' ? listThemes() : listPlugins();
  for (const name of names) deleteItem(type, name);
}

app.delete('/api/cache/themes', (_req, res) => {
  clearItems('theme');
  res.json({ ok: true });
});

app.delete('/api/cache/plugins', (_req, res) => {
  clearItems('plugin');
  res.json({ ok: true });
});

app.delete('/api/cache/config', (_req, res) => {
  if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
  res.json({ ok: true });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// express 5 forwards rejected promises here, so a failed route never hangs or crashes the server
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  debugLog(`[server] ${err instanceof Error ? err.stack : String(err)}`);
  if (res.headersSent) return;
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).json({ error: status === 500 ? 'Something went wrong' : errorMessage(err) });
});

export function startServer(openBrowser = true, appRoot?: string): Promise<Server> {
  if (appRoot) pagesDir = join(appRoot, 'src', 'gui');
  return new Promise((resolve, reject) => {
    const server = app.listen(GUI_PORT, GUI_HOST);
    server.once('listening', () => {
      const url = `http://localhost:${GUI_PORT}`;
      console.log(`Notiskin GUI → ${url}`);
      if (openBrowser) execFile('open', [url], () => {});
      resolve(server);
    });
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${GUI_PORT} is already in use. Is another copy of Notiskin running?`)
          : err
      );
    });
    // apply + theme switch can take 60s+, avoid premature socket close
    server.setTimeout(120_000);
  });
}
