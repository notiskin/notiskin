// ~/.notiskin/installed.json remembers which marketplace item and version each installed file came from,
// so the app can offer updates. Files the user made themselves have no entry and are never touched
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { INSTALLED_PATH } from '../utils/constants';

export interface InstalledEntry {
  id: string;
  version: number;
}

// keys are "theme:<file name>" / "plugin:<file name>"
export type InstalledManifest = Record<string, InstalledEntry>;

const KEY_PATTERN = /^(theme|plugin):[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;

export function installedKey(type: 'theme' | 'plugin', name: string): string {
  return `${type}:${name}`;
}

export function parseInstalled(raw: unknown): InstalledManifest {
  const out: InstalledManifest = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY_PATTERN.test(key) || !value || typeof value !== 'object') continue;
    const { id, version } = value as Record<string, unknown>;
    if (typeof id !== 'string' || !id || !Number.isInteger(version) || (version as number) < 1) continue;
    out[key] = { id, version: version as number };
  }
  return out;
}

export function readInstalled(path = INSTALLED_PATH): InstalledManifest {
  if (!existsSync(path)) return {};
  try {
    return parseInstalled(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    // keep the broken file for recovery; with no entries nothing gets updated, which is the safe side
    try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch {}
    return {};
  }
}

// temp file then rename, same as the config, so a crash can't leave half a manifest
export function writeInstalled(manifest: InstalledManifest, path = INSTALLED_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(parseInstalled(manifest), null, 2), 'utf-8');
  renameSync(tmp, path);
}

export function installedEntry(type: 'theme' | 'plugin', name: string, path = INSTALLED_PATH): InstalledEntry | null {
  return readInstalled(path)[installedKey(type, name)] ?? null;
}

export function recordInstall(type: 'theme' | 'plugin', name: string, entry: InstalledEntry, path = INSTALLED_PATH): void {
  const manifest = readInstalled(path);
  manifest[installedKey(type, name)] = { id: entry.id, version: entry.version };
  writeInstalled(manifest, path);
}

export function forgetInstall(type: 'theme' | 'plugin', name: string, path = INSTALLED_PATH): void {
  const manifest = readInstalled(path);
  const key = installedKey(type, name);
  if (!(key in manifest)) return;
  delete manifest[key];
  writeInstalled(manifest, path);
}
