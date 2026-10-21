// the watcher's LaunchAgent (watcher.ts repatches Notion after Notion updates itself).
// The CLI's watch:install, the desktop app (after Install / Repair, and on start) and unpatch all go through here
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { LOGS_DIR, USER_HOME } from '../utils/constants';

export const WATCHER_LABEL = 'com.notiskin.watcher';

export function watcherPlistPath(): string {
  return join(USER_HOME, 'Library', 'LaunchAgents', `${WATCHER_LABEL}.plist`);
}

export interface WatcherTarget {
  program: string;
  script: string;
  // the desktop app runs the watcher with its own Electron binary acting as Node
  appMode: boolean;
}

// the copy of Notiskin running this code
export function thisCopyWatcher(): WatcherTarget {
  return { program: process.execPath, script: join(__dirname, 'watcher.js'), appMode: Boolean(process.versions.electron) };
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlUnescape(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function watcherPlist(target: WatcherTarget, log = join(LOGS_DIR, 'watcher.log')): string {
  // only the watcher gets this, the app's binary would otherwise open a window
  const env = target.appMode
    ? `
    <key>EnvironmentVariables</key>
    <dict>
        <key>ELECTRON_RUN_AS_NODE</key>
        <string>1</string>
    </dict>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${WATCHER_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(target.program)}</string>
        <string>${xmlEscape(target.script)}</string>
    </array>${env}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(log)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

// which copy the installed watcher runs, null when there's none or it can't be read
export function readWatcherTarget(path = watcherPlistPath()): WatcherTarget | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (!args) return null;
  const strings = [...args[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m => xmlUnescape(m[1]));
  if (strings.length !== 2) return null;
  return { program: strings[0], script: strings[1], appMode: text.includes('<key>ELECTRON_RUN_AS_NODE</key>') };
}

// swappable so tests never load a real LaunchAgent
export const launchctl = {
  run: (args: string[]): void => {
    execFileSync('launchctl', args, { stdio: 'ignore' });
  },
};

// writes the plist and (re)starts the watcher, replacing one that runs another copy
export function installWatcher(target = thisCopyWatcher()): void {
  if (!existsSync(target.script)) throw new Error(`${target.script} not found. Run 'npm run build' first.`);
  const path = watcherPlistPath();
  mkdirSync(LOGS_DIR, { recursive: true });
  mkdirSync(join(USER_HOME, 'Library', 'LaunchAgents'), { recursive: true });
  // load refuses an agent that's already loaded, unload fails if it isn't, which is fine
  if (existsSync(path)) {
    try { launchctl.run(['unload', path]); } catch {}
  }
  writeFileSync(path, watcherPlist(target), 'utf-8');
  try {
    launchctl.run(['load', path]);
  } catch {
    throw new Error(`Failed to load the LaunchAgent. The plist was written, try: launchctl load "${path}"`);
  }
}

// false when there was no watcher
export function uninstallWatcher(): boolean {
  const path = watcherPlistPath();
  if (!existsSync(path)) return false;
  // unload fails if the agent isn't running, still remove the plist
  try { launchctl.run(['unload', path]); } catch {}
  unlinkSync(path);
  return true;
}
