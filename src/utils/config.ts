import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const NOTISKIN_DIR = join(homedir(), '.notiskin');
const CONFIG_PATH = join(NOTISKIN_DIR, 'notiskin.config.json');

mkdirSync(NOTISKIN_DIR, { recursive: true });

export interface NotiskinConfig {
  activeTheme: string;
  enabledPlugins: string[];
  acknowledgedPlugins: string[];
}

const DEFAULT_CONFIG: NotiskinConfig = { activeTheme: '', enabledPlugins: [], acknowledgedPlugins: [] };

export function readConfig(): NotiskinConfig {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    return DEFAULT_CONFIG;
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return {
      activeTheme: raw.activeTheme ?? DEFAULT_CONFIG.activeTheme,
      enabledPlugins: Array.isArray(raw.enabledPlugins) ? raw.enabledPlugins : [],
      acknowledgedPlugins: Array.isArray(raw.acknowledgedPlugins) ? raw.acknowledgedPlugins : [],
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeConfig(config: NotiskinConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}
