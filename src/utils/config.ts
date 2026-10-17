import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { CONFIG_PATH } from './constants';

export interface NotiskinConfig {
  activeTheme: string;
  enabledPlugins: string[];
  acknowledgedPlugins: string[];
}

function defaultConfig(): NotiskinConfig {
  return { activeTheme: '', enabledPlugins: [], acknowledgedPlugins: [] };
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
