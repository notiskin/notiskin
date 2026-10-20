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
  isItemType,
  isNotionRunning,
  isValidItemName,
  itemExists,
  listPlugins,
  listThemes,
  quitNotion,
  toFileStem,
  writeItem,
  ItemType,
} from '../core/library';
import {
  appBundlePath,
  findNotionBinary,
  getNotionStatus,
  hasLegacyWrapper,
  hasOldSignature,
  NotionStatus,
  wrapperRunsOtherCopy,
} from '../patcher/index';
import { AdminAction, errorFromOutput } from '../patcher/admin';
import { diagnosticsReport } from '../core/diagnostics';

let pagesDir = join(__dirname, '..', '..', 'src', 'gui');

// fresh secret every launch, pages get it baked in, so other websites and apps can't drive the API
const SESSION_TOKEN = randomBytes(32).toString('hex');
const ALLOWED_HOSTS = new Set([`localhost:${GUI_PORT}`, `127.0.0.1:${GUI_PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map(h => `http://${h}`));
const OPEN_EXTERNAL_HOSTS = new Set(['github.com', 'www.github.com']);
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
  // Notion runs another copy of Notiskin, e.g. a source checkout or an older download. Only the packaged app (its CLI
  // sits in app.asar) asks, so copies run from source never call the installed app's wrapper broken
  otherCopy: (): boolean => CLI_SCRIPT.includes('.asar/') && wrapperRunsOtherCopy(process.execPath, CLI_SCRIPT),
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

// files the pages share: the look (brand.css and its fonts) and the welcome tour. A fixed list,
// nothing else in the folder is reachable, and read the same way as the pages so it works from app.asar
const ASSETS: Record<string, string> = {
  '/brand.css': 'css',
  '/tour.js': 'js',
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
  const otherCopy = status === 'installed' && notionSetup.otherCopy();
  if (otherCopy) status = 'needs-repair';
  res.json({ status, otherCopy, notionRunning: isNotionRunning(), blockNative: readConfig().blockNativeNotion });
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
    if (result.status === 'ok') return res.json({ ok: true, blockNative: on, applied: true });
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

async function searchMarketplace(table: 'themes' | 'plugins', q: string) {
  let query = publicSupabase().from(table).select('*').eq('status', 'approved');
  if (q) query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%,author_github.ilike.%${q}%`);
  return query.order('created_at', { ascending: false }).limit(200);
}

app.get('/api/themes/search', async (req, res) => {
  const { data, error } = await searchMarketplace('themes', sanitizeSearch(req.query.q));
  if (error) return res.status(502).json({ error: error.message });
  res.json({ themes: data ?? [] });
});

app.get('/api/plugins/search', async (req, res) => {
  const { data, error } = await searchMarketplace('plugins', sanitizeSearch(req.query.q));
  if (error) return res.status(502).json({ error: error.message });
  res.json({ plugins: data ?? [] });
});

app.get('/api/themes', (_req, res) => {
  res.json({ themes: listThemes(), activeTheme: readConfig().activeTheme });
});

app.get('/api/plugins', (_req, res) => {
  res.json({ plugins: listPlugins(), enabledPlugins: readConfig().enabledPlugins });
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

app.delete('/api/themes/:name', async (req, res) => {
  if (!deleteItem('theme', req.params.name)) return res.json({ success: false, error: 'Theme not found' });
  try { await serialized(() => applyConfig()); } catch {}
  res.json({ success: true });
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

// the server fetches the code itself, so only approved marketplace items can ever be written to disk
app.post('/api/marketplace/install', async (req, res) => {
  const { type, id } = (req.body ?? {}) as { type?: unknown; id?: unknown };
  if (!isItemType(type)) return res.status(400).json({ success: false, error: 'type must be "theme" or "plugin"' });
  if (typeof id !== 'string' && typeof id !== 'number') {
    return res.status(400).json({ success: false, error: 'Missing item id' });
  }
  if (!ID_PATTERN.test(String(id))) return res.status(400).json({ success: false, error: 'Invalid item id' });

  const table = type === 'theme' ? 'themes' : 'plugins';
  const codeColumn = type === 'theme' ? 'css' : 'js';
  const { data, error } = await publicSupabase()
    .from(table)
    .select(`name, ${codeColumn}`)
    .eq('id', id)
    .eq('status', 'approved')
    .maybeSingle();
  if (error) return res.status(502).json({ success: false, error: error.message });
  const row = data as Record<string, unknown> | null;
  const code = row?.[codeColumn];
  if (!row || typeof row.name !== 'string' || typeof code !== 'string') {
    return res.status(404).json({ success: false, error: 'That item is not available in the marketplace.' });
  }

  const stem = toFileStem(row.name);
  if (!isValidItemName(stem)) return res.status(400).json({ success: false, error: 'Item has an unusable name' });

  try {
    if (!itemExists(type as ItemType, stem)) writeItem(type as ItemType, stem, code);
    const needsWarning = type === 'plugin' && !readConfig().acknowledgedPlugins.includes(stem);
    res.json({ success: true, name: stem, needsWarning });
  } catch (err) {
    res.json({ success: false, error: errorMessage(err) });
  }
});

app.get('/api/review/pending', (req, res) => proxyToEdgeFunction('review-pending', req, res));
app.post('/api/review/decide', (req, res) => proxyToEdgeFunction('review-decide', req, res));
app.post('/api/submit/theme', submitLimiter, (req, res) => proxyToEdgeFunction('submit-theme', req, res));
app.post('/api/submit/plugin', submitLimiter, (req, res) => proxyToEdgeFunction('submit-plugin', req, res));

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

  // row level security limits this to the signed-in user's own submissions
  const { data, error } = await userSupabase(token)
    .from(table)
    .select('id,name,description,status,rejection_reason,created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(502).json({ error: error.message });
  res.json({ submissions: data ?? [] });
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

app.post('/api/open-external', async (req, res) => {
  const raw = (req.body as { url?: unknown })?.url;
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (url.protocol !== 'https:' || !OPEN_EXTERNAL_HOSTS.has(url.hostname)) {
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
