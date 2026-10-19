// a plain-text report for bug reports, shown in Settings and printed by `notiskin diagnostics`
// everything goes through redact() so page links, Notion IDs and the user's name never get copied out
import { execFile } from 'child_process';
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'fs';
import { join } from 'path';
import net from 'net';
import { release, userInfo } from 'os';
import { INJECTOR_PID_PATH, LOGS_DIR, NOTISKIN_DIR, USER_HOME } from '../utils/constants';
import { readConfig } from '../utils/config';
import { pidLockHolder } from '../utils/pidlock';
import { appBundlePath, findNotionBinary, getNotionStatus } from '../patcher/index';
import { askInjector } from '../injector/control';
import { findNotionRun } from '../injector/pipe';
import { isNotionRunning, listPlugins, listThemes } from './library';

const LOG_LINES = 40;
// what Notiskin versions before the DevTools pipe opened, it should always be closed now
const OLD_DEBUG_PORT = 9222;

// connects only, never sends anything
function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

// last lines of a log without reading a big file into memory
export function tailFile(path: string, lines = LOG_LINES, maxBytes = 64 * 1024): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const all = buffer.toString('utf-8').split('\n').filter(Boolean);
    // a cut-off first line is useless, drop it when the read didn't start at the beginning
    if (size > length) all.shift();
    return all.slice(-lines);
  } finally {
    closeSync(fd);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// hides what could identify the user or their workspace: Notion links, Notion IDs, home folder, user name
export function redact(text: string, home = USER_HOME, names: string[] = currentUserNames()): string {
  let out = text
    .replace(/https?:\/\/(?:[\w-]+\.)*notion\.(?:so|com|site)\S*/gi, '<notion page>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/[0-9a-f]{32}/gi, '<id>');
  if (home && home !== '/') out = out.replace(new RegExp(escapeRegExp(home), 'g'), '~');
  out = out.replace(/\/Users\/[^/\s'"]+/g, '/Users/<you>');
  for (const name of names) {
    if (name.length >= 3) out = out.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi'), '<you>');
  }
  return out;
}

function currentUserNames(): string[] {
  const names = new Set<string>();
  try { names.add(userInfo().username); } catch {}
  if (process.env.SUDO_USER) names.add(process.env.SUDO_USER);
  // root shows up in plenty of harmless messages, it doesn't identify anyone
  names.delete('root');
  return [...names];
}

async function notionVersion(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const plist = join(appBundlePath(findNotionBinary()), 'Contents', 'Info.plist');
    return await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]);
  } catch {
    return null;
  }
}

async function systemVersion(): Promise<string> {
  if (process.platform === 'darwin') {
    const version = await run('sw_vers', ['-productVersion']);
    if (version) return `macOS ${version}`;
  }
  return `${process.platform} ${release()}`;
}

const yesNo = (value: boolean) => (value ? 'yes' : 'no');

export async function diagnosticsReport(now = new Date()): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { version } = require('../../package.json') as { version: string };
  const config = readConfig();
  const themes = listThemes();
  const plugins = listPlugins();
  const injectorPid = pidLockHolder(INJECTOR_PID_PATH);
  const runtime = process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.versions.node}`;
  const [system, notion, oldPort, injector] = await Promise.all([
    systemVersion(),
    notionVersion(),
    portOpen(OLD_DEBUG_PORT),
    askInjector({ cmd: 'status' }, 3000),
  ]);
  const logPath = join(LOGS_DIR, 'inject.log');
  const log = tailFile(logPath);

  const lines = [
    `Notiskin diagnostics, ${now.toISOString()}`,
    '',
    `Notiskin:        ${version} (${runtime})`,
    `System:          ${system}, ${process.arch}`,
    `Notion version:  ${notion ?? 'unknown'}`,
    `Installed:       ${getNotionStatus()}`,
    `Notion running:  ${yesNo(isNotionRunning())}`,
    `DevTools pipe:   ${findNotionRun() ? 'open' : 'not open'}`,
    `Injector:        ${injectorPid ? `running (pid ${injectorPid})` : 'not running'}${injector?.ok ? `, connected to ${injector.tabs} tab(s)` : ''}`,
    `Port ${OLD_DEBUG_PORT}:       ${oldPort ? 'open (an old Notiskin wrapper or another app, Repair closes ours)' : 'closed'}`,
    `Safe mode:       ${config.safeMode ? 'on' : 'off'}`,
    `Theme:           ${config.activeTheme || '(none)'} (${themes.length} installed)`,
    `Plugins on:      ${config.enabledPlugins.join(', ') || '(none)'} (${plugins.length} installed)`,
    `Data folder:     ${NOTISKIN_DIR}`,
    '',
    `Last ${LOG_LINES} lines of ${logPath}:`,
    ...(log.length ? log : ['(empty)']),
  ];
  return redact(lines.join('\n'));
}
