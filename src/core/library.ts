// shared theme/plugin logic, the CLI, the GUI server, and the launch-time inject all go through here
// so they can't drift apart on where files live or how they get applied
import { execFileSync, spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, openSync, closeSync } from 'fs';
import { join } from 'path';
import { THEMES_DIR, PLUGINS_DIR, CDP_PORT, MAX_ITEM_BYTES, LOGS_DIR } from '../utils/constants';
import { readConfig, writeConfig, NotiskinConfig } from '../utils/config';
import { launchNotion, waitForCDP, isCDPAvailable } from '../patcher/index';
import { applyAll, reloadAndReapply, PluginEntry } from '../injector/index';
import { sleep } from '../utils/sleep';

export type ItemType = 'theme' | 'plugin';

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
  const cli = join(__dirname, '..', 'cli', 'index.js');
  mkdirSync(LOGS_DIR, { recursive: true });
  const out = openSync(join(LOGS_DIR, 'inject.log'), 'a');
  try {
    const child = spawn(process.execPath, [cli, 'inject'], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  } finally {
    closeSync(out);
  }
}

export interface ApplyOptions {
  // relaunch Notion with the debug port if it isn't already reachable
  restartIfNeeded?: boolean;
  // reload the page first, needed to remove a plugin since JS can't be un-run
  reload?: boolean;
  log?: (msg: string) => void;
}

// applies the saved config to Notion, returns false if Notion wasn't reachable and restart wasn't allowed
export async function applyConfig(opts: ApplyOptions = {}): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const config = readConfig();
  const css = activeThemeCss(config);
  const plugins = loadEnabledPlugins(config, log);

  if (!(await isCDPAvailable(CDP_PORT))) {
    if (!opts.restartIfNeeded) return false;
    log('Restarting Notion with remote debugging enabled...');
    await quitNotion();
    launchNotion(CDP_PORT);
    await waitForCDP(CDP_PORT);
    ensureInjector();
    await applyAll(css, plugins, CDP_PORT);
    return true;
  }

  ensureInjector();

  if (opts.reload) {
    await reloadAndReapply(css, plugins, CDP_PORT);
  } else {
    await applyAll(css, plugins, CDP_PORT);
  }
  return true;
}
