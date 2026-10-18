import { execFileSync, spawn } from 'child_process';
import {
  existsSync,
  copyFileSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  chmodSync,
  rmSync,
  mkdtempSync,
} from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import http from 'http';
import { sleep } from '../utils/sleep';
import { NOTISKIN_DIR, USER_HOME } from '../utils/constants';
import { shellQuote } from './admin';

function notionBinaryCandidates(): string[] {
  // tests point this at a copy of the fake Notion, never /Applications
  const override = process.env.NOTISKIN_NOTION_APP;
  if (override) return [join(override, 'Contents', 'MacOS', 'Notion')];
  return [
    '/Applications/Notion.app/Contents/MacOS/Notion',
    join(USER_HOME, 'Applications', 'Notion.app', 'Contents', 'MacOS', 'Notion'),
  ];
}

const STARTUP_TIMEOUT_MS = 30_000;

// size check first, real binary is many MB, don't read it into memory
export function isWrapperPresent(notionPath: string): boolean {
  try {
    if (statSync(notionPath).size > 1024) return false;
    return readFileSync(notionPath, 'utf-8').includes('notiskin-wrapper');
  } catch {
    return false;
  }
}

// watcher.ts uses this to avoid duplicating the candidate list
export function findNotionBinary(): string {
  for (const candidate of notionBinaryCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Could not find Notion.app. ' +
      'Make sure Notion is installed in /Applications or ~/Applications.'
  );
}

// /Applications/Notion.app/Contents/MacOS/Notion -> /Applications/Notion.app
export function appBundlePath(notionPath: string): string {
  return dirname(dirname(dirname(notionPath)));
}

function resignBundle(notionPath: string): void {
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appBundlePath(notionPath)], {
      stdio: 'ignore',
    });
    console.log('[patcher] App bundle re-signed (ad-hoc).');
  } catch {
    console.warn(
      '[patcher] Warning: could not re-sign the app bundle.\n' +
        '         If Notion shows "damaged application" on first launch, go to\n' +
        '         System Settings > Privacy & Security and click "Open Anyway".'
    );
  }
}

export interface WrapperOptions {
  // the desktop app runs the CLI with its own Electron binary acting as Node
  appMode?: boolean;
}

const INJECT_REDIRECT = ' inject >> "$HOME/.notiskin/logs/inject.log" 2>&1 &';

// runs as background job so it can poll for CDP while Notion.real starts
// exec replaces the shell, macOS sees the correct PID
// if the inject program is gone (Notiskin moved or deleted) only that line fails, Notion still starts
export function makeWrapperScript(nodePath: string, cliScriptPath: string, opts: WrapperOptions = {}): string {
  // the CLI line is kept byte-for-byte as earlier versions wrote it, so existing installs still match
  // the env var only applies to the inject command, it must never reach Notion.real (Notion is Electron too)
  const injectCommand = opts.appMode
    ? `ELECTRON_RUN_AS_NODE=1 ${shellQuote(nodePath)} ${shellQuote(cliScriptPath)}`
    : `"${nodePath}" "${cliScriptPath}"`;
  return [
    '#!/bin/sh',
    '# notiskin-wrapper',
    'mkdir -p "$HOME/.notiskin/logs"',
    `${injectCommand}${INJECT_REDIRECT}`,
    'exec "$(dirname "$0")/Notion.real" --remote-debugging-port=9222 "$@"',
    '',
  ].join('\n');
}

// splits the sh words our wrappers use: 'single quoted', "double quoted", and bare words
export function splitShellWords(text: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (text[i] === ' ') i++;
    if (i >= text.length) break;
    let word = '';
    while (i < text.length && text[i] !== ' ') {
      const ch = text[i];
      if (ch === "'" || ch === '"') {
        const end = text.indexOf(ch, i + 1);
        if (end < 0) throw new Error('Unterminated quote');
        word += text.slice(i + 1, end);
        i = end + 1;
      } else if (ch === '\\') {
        word += text[i + 1] ?? '';
        i += 2;
      } else {
        word += ch;
        i++;
      }
    }
    words.push(word);
  }
  return words;
}

// the program and script a wrapper runs for injection, null if it can't be read
export function wrapperInjectTarget(script: string): { program: string; cliScript: string } | null {
  const line = script.split('\n').find(l => l.endsWith(INJECT_REDIRECT));
  if (!line) return null;
  let words: string[];
  try {
    words = splitShellWords(line.slice(0, -INJECT_REDIRECT.length));
  } catch {
    return null;
  }
  // skip env assignments like ELECTRON_RUN_AS_NODE=1
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  if (words.length !== 2) return null;
  return { program: words[0], cliScript: words[1] };
}

// inside the packaged app the CLI sits in app.asar, plain Node can't look inside it, so check the archive itself
function pathExists(path: string): boolean {
  const asar = path.indexOf('.asar/');
  return existsSync(asar >= 0 ? path.slice(0, asar + '.asar'.length) : path);
}

export type NotionStatus = 'not-installed' | 'installed' | 'needs-repair' | 'notion-missing';

// read-only, works without root
export function getNotionStatus(): NotionStatus {
  let notionPath: string;
  try {
    notionPath = findNotionBinary();
  } catch {
    return 'notion-missing';
  }
  if (isWrapperPresent(notionPath)) {
    const target = wrapperInjectTarget(readFileSync(notionPath, 'utf-8'));
    // Notiskin was moved or deleted after installing, Notion still starts but nothing gets themed
    if (!target || !pathExists(target.program) || !pathExists(target.cliScript)) return 'needs-repair';
    return 'installed';
  }
  // a Notion update replaced the wrapper with a fresh binary
  return existsSync(`${notionPath}.real`) ? 'needs-repair' : 'not-installed';
}

interface Owner {
  uid: number;
  gid: number;
}

function bundleOwner(notionPath: string): Owner {
  const { uid, gid } = statSync(appBundlePath(notionPath));
  return { uid, gid };
}

// patching as root leaves root-owned files (the wrapper, whatever codesign rewrote),
// and Notion's own updater runs as the user, so give the bundle back to whoever owned it
function restoreBundleOwner(notionPath: string, owner: Owner): void {
  if (process.getuid?.() !== 0 || owner.uid === 0) return;
  try {
    execFileSync('chown', ['-R', `${owner.uid}:${owner.gid}`, appBundlePath(notionPath)], { stdio: 'ignore' });
    console.log('[patcher] Gave Notion.app back to its owner.');
  } catch {
    console.warn(`[patcher] Warning: could not reset the owner of ${appBundlePath(notionPath)}, Notion's updater may fail.`);
  }
}

const SUDOERS_FILE = '/etc/sudoers.d/notiskin';

// NOTISKIN_DIR already resolves the real user's home under sudo
export function signingHelperPath(): string {
  return join(NOTISKIN_DIR, 'Notiskin.app');
}

// .app so the password dialog says "Notiskin" not "osascript"
export function compileSigningHelper(): void {
  const helperApp = signingHelperPath();
  const helperDir = join(helperApp, '..'); // ~/.notiskin/
  const tmpScript = join(helperDir, 'notiskin_sign_tmp.applescript');

  mkdirSync(helperDir, { recursive: true });
  // osacompile fails if the bundle dir already exists
  rmSync(helperApp, { recursive: true, force: true });

  writeFileSync(
    tmpScript,
    [
      'on run argv',
      '  do shell script "codesign --force --deep --sign - " & quoted form of (item 1 of argv) with administrator privileges',
      'end run',
    ].join('\n'),
    'utf-8'
  );

  try {
    execFileSync('osacompile', ['-o', helperApp, tmpScript], { stdio: 'pipe' });
    // sudo creates files owned by root, chown back to the actual user
    const sudoUser = process.env.SUDO_USER;
    if (sudoUser) {
      execFileSync('chown', ['-R', sudoUser, helperDir], { stdio: 'ignore' });
    }
    console.log(`[patcher] Signing helper compiled at ${helperApp}`);
  } catch (err: unknown) {
    throw new Error(`Failed to compile signing helper: ${(err as Error).message}`);
  } finally {
    try { unlinkSync(tmpScript); } catch {}
  }
}

// visudo -c validates before writing, failed check leaves sudoers.d untouched
function installSudoersRule(username: string, notionPath: string): void {
  const bundle = appBundlePath(notionPath);
  const rule = [
    '# Notiskin: passwordless codesign for automatic Notion bundle re-signing.',
    '# This grants NO other elevated access, only this exact command is covered.',
    `${username} ALL = (root) NOPASSWD: /usr/bin/codesign --force --deep --sign - ${bundle}`,
    '',
  ].join('\n');

  // private temp dir, a fixed /tmp path written as root could be pre-planted as a symlink
  const tmpDir = mkdtempSync(join(tmpdir(), 'notiskin-sudoers-'));
  const tmpFile = join(tmpDir, 'rule');

  // validate before touching sudoers.d, reject means nothing was written
  writeFileSync(tmpFile, rule, { encoding: 'utf-8', mode: 0o440, flag: 'wx' });
  try {
    execFileSync('visudo', ['-c', '-f', tmpFile], { stdio: 'pipe' });
  } catch (err: unknown) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `Sudoers rule failed visudo validation, aborting, nothing written to /etc/sudoers.d/. ` +
      `${(err as { stderr?: Buffer }).stderr?.toString().trim() || (err as Error).message}`
    );
  }

  try {
    writeFileSync(SUDOERS_FILE, rule, { encoding: 'utf-8', mode: 0o440 });
    chmodSync(SUDOERS_FILE, 0o440);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`[patcher] Sudoers rule installed at ${SUDOERS_FILE}`);
  console.log('[patcher] The watcher will now re-sign automatically without prompting.');
  console.log('[patcher] Safety check: run "sudo ls /" and confirm it still asks for your password.');
  console.log('[patcher] (The rule only covers the exact codesign command, nothing else gains passwordless access.)');
}

// the wrapper is already there but runs something else, e.g. Notiskin was moved, or it was patched from the CLI before
function rewriteWrapper(notionPath: string, script: string, owner: Owner): void {
  console.log('[patcher] Updating the wrapper script...');
  try {
    writeFileSync(notionPath, script, { encoding: 'utf-8', mode: 0o755 });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error('Permission denied.\nRun: sudo npm run patch');
    }
    throw err;
  }
  resignBundle(notionPath);
  restoreBundleOwner(notionPath, owner);
  console.log('[patcher] Done. Quit Notion and reopen it normally, themes and plugins will load automatically.');
}

export function patchNotion(nodePath: string, cliScriptPath: string, opts: WrapperOptions = {}): void {
  const notionPath = findNotionBinary();
  const realPath = `${notionPath}.real`;
  const backupDir = join(NOTISKIN_DIR, 'backup');
  const backupPath = join(backupDir, 'Notion.original');
  const script = makeWrapperScript(nodePath, cliScriptPath, opts);
  // before any change, codesign and the new wrapper would otherwise make root the owner
  const owner = bundleOwner(notionPath);

  if (isWrapperPresent(notionPath)) {
    if (readFileSync(notionPath, 'utf-8') === script) {
      console.log('[patcher] Already patched, wrapper is in place.');
      return;
    }
    rewriteWrapper(notionPath, script, owner);
    return;
  }

  // never continue without a backup, no restore path means no patch
  console.log('[patcher] Backing up original binary...');
  try {
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(notionPath, backupPath);
    console.log(`[patcher] Backup saved to ${backupPath}`);
  } catch (err: unknown) {
    throw new Error(`Backup failed, aborting patch. ${(err as Error).message}`);
  }

  console.log('[patcher] Renaming Notion -> Notion.real...');
  try {
    renameSync(notionPath, realPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error('Permission denied.\nRun: sudo npm run patch');
    }
    throw err;
  }

  // restore on failure, can't leave Notion without a working binary
  console.log('[patcher] Writing wrapper script...');
  try {
    writeFileSync(notionPath, script, { encoding: 'utf-8', mode: 0o755 });
  } catch (err: unknown) {
    try {
      renameSync(realPath, notionPath);
    } catch {}
    throw new Error(`Failed to write wrapper, original restored. ${(err as Error).message}`);
  }

  resignBundle(notionPath);
  restoreBundleOwner(notionPath, owner);

  // watcher uses this to show "Notiskin" instead of "osascript" in elevation prompts
  console.log('[patcher] Compiling signing helper...');
  try {
    compileSigningHelper();
  } catch (err: unknown) {
    console.warn(`[patcher] Warning: ${(err as Error).message}`);
    console.warn('[patcher] Falling back to the "osascript" dialog name if signing prompts are needed.');
  }

  // only runs as root, no extra prompt needed beyond what the user typed for sudo
  const sudoUser = process.env.SUDO_USER || process.env.USER;
  const isRoot = process.getuid?.() === 0;
  if (isRoot && sudoUser) {
    console.log('[patcher] Installing passwordless sudoers rule for codesign...');
    try {
      installSudoersRule(sudoUser, notionPath);
    } catch (err: unknown) {
      console.warn(`[patcher] Warning: ${(err as Error).message}`);
      console.warn('[patcher] Auto-signing will use the password popup as a fallback instead.');
    }
  } else {
    console.log('[patcher] Not running as root, skipping passwordless sudoers setup.');
    console.log('[patcher] The watcher will show a password popup when re-signing. To set up silent re-signing, run: sudo npm run patch');
  }

  console.log('');
  console.log('[patcher] Done. Quit Notion and reopen it normally, themes and plugins will load automatically.');
}

export function unpatchNotion(): void {
  const notionPath = findNotionBinary();
  const realPath = `${notionPath}.real`;
  const owner = bundleOwner(notionPath);

  if (!existsSync(realPath)) {
    throw new Error(
      `Notion.real not found at ${realPath}.\n` +
        'Notion does not appear to be patched.'
    );
  }

  if (!isWrapperPresent(notionPath)) {
    console.warn(
      '[patcher] Warning: Notion file is not the Notiskin wrapper, ' +
        'it may have been replaced by a Notion update. Restoring Notion.real anyway.'
    );
  }

  console.log('[patcher] Removing wrapper...');
  try {
    unlinkSync(notionPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error('Permission denied.\nRun: sudo npm run unpatch');
    }
    throw err;
  }

  console.log('[patcher] Restoring original binary...');
  renameSync(realPath, notionPath);

  resignBundle(notionPath);
  restoreBundleOwner(notionPath, owner);

  if (existsSync(SUDOERS_FILE)) {
    try {
      unlinkSync(SUDOERS_FILE);
      console.log(`[patcher] Sudoers rule removed (${SUDOERS_FILE}).`);
    } catch {
      console.warn(`[patcher] Could not remove ${SUDOERS_FILE}, remove it manually: sudo rm ${SUDOERS_FILE}`);
    }
  }

  const PLIST_PATH = join(USER_HOME, 'Library', 'LaunchAgents', 'com.notiskin.watcher.plist');
  if (existsSync(PLIST_PATH)) {
    try {
      execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' });
    } catch {
      // agent may already be unloaded, still remove the file
    }
    try {
      unlinkSync(PLIST_PATH);
      console.log('[patcher] LaunchAgent removed.');
    } catch {
      console.warn(`[patcher] Could not remove LaunchAgent, remove it manually: rm "${PLIST_PATH}"`);
    }
  }

  const helperApp = signingHelperPath();
  if (existsSync(helperApp)) {
    try {
      rmSync(helperApp, { recursive: true, force: true });
      console.log('[patcher] Signing helper removed.');
    } catch {
      console.warn(`[patcher] Could not remove signing helper at ${helperApp}`);
    }
  }

  console.log('[patcher] Unpatch complete. Notion is fully restored.');
}

export function killNotion(): void {
  try {
    execFileSync('pkill', ['-x', 'Notion'], { stdio: 'ignore' });
    console.log('[patcher] Notion was running, closed it.');
  } catch {
    // pkill exits with code 1 when no matching process is found, that is fine
  }
}

export function launchNotion(port: number): void {
  const binary = findNotionBinary();
  // --remote-debugging-port turns on the Chrome DevTools Protocol server
  const child = spawn(binary, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref(); // let this script exit independently of Notion
}

function probeDebugServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, res => {
      res.resume();
      if (res.statusCode === 200) {
        resolve();
      } else {
        reject(new Error(`unexpected status ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    req.setTimeout(1000, () => {
      req.destroy();
      reject(new Error('probe timed out'));
    });
  });
}

export async function waitForCDP(port: number): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await probeDebugServer(port);
      console.log('[patcher] Notion debug server is ready.');
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(
    `Timed out after ${STARTUP_TIMEOUT_MS / 1000}s waiting for Notion's debug server on port ${port}. ` +
      'Check that Notion launched correctly.'
  );
}

export async function isCDPAvailable(port: number): Promise<boolean> {
  try {
    await probeDebugServer(port);
    return true;
  } catch {
    return false;
  }
}
