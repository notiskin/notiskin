#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, appendFileSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync, exec } from 'child_process';
import https from 'https';
import http from 'http';
import { createClient } from '@supabase/supabase-js';
import { readConfig, writeConfig } from '../utils/config';
import { getUpdateStatus, installUpdate } from '../updater/index';
import { launchNotion, waitForCDP, isCDPAvailable } from '../patcher/index';
import { applyAll, reloadAndReapply, PluginEntry } from '../injector/index';

const CDP_PORT = 9222;
const NOTISKIN_DIR = join(homedir(), '.notiskin');
const THEMES_DIR = join(NOTISKIN_DIR, 'themes');
const PLUGINS_DIR = join(NOTISKIN_DIR, 'plugins');
let HTML_PATH = join(__dirname, '..', '..', 'src', 'gui', 'themes.html');
const GUI_PORT = 3845;

let _publicSupabase: ReturnType<typeof createClient> | null = null;
function getPublicSupabase() {
  if (!_publicSupabase) {
    _publicSupabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!);
  }
  return _publicSupabase;
}


function listThemes(): string[] {
  if (!existsSync(THEMES_DIR)) return [];
  return readdirSync(THEMES_DIR).filter(f => f.endsWith('.css')).map(f => f.replace(/\.css$/, ''));
}

function listPlugins(): string[] {
  if (!existsSync(PLUGINS_DIR)) return [];
  return readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''));
}

function isNotionRunning(): boolean {
  try {
    execSync('pgrep -x Notion', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function loadEnabledPlugins(enabledNames: string[]): PluginEntry[] {
  return enabledNames
    .filter(name => existsSync(join(PLUGINS_DIR, `${name}.js`)))
    .map(name => ({ name, content: readFileSync(join(PLUGINS_DIR, `${name}.js`), 'utf-8') }));
}

// patched binary runs as Notion.real (wrapper exec's into it), pkill "Notion" alone silently misses it
async function waitForNotionToQuit(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let running = false;
    try { execSync('pgrep -x Notion', { stdio: 'pipe' }); running = true; } catch {}
    if (!running) {
      try { execSync('pgrep -x "Notion.real"', { stdio: 'pipe' }); running = true; } catch {}
    }
    if (!running) return;
    await new Promise(r => setTimeout(r, 300));
  }
  // Timed out waiting for graceful exit, escalate to SIGKILL
  try { execSync('pkill -9 -x Notion', { stdio: 'ignore' }); } catch {}
  try { execSync('pkill -9 -x "Notion.real"', { stdio: 'ignore' }); } catch {}
  await new Promise(r => setTimeout(r, 500));
}

async function applyNotiskin(themeName: string): Promise<void> {
  const cssFile = join(THEMES_DIR, `${themeName}.css`);
  if (!existsSync(cssFile)) throw new Error(`Theme not found`);

  const config = readConfig();
  const plugins = loadEnabledPlugins(config.enabledPlugins);
  const cssContent = readFileSync(cssFile, 'utf-8');

  if (await isCDPAvailable(CDP_PORT)) {
    await applyAll(cssContent, plugins, CDP_PORT);
    return;
  }

  try { execSync('pkill -x Notion', { stdio: 'ignore' }); } catch {}
  try { execSync('pkill -x "Notion.real"', { stdio: 'ignore' }); } catch {}
  await waitForNotionToQuit();

  launchNotion(CDP_PORT);
  await waitForCDP(CDP_PORT);
  await applyAll(cssContent, plugins, CDP_PORT);
}


function downloadUrl(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers }, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
  });
}

const app = express();
app.use(express.json());


const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? req.socket.remoteAddress ?? 'unknown',
  message: { error: 'Too many submissions. Wait a few minutes.' },
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? req.socket.remoteAddress ?? 'unknown',
  message: { error: 'Too many requests.' },
});

app.get('/', (_req, res) => {
  res.send(readFileSync(HTML_PATH, 'utf-8'));
});

app.get('/plugins.html', (_req, res) => {
  const pluginsPath = HTML_PATH.replace('themes.html', 'plugins.html');
  res.send(readFileSync(pluginsPath, 'utf-8'));
});

app.get('/review.html', (_req, res) => {
  const reviewPath = HTML_PATH.replace('themes.html', 'review.html');
  res.send(readFileSync(reviewPath, 'utf-8'));
});

app.get('/api/status', (_req, res) => {
  const config = readConfig();
  res.json({
    notionRunning: isNotionRunning(),
    activeTheme: config.activeTheme,
    enabledPlugins: config.enabledPlugins,
  });
});

app.get('/api/themes/search', async (req, res) => {
  const q = (req.query.q as string || '').trim();
  if (!q) {
    const { data, error } = await getPublicSupabase()
      .from('themes').select('*').eq('status', 'approved')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ themes: data || [] });
  }
  const { data, error } = await getPublicSupabase()
    .from('themes').select('*').eq('status', 'approved')
    .or(`name.ilike.%${q}%,description.ilike.%${q}%,author_github.ilike.%${q}%`)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ themes: data || [] });
});

app.get('/api/plugins/search', async (req, res) => {
  const q = (req.query.q as string || '').trim();
  if (!q) {
    const { data, error } = await getPublicSupabase()
      .from('plugins').select('*').eq('status', 'approved')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ plugins: data || [] });
  }
  const { data, error } = await getPublicSupabase()
    .from('plugins').select('*').eq('status', 'approved')
    .or(`name.ilike.%${q}%,description.ilike.%${q}%,author_github.ilike.%${q}%`)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ plugins: data || [] });
});

app.get('/api/themes', (_req, res) => {
  const config = readConfig();
  res.json({ themes: listThemes(), activeTheme: config.activeTheme });
});

app.post('/api/theme/clear', async (_req, res) => {
  const config = readConfig();
  writeConfig({ ...config, activeTheme: '' });
  try {
    if (await isCDPAvailable(CDP_PORT)) {
      const plugins = loadEnabledPlugins(config.enabledPlugins);
      await applyAll('', plugins, CDP_PORT);
    }
    res.json({ ok: true });
  } catch (err: unknown) {
    res.json({ ok: false, error: (err as Error).message });
  }
});

app.post('/api/theme/:name', async (req, res) => {
  const { name } = req.params;
  if (!existsSync(join(THEMES_DIR, `${name}.css`))) {
    res.json({ ok: false, error: `Theme not found` });
    return;
  }
  const config = readConfig();
  writeConfig({ ...config, activeTheme: name });
  try {
    await applyNotiskin(name);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.json({ ok: false, error: (err as Error).message });
  }
});

app.get('/api/plugins', (_req, res) => {
  const config = readConfig();
  res.json({ plugins: listPlugins(), enabledPlugins: config.enabledPlugins });
});

app.get('/api/state', (_req, res) => {
  try {
    const config = readConfig();
    res.json({
      activeTheme: config.activeTheme || null,
      themes: listThemes().map(name => ({ name, active: name === config.activeTheme })),
      plugins: listPlugins().map(name => ({ name, active: config.enabledPlugins.includes(name) })),
    });
  } catch {
    res.json({ activeTheme: null, themes: [], plugins: [] });
  }
});

app.delete('/api/themes/:name', async (req, res) => {
  const { name } = req.params;
  const themeFile = join(THEMES_DIR, `${name}.css`);
  if (!existsSync(themeFile)) {
    res.json({ success: false, error: 'Theme not found' });
    return;
  }
  try { unlinkSync(themeFile); } catch {}
  const config = readConfig();
  if (config.activeTheme === name) config.activeTheme = '';
  writeConfig(config);
  if (await isCDPAvailable(CDP_PORT)) {
    try {
      const cssContent = config.activeTheme ? readFileSync(join(THEMES_DIR, `${config.activeTheme}.css`), 'utf-8') : '';
      const plugins = loadEnabledPlugins(config.enabledPlugins);
      await reloadAndReapply(cssContent, plugins, CDP_PORT);
    } catch {}
  }
  res.json({ success: true });
});

app.delete('/api/plugins/:name', async (req, res) => {
  const { name } = req.params;
  const pluginFile = join(PLUGINS_DIR, `${name}.js`);
  if (!existsSync(pluginFile)) {
    res.json({ success: false, error: 'Plugin not found' });
    return;
  }
  try { unlinkSync(pluginFile); } catch {}
  const config = readConfig();
  config.enabledPlugins = config.enabledPlugins.filter(p => p !== name);
  config.acknowledgedPlugins = config.acknowledgedPlugins.filter(p => p !== name);
  writeConfig(config);
  if (await isCDPAvailable(CDP_PORT)) {
    try {
      const cssContent = config.activeTheme ? readFileSync(join(THEMES_DIR, `${config.activeTheme}.css`), 'utf-8') : '';
      const remainingPlugins = loadEnabledPlugins(config.enabledPlugins);
      await reloadAndReapply(cssContent, remainingPlugins, CDP_PORT);
    } catch {}
  }
  res.json({ success: true });
});

app.post('/api/plugin/enable/:name', async (req, res) => {
  const { name } = req.params;
  if (!existsSync(join(PLUGINS_DIR, `${name}.js`))) {
    res.json({ ok: false, error: `Plugin not found` });
    return;
  }
  const config = readConfig();
  if (!config.acknowledgedPlugins.includes(name)) {
    res.json({ ok: false, needsWarning: true });
    return;
  }
  if (!config.enabledPlugins.includes(name)) {
    config.enabledPlugins.push(name);
    writeConfig(config);
  }
  try {
    const cssContent = readFileSync(join(THEMES_DIR, `${config.activeTheme}.css`), 'utf-8');
    if (await isCDPAvailable(CDP_PORT)) {
      // inject only the new plugin, no restart needed
      const plugin: PluginEntry = { name, content: readFileSync(join(PLUGINS_DIR, `${name}.js`), 'utf-8') };
      await applyAll(cssContent, [plugin], CDP_PORT);
    } else {
      try { execSync('pkill -x Notion', { stdio: 'ignore' }); } catch {}
      try { execSync('pkill -x "Notion.real"', { stdio: 'ignore' }); } catch {}
      await waitForNotionToQuit();
      launchNotion(CDP_PORT);
      await waitForCDP(CDP_PORT);
      const allPlugins = loadEnabledPlugins(config.enabledPlugins);
      await applyAll(cssContent, allPlugins, CDP_PORT);
    }
  } catch (err: unknown) {
    res.json({ ok: false, error: (err as Error).message });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/plugin/disable/:name', async (req, res) => {
  const { name } = req.params;
  const config = readConfig();
  config.enabledPlugins = config.enabledPlugins.filter(p => p !== name);
  writeConfig(config);
  if (await isCDPAvailable(CDP_PORT)) {
    try {
      const cssContent = readFileSync(join(THEMES_DIR, `${config.activeTheme}.css`), 'utf-8');
      const remainingPlugins = loadEnabledPlugins(config.enabledPlugins);
      await reloadAndReapply(cssContent, remainingPlugins, CDP_PORT);
    } catch (err: unknown) {
      res.json({ ok: false, error: (err as Error).message });
      return;
    }
  }
  res.json({ ok: true });
});

app.post('/api/plugin/acknowledge/:name', (req, res) => {
  const { name } = req.params;
  const config = readConfig();
  if (!config.acknowledgedPlugins.includes(name)) {
    config.acknowledgedPlugins.push(name);
    writeConfig(config);
  }
  res.json({ ok: true });
});

app.post('/api/apply', async (_req, res) => {
  const config = readConfig();
  try {
    await applyNotiskin(config.activeTheme);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.json({ ok: false, error: (err as Error).message });
  }
});

app.get('/api/catalog', async (_req, res) => {
  const db = getPublicSupabase();
  const { data: themes } = await db.from('themes').select('*').eq('status', 'approved');
  const { data: plugins } = await db.from('plugins').select('*').eq('status', 'approved');
  res.json({ themes: themes ?? [], plugins: plugins ?? [] });
});

app.get('/api/review/pending', async (req, res) => {
  const authHeader = req.headers.authorization;
  const edgeFnUrl = new URL('/functions/v1/review-pending', process.env.SUPABASE_URL).toString();
  const response = await fetch(edgeFnUrl, {
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
  });
  const body = await response.json();
  res.status(response.status).json(body);
});

app.post('/api/review/decide', submitLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;
  const edgeFnUrl = new URL('/functions/v1/review-decide', process.env.SUPABASE_URL).toString();
  const response = await fetch(edgeFnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(req.body),
  });
  const body = await response.json();
  res.status(response.status).json(body);
});

app.post('/api/submit/theme', submitLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;
  const edgeFnUrl = new URL('/functions/v1/submit-theme', process.env.SUPABASE_URL).toString();
  const response = await fetch(edgeFnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(req.body),
  });
  const body = await response.json();
  res.status(response.status).json(body);
});

app.post('/api/submit/plugin', submitLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;
  const edgeFnUrl = new URL('/functions/v1/submit-plugin', process.env.SUPABASE_URL).toString();
  const response = await fetch(edgeFnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(req.body),
  });
  const body = await response.json();
  res.status(response.status).json(body);
});

function makeUserSupabase(token: string) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}

app.post('/api/debug-log', generalLimiter, (req, res) => {
  const { msg } = req.body as { msg: string };
  appendFileSync(join(NOTISKIN_DIR, 'debug.log'), `[${new Date().toISOString()}] [frontend] ${String(msg)}\n`);
  res.json({ ok: true });
});

app.get('/api/submissions', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'No auth token' }); return; }
  const type = req.query.type as string;
  if (type !== 'theme' && type !== 'plugin') {
    res.status(400).json({ error: 'type must be theme or plugin' });
    return;
  }
  const table = type === 'theme' ? 'themes' : 'plugins';
  const supabase = makeUserSupabase(token);
  const { data, error } = await (supabase.from(table) as any)
    .select('id,name,description,status,rejection_reason,created_at')
    .order('created_at', { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ submissions: data ?? [] });
});

app.delete('/api/submissions/:id', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const dbg = (msg: string) => appendFileSync('/tmp/notiskin-debug.log', `[${new Date().toISOString()}] ${msg}\n`);
  dbg(`token present: ${!!token} length: ${token?.length ?? 0} prefix: ${token?.slice(0, 20)}`);

  if (!token) { res.status(401).json({ error: 'No auth token' }); return; }
  const { id } = req.params;
  const type = req.query.type as string;
  if (type !== 'theme' && type !== 'plugin') {
    res.status(400).json({ error: 'type must be theme or plugin' });
    return;
  }

  const supabase = makeUserSupabase(token);
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  dbg(`getUser, id: ${userData?.user?.id} email: ${userData?.user?.email} error: ${userError?.message}`);

  const table = type === 'theme' ? 'themes' : 'plugins';
  const { data, error } = await (supabase.from(table) as any)
    .delete()
    .eq('id', id)
    .select('id');
  dbg(`delete result, data: ${JSON.stringify(data)} error: ${error?.message} code: ${error?.code}`);

  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data || data.length === 0) {
    res.status(403).json({ error: "This submission can't be deleted" });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/install', generalLimiter, async (req, res) => {
  const { type, name, url, code } = req.body as { type: string; name: string; url?: string; code?: string };
  if (!type || !name || (!url && !code)) {
    res.json({ ok: false, error: 'Missing type, name, and either url or code' });
    return;
  }

  const destDir = type === 'theme' ? THEMES_DIR : PLUGINS_DIR;
  const ext = type === 'theme' ? '.css' : '.js';
  const destPath = join(destDir, `${name}${ext}`);

  try {
    mkdirSync(destDir, { recursive: true });
    const content = code ?? await downloadUrl(url!);
    writeFileSync(destPath, content, 'utf-8');

    const config = readConfig();
    const needsWarning = type === 'plugin' && !config.acknowledgedPlugins.includes(name);
    res.json({ ok: true, name, type, needsWarning });
  } catch (err: unknown) {
    res.json({ ok: false, error: (err as Error).message });
  }
});

app.post('/api/marketplace/install', (req, res) => {
  const { name, type, code } = req.body as { name: string; type: string; code: string };

  if (!name || !type || !code) {
    res.json({ success: false, error: 'Missing name, type, or code' });
    return;
  }
  if (type !== 'theme' && type !== 'plugin') {
    res.json({ success: false, error: 'type must be "theme" or "plugin"' });
    return;
  }

  const safeName = name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
  const ext = type === 'theme' ? '.css' : '.js';
  const destDir = type === 'theme' ? THEMES_DIR : PLUGINS_DIR;
  const destPath = join(destDir, `${safeName}${ext}`);

  if (existsSync(destPath)) {
    res.json({ success: true });
    return;
  }

  try {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(destPath, code, 'utf-8');
    res.json({ success: true });
  } catch (err: unknown) {
    res.json({ success: false, error: (err as Error).message });
  }
});

app.get('/settings.html', (_req, res) => {
  const settingsPath = HTML_PATH.replace('themes.html', 'settings.html');
  res.send(readFileSync(settingsPath, 'utf-8'));
});

app.get('/api/update-status', (_req, res) => {
  res.json(getUpdateStatus());
});

app.post('/api/update/install', (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => installUpdate(), 500);
});

app.delete('/api/cache/themes', (_req, res) => {
  const dir = join(NOTISKIN_DIR, 'themes');
  try {
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        rmSync(join(dir, file), { force: true });
      }
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cache/plugins', (_req, res) => {
  const dir = join(NOTISKIN_DIR, 'plugins');
  try {
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        rmSync(join(dir, file), { force: true });
      }
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cache/config', (_req, res) => {
  const configPath = join(NOTISKIN_DIR, 'notiskin.config.json');
  try {
    if (existsSync(configPath)) rmSync(configPath);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export function startServer(openBrowser = true, appRoot?: string): Promise<void> {
  if (appRoot) HTML_PATH = join(appRoot, 'src', 'gui', 'themes.html');
  appendFileSync(join(NOTISKIN_DIR, 'debug.log'), `[${new Date().toISOString()}] HTML_PATH = ${HTML_PATH}\n`);
  return new Promise((resolve) => {
    const server = app.listen(GUI_PORT, () => {
      const url = `http://localhost:${GUI_PORT}`;
      console.log(`Notiskin GUI → ${url}`);
      if (openBrowser) exec(`open ${url}`);
      resolve();
    });
    // apply + theme switch can take 60s+, avoid premature socket close
    server.setTimeout(120_000);
  });
}
