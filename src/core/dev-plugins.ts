// Developer mode: plugins that run straight from a folder the user picks, so a plugin can be written and tried without
// installing it. The folder is read in place (nothing is copied into ~/.notiskin/plugins), the injector watches it and
// reloads Notion's tabs when a file is saved. Only plain .js files count, and they get the same size limit as installed
// plugins. Nothing from here is ever published or listed in Browse, they aren't installed plugins
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import { MAX_ITEM_BYTES } from '../utils/constants';

// the name a developer plugin goes by (the loaded-once mark, its saved settings), it can never clash with an installed plugin
// because installed names can't contain a slash
export const DEV_PREFIX = 'dev/';

export const MAX_DEV_PLUGINS = 50;
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}\.js$/;

export interface DevPlugin {
  name: string;
  content: string;
}

export interface DevScan {
  plugins: DevPlugin[];
  // a file in the folder that isn't used, and why, in a sentence
  skipped: { file: string; reason: string }[];
  // set when the folder itself can't be used
  error?: string;
}

export function isDevName(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith(DEV_PREFIX) && FILE_PATTERN.test(`${name.slice(DEV_PREFIX.length)}.js`);
}

export const devFileFor = (name: string): string => `${name.slice(DEV_PREFIX.length)}.js`;

// what makes a folder usable: a real, absolute path to a folder
export function checkDevFolder(folder: unknown): string | null {
  if (typeof folder !== 'string' || !folder.trim()) return 'Choose a folder first.';
  if (folder.length > 1024 || folder.includes('\0')) return 'That folder path is not valid.';
  if (!isAbsolute(folder)) return 'Use the full path of the folder, like /Users/you/plugins.';
  try {
    if (!statSync(folder).isDirectory()) return 'That is not a folder.';
  } catch {
    return 'That folder does not exist.';
  }
  return null;
}

export function scanDevFolder(folder: string): DevScan {
  const error = checkDevFolder(folder);
  if (error) return { plugins: [], skipped: [], error };
  const plugins: DevPlugin[] = [];
  const skipped: DevScan['skipped'] = [];
  let names: string[];
  try {
    names = readdirSync(folder).sort((a, b) => a.localeCompare(b));
  } catch {
    return { plugins, skipped, error: 'Notiskin can not read that folder.' };
  }
  for (const file of names) {
    if (file.startsWith('.')) continue;
    if (!file.endsWith('.js')) continue;
    const skip = (reason: string) => skipped.push({ file, reason });
    if (!FILE_PATTERN.test(file)) {
      skip('the name can use letters, numbers, spaces, dashes, dots and underscores, up to 80 characters');
      continue;
    }
    const path = join(folder, file);
    let info;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    // a link could point anywhere, and a folder named x.js isn't a plugin
    if (info.isSymbolicLink()) { skip('it is a link, only plain files are used'); continue; }
    if (!info.isFile()) { skip('it is not a plain file'); continue; }
    if (info.size > MAX_ITEM_BYTES) { skip(`it is larger than ${MAX_ITEM_BYTES / 1024} KB`); continue; }
    if (plugins.length >= MAX_DEV_PLUGINS) { skip(`only the first ${MAX_DEV_PLUGINS} files are used`); continue; }
    try {
      plugins.push({ name: `${DEV_PREFIX}${file.slice(0, -3)}`, content: readFileSync(path, 'utf-8') });
    } catch {
      skip('it could not be read');
    }
  }
  return { plugins, skipped };
}

// the real folder behind a path, so a link to a folder is shown as what it is
export function resolveDevFolder(folder: string): string {
  try {
    return existsSync(folder) ? realpathSync(folder) : folder;
  } catch {
    return folder;
  }
}
