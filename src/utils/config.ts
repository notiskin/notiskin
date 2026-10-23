import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { CONFIG_PATH } from './constants';
import { parsePluginSettings, SettingValue } from '../core/plugin-settings';

export interface NotiskinConfig {
  activeTheme: string;
  enabledPlugins: string[];
  acknowledgedPlugins: string[];
  // pauses every theme and plugin without forgetting which ones are chosen
  safeMode: boolean;
  // true once the welcome tour is finished or skipped, so it never starts on its own again
  setupDone: boolean;
  // set by patch, cleared by unpatch. A Notion update removes the wrapper and Notion.real, this is how status still says needs-repair
  notionInstalled: boolean;
  // refuse a Notion update that isn't Electron (Notion is moving to SwiftUI), on unless turned off
  blockNativeNotion: boolean;
  // the app keeps the watcher (a background process, runs even when Notion and Notiskin are closed) to repair Notion
  // after its updates. Off unless turned on
  autoRepair: boolean;
  // what the user picked in a plugin's Settings, by plugin name then setting key. A plugin only gets the keys it
  // declares, and gets its declared default for anything missing here
  pluginSettings: Record<string, Record<string, SettingValue>>;
}

function defaultConfig(): NotiskinConfig {
  return { activeTheme: '', enabledPlugins: [], acknowledgedPlugins: [], safeMode: false, setupDone: false, notionInstalled: false, blockNativeNotion: true, autoRepair: false, pluginSettings: {} };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function parseConfig(raw: unknown): NotiskinConfig {
  if (!raw || typeof raw !== 'object') return defaultConfig();
  const obj = raw as Record<string, unknown>;
  return {
    activeTheme: typeof obj.activeTheme === 'string' ? obj.activeTheme : '',
    enabledPlugins: [...new Set(stringArray(obj.enabledPlugins))],
    acknowledgedPlugins: [...new Set(stringArray(obj.acknowledgedPlugins))],
    safeMode: obj.safeMode === true,
    setupDone: obj.setupDone === true,
    notionInstalled: obj.notionInstalled === true,
    blockNativeNotion: obj.blockNativeNotion !== false,
    autoRepair: obj.autoRepair === true,
    pluginSettings: parsePluginSettings(obj.pluginSettings),
  };
}

export function readConfig(path = CONFIG_PATH): NotiskinConfig {
  if (!existsSync(path)) return defaultConfig();
  try {
    return parseConfig(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    // keep the broken file around so the user can recover it, then start fresh
    try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch {}
    return defaultConfig();
  }
}

// write to a temp file then rename, a crash mid-write can't leave half a config behind
export function writeConfig(config: NotiskinConfig, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(parseConfig(config), null, 2), 'utf-8');
  renameSync(tmp, path);
}
