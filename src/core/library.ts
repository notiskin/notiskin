// shared theme/plugin logic, the CLI, the GUI server, and the launch-time inject all go through here
// so they can't drift apart on where files live or how they get applied
import { execFileSync, spawn } from 'child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  renameSync,
  openSync,
  closeSync,
} from 'fs';
import { join } from 'path';
import { THEMES_DIR, PLUGINS_DIR, MAX_ITEM_BYTES, LOGS_DIR, RUN_DIR } from '../utils/constants';
import { readConfig, writeConfig, NotiskinConfig } from '../utils/config';
import { appBundlePath, findNotionBinary, hasLegacyWrapper, isWrapperPresent } from '../patcher/index';
import { PluginEntry } from '../injector/index';
import { ensureRunDir, findNotionRun } from '../injector/pipe';
import { askInjector, ControlReply, ControlRequest } from '../injector/control';
import { sleep } from '../utils/sleep';
import { forgetInstall } from './installed';

export type ItemType = 'theme' | 'plugin';

// works from the repo's dist/ and from inside the packaged app.asar
export const CLI_SCRIPT = join(__dirname, '..', 'cli', 'index.js');

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;

// names become file names, so no slashes, no leading dots, nothing that can escape the folder
export function isValidItemName(name: unknown): name is string {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

export function isItemType(type: unknown): type is ItemType {
  return type === 'theme' || type === 'plugin';
}

// "my cool theme" -> "my-cool-theme", matches how earlier versions named installed files
export function toFileStem(displayName: string): string {
  return displayName.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
}

function dirFor(type: ItemType): string {
  return type === 'theme' ? THEMES_DIR : PLUGINS_DIR;
}

function extFor(type: ItemType): string {
  return type === 'theme' ? '.css' : '.js';
}

export function itemPath(type: ItemType, name: string): string {
  if (!isValidItemName(name)) throw new Error(`Invalid ${type} name: ${JSON.stringify(name)}`);
  return join(dirFor(type), `${name}${extFor(type)}`);
}

export function itemExists(type: ItemType, name: string): boolean {
  return isValidItemName(name) && existsSync(itemPath(type, name));
}

export function listItems(type: ItemType): string[] {
  const dir = dirFor(type);
  if (!existsSync(dir)) return [];
  const ext = extFor(type);
  return readdirSync(dir)
    .filter(f => f.endsWith(ext))
    .map(f => f.slice(0, -ext.length))
    .filter(isValidItemName)
    .sort((a, b) => a.localeCompare(b));
}

export const listThemes = (): string[] => listItems('theme');
export const listPlugins = (): string[] => listItems('plugin');

export function writeItem(type: ItemType, name: string, content: string): string {
  if (Buffer.byteLength(content, 'utf-8') > MAX_ITEM_BYTES) {
    throw new Error(`That ${type} is too large (limit ${MAX_ITEM_BYTES / 1024} KB).`);
  }
  const dest = itemPath(type, name);
  mkdirSync(dirFor(type), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, dest);
  return dest;
}

// removes the file and every config reference to it, returns false if it wasn't there
export function deleteItem(type: ItemType, name: string): boolean {
  if (!itemExists(type, name)) return false;
  unlinkSync(itemPath(type, name));
  // a file made later with this name is the user's own, not the marketplace item
  forgetInstall(type, name);
  const config = readConfig();
  if (type === 'theme' && config.activeTheme === name) config.activeTheme = '';
  if (type === 'plugin') {
    config.enabledPlugins = config.enabledPlugins.filter(p => p !== name);
    config.acknowledgedPlugins = config.acknowledgedPlugins.filter(p => p !== name);
  }
  writeConfig(config);
  return true;
}

// empty string means "no theme", Notion keeps its default look
export function activeThemeCss(config: NotiskinConfig): string {
  if (!config.activeTheme || !itemExists('theme', config.activeTheme)) return '';
  return readFileSync(itemPath('theme', config.activeTheme), 'utf-8');
}

export function loadEnabledPlugins(config: NotiskinConfig, warn: (msg: string) => void = () => {}): PluginEntry[] {
  const entries: PluginEntry[] = [];
  for (const name of config.enabledPlugins) {
    if (!itemExists('plugin', name)) {
      warn(`Plugin '${name}' is enabled but its file is missing, skipping.`);
      continue;
    }
    entries.push({ name, content: readFileSync(itemPath('plugin', name), 'utf-8') });
  }
  return entries;
}

// what Notion should get right now, safe mode sends nothing
export function currentPayload(
  config: NotiskinConfig = readConfig(),
  warn: (msg: string) => void = () => {}
): { css: string; plugins: PluginEntry[] } {
  if (config.safeMode) return { css: '', plugins: [] };
  return { css: activeThemeCss(config), plugins: loadEnabledPlugins(config, warn) };
}

function pgrep(name: string): boolean {
  try {
    execFileSync('pgrep', ['-x', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// patched Notion runs as Notion.real (the wrapper exec's into it), so check both names
export function isNotionRunning(): boolean {
  return pgrep('Notion') || pgrep('Notion.real');
}

function pkill(args: string[]): void {
  try { execFileSync('pkill', args, { stdio: 'ignore' }); } catch {}
}

export async function quitNotion(timeoutMs = 10_000): Promise<void> {
  pkill(['-x', 'Notion']);
  pkill(['-x', 'Notion.real']);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isNotionRunning()) return;
    await sleep(300);
  }
  // didn't exit gracefully in time, force it
  pkill(['-9', '-x', 'Notion']);
  pkill(['-9', '-x', 'Notion.real']);
  await sleep(500);
}

// starts the long-running injector in the background, it exits on its own if one is already running
// in the desktop app, Electron's binary doubles as Node via ELECTRON_RUN_AS_NODE
export function ensureInjector(): void {
  mkdirSync(LOGS_DIR, { recursive: true });
  const out = openSync(join(LOGS_DIR, 'inject.log'), 'a');
  try {
    const child = spawn(process.execPath, [CLI_SCRIPT, 'inject'], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  } finally {
    closeSync(out);
  }
}

// an unpatched Notion gets the same pipes the wrapper would give it, for this run only
function spawnWithPipe(binary: string): void {
  ensureRunDir();
  // named after Notion's pid once it has one, mkdtemp makes it 0700
  const dir = mkdtempSync(join(RUN_DIR, 'launch-'));
  execFileSync('mkfifo', ['-m', '600', join(dir, 'in'), join(dir, 'out')]);
  // read+write so Notion holds both ends itself and the pipe never closes under it
  const inFd = openSync(join(dir, 'in'), 'r+');
  const outFd = openSync(join(dir, 'out'), 'r+');
  try {
    const child = spawn(binary, ['--remote-debugging-pipe'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', inFd, outFd],
    });
    child.unref();
    if (!child.pid) throw new Error('Notion did not start.');
    renameSync(dir, join(RUN_DIR, String(child.pid)));
  } finally {
    closeSync(inFd);
    closeSync(outFd);
  }
}

// a patched Notion opens like it does from the Dock, the wrapper sets up the pipe and starts the injector
export function launchNotion(): void {
  const binary = findNotionBinary();
  if (isWrapperPresent(binary)) {
    execFileSync('open', [appBundlePath(binary)], { stdio: 'ignore' });
    return;
  }
  spawnWithPipe(binary);
  ensureInjector();
}

async function waitForInjector(req: ControlRequest, timeoutMs: number): Promise<ControlReply | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = await askInjector(req);
    if (reply) return reply;
    await sleep(300);
  }
  return null;
}

export const REPAIR_MESSAGE =
  'Notion still has the wrapper from an older Notiskin. Repair it in Notiskin\'s Settings, or run: notiskin patch';

export interface ApplyOptions {
  // relaunch Notion with Notiskin if the injector can't reach it
  restartIfNeeded?: boolean;
  // reload Notion's tabs too, needed to remove a plugin since JS can't be un-run
  reload?: boolean;
  log?: (msg: string) => void;
}

// asks the injector to apply the saved config, returns false if Notion wasn't reachable and restart wasn't allowed
// the injector reads the files itself, it's the only thing that talks to Notion
export async function applyConfig(opts: ApplyOptions = {}): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const config = readConfig();
  // only for the warnings about missing plugin files
  currentPayload(config, log);
  const req: ControlRequest = { cmd: opts.reload ? 'reload' : 'apply' };

  let reply = await askInjector(req);
  if (!reply && findNotionRun()) {
    // Notion has its pipe but the injector isn't running (it crashed, or was never started), start one
    ensureInjector();
    reply = await waitForInjector(req, 15_000);
  }

  if (!reply) {
    // in safe mode there's nothing to inject, so restarting Notion would only close its windows
    if (!opts.restartIfNeeded || config.safeMode) return false;
    if (hasLegacyWrapper()) throw new Error(REPAIR_MESSAGE);
    log('Restarting Notion with Notiskin...');
    await quitNotion();
    launchNotion();
    reply = await waitForInjector({ cmd: 'apply' }, 30_000);
    if (!reply) {
      throw new Error(
        'Notion started, but Notiskin could not connect to it. Try Repair in Notiskin\'s Settings, or run: notiskin patch'
      );
    }
  }

  if (!reply.ok) throw new Error(reply.error ?? 'The injector could not apply your settings.');
  return true;
}

export interface PreviewResult {
  ok: boolean;
  // false when Notion isn't running (or has no pipe), so there was nothing to show it in
  live: boolean;
  error?: string;
}

// shows CSS in every Notion tab without touching the config, it ends by itself a few seconds after the last call
// never starts or restarts Notion, only an injector for a Notion that is already running
export async function previewTheme(css: string): Promise<PreviewResult> {
  const req: ControlRequest = { cmd: 'preview', css };
  let reply = await askInjector(req);
  if (!reply && findNotionRun()) {
    ensureInjector();
    reply = await waitForInjector(req, 10_000);
  }
  if (!reply) return { ok: true, live: false };
  return { ok: reply.ok, live: reply.ok, error: reply.error };
}

export async function endThemePreview(): Promise<void> {
  await askInjector({ cmd: 'preview-end' });
}
