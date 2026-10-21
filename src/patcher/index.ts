import { execFileSync, spawnSync } from 'child_process';
import {
  existsSync,
  copyFileSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  rmSync,
  realpathSync,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { NOTISKIN_DIR, USER_HOME } from '../utils/constants';
import { readConfig, writeConfig } from '../utils/config';
import { shellQuote } from './admin';
import { readWatcherTarget, thisCopyWatcher, uninstallWatcher, watcherPlistPath } from './agent';

function notionBinaryCandidates(): string[] {
  // tests point this at a copy of the fake Notion, never /Applications
  const override = process.env.NOTISKIN_NOTION_APP;
  if (override) return [join(override, 'Contents', 'MacOS', 'Notion')];
  return [
    '/Applications/Notion.app/Contents/MacOS/Notion',
    join(USER_HOME, 'Applications', 'Notion.app', 'Contents', 'MacOS', 'Notion'),
  ];
}

// size check first, real binary is many MB, don't read it into memory
export function isWrapperPresent(notionPath: string): boolean {
  try {
    if (statSync(notionPath).size > 16 * 1024) return false;
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

// Notion's own designated requirement: Developer ID, Notion Labs team LBQJ96FQ8D (as `codesign -d -r-` prints it)
export const NOTION_REQUIREMENT =
  'identifier "notion.id" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ ' +
  'and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = LBQJ96FQ8D';
// the label our ad hoc signature carries
export const NOTISKIN_SIGNING_ID = 'com.notiskin.patched';
// Electron's own NSApplication subclass, every Electron app's Info.plist names it, a SwiftUI Notion wouldn't
const ELECTRON_CLAUSE = 'info[NSPrincipalClass] = "AtomApplication"';

// Notion's updater (Squirrel.Mac) only takes an update that meets the running Notion's designated requirement.
// Plain ad hoc signing makes that "this exact build", so every update was refused. Real Notion builds meet the
// first half, and the patched Notion meets the second, which the keychain and privacy permissions need.
// With blockNative the first half also asks for an Electron app, so a native Notion update is refused
export function signingRequirement(blockNative: boolean): string {
  const notion = blockNative ? `${NOTION_REQUIREMENT} and ${ELECTRON_CLAUSE}` : NOTION_REQUIREMENT;
  return `designated => (${notion}) or identifier "${NOTISKIN_SIGNING_ID}"`;
}

function signOne(path: string, requirement: string): void {
  execFileSync('codesign', ['--force', '--sign', '-', '-i', NOTISKIN_SIGNING_ID, `-r=${requirement}`, path], {
    stdio: 'pipe',
  });
}

function teamOf(path: string): string | null {
  // codesign -dv writes to stderr
  const out = spawnSync('codesign', ['-dv', path], { encoding: 'utf-8' }).stderr ?? '';
  const team = /^TeamIdentifier=(.+)$/m.exec(out)?.[1];
  return team && team !== 'not set' ? team : null;
}

function squirrelPaths(bundle: string): { shipIt: string; squirrel: string; libraries: string[] } {
  const frameworks = join(bundle, 'Contents', 'Frameworks');
  const squirrel = join(frameworks, 'Squirrel.framework');
  return {
    shipIt: join(squirrel, 'Versions', 'A', 'Resources', 'ShipIt'),
    squirrel,
    libraries: [squirrel, join(frameworks, 'Mantle.framework'), join(frameworks, 'ReactiveObjC.framework')],
  };
}

// ShipIt is Notion's installer, it swaps in an update after Notion quits. Older versions signed everything inside
// ad hoc with --deep, which skips ShipIt (it sits in Squirrel.framework's Resources), so ShipIt kept Notion's team and
// macOS refused to load the now ad hoc Mantle into it: updates were accepted, then never installed
export function shipItMismatch(notionPath: string): boolean {
  const { shipIt, libraries } = squirrelPaths(appBundlePath(notionPath));
  if (!existsSync(shipIt)) return false;
  const team = teamOf(shipIt);
  return libraries.some(lib => existsSync(lib) && teamOf(lib) !== team);
}

// sign ShipIt ad hoc like the libraries around it, then the framework it sits in, whose seal covers it
function matchShipIt(notionPath: string): void {
  if (!shipItMismatch(notionPath)) return;
  const { shipIt, squirrel } = squirrelPaths(appBundlePath(notionPath));
  execFileSync('codesign', ['--force', '--sign', '-', shipIt], { stdio: 'pipe' });
  execFileSync('codesign', ['--force', '--sign', '-', squirrel], { stdio: 'pipe' });
}

// only what we changed: Notion.real (while patched), then the app itself. Notion's frameworks and helpers keep Notion's
// signatures, apart from ShipIt in a bundle older versions signed with --deep
function signChanged(notionPath: string, requirement: string): void {
  const realPath = `${notionPath}.real`;
  matchShipIt(notionPath);
  if (existsSync(realPath)) signOne(realPath, requirement);
  signOne(appBundlePath(notionPath), requirement);
}

export function signNotion(notionPath: string, blockNative = readConfig().blockNativeNotion): boolean {
  const requirement = signingRequirement(blockNative);
  try {
    signChanged(notionPath, requirement);
    console.log('[patcher] App bundle re-signed (ad-hoc, Notion updates still allowed).');
    return true;
  } catch {
    // something inside isn't validly signed any more, sign everything ad hoc first, then ours on top
    try {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', appBundlePath(notionPath)], { stdio: 'pipe' });
      signChanged(notionPath, requirement);
      console.log('[patcher] App bundle re-signed (ad-hoc, everything inside too).');
      return true;
    } catch {
      console.warn(
        '[patcher] Warning: could not re-sign the app bundle.\n' +
          '         If Notion shows "damaged application" on first launch, go to\n' +
          '         System Settings > Privacy & Security and click "Open Anyway".'
      );
      return false;
    }
  }
}

// false for installs signed before Notion updates were allowed (or whose ShipIt can't start), or before the block
// setting last changed.
// The next patch re-signs them
export function hasCurrentSignature(notionPath: string, blockNative = readConfig().blockNativeNotion): boolean {
  const realPath = `${notionPath}.real`;
  try {
    const out = execFileSync('codesign', ['-d', '-r-', existsSync(realPath) ? realPath : notionPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return (
      out.includes(`identifier "${NOTISKIN_SIGNING_ID}"`) &&
      out.includes('info[NSPrincipalClass]') === blockNative &&
      !shipItMismatch(notionPath)
    );
  } catch {
    return false;
  }
}

export interface WrapperOptions {
  // the desktop app runs the CLI with its own Electron binary acting as Node
  appMode?: boolean;
}

// the inject line ends like this, wrapperInjectTarget() finds it by this tail
const INJECT_TAIL = ' inject "$run" 3<&- 4<&- >> "$HOME/.notiskin/logs/inject.log" 2>&1 &';

// inside the packaged app the CLI sits in app.asar, plain sh and Node can't look inside it, so check the archive itself
function existencePath(path: string): string {
  const asar = path.indexOf('.asar/');
  return asar >= 0 ? path.slice(0, asar + '.asar'.length) : path;
}

// Notion gets DevTools over two FIFOs in ~/.notiskin/run/<pid> (folder 0700, pipes 0600), never a network port.
// Notion holds both ends of both pipes (3<> and 4<>), so it never sees them close and keeps running whatever
// happens to the injector. exec keeps the shell's pid, so the folder is named after Notion's own pid.
// if Notiskin is gone or any step fails, Notion starts exactly as it would without Notiskin.
// `command exec` matters: a plain exec whose redirect fails would end the script before Notion starts.
export function makeWrapperScript(nodePath: string, cliScriptPath: string, opts: WrapperOptions = {}): string {
  // the env var only applies to the inject command, it must never reach Notion.real (Notion is Electron too)
  const env = opts.appMode ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  const program = shellQuote(nodePath);
  return [
    '#!/bin/sh',
    '# notiskin-wrapper',
    'real="$(dirname "$0")/Notion.real"',
    `if [ -x ${program} ] && [ -e ${shellQuote(existencePath(cliScriptPath))} ]; then`,
    '  run="$HOME/.notiskin/run/$$"',
    '  if mkdir -p "$HOME/.notiskin/logs" "$HOME/.notiskin/run" && chmod 700 "$HOME/.notiskin/run" && rm -rf "$run" && ' +
      'mkdir -m 700 "$run" && mkfifo -m 600 "$run/in" "$run/out" && command exec 3<>"$run/in" 4<>"$run/out"; then',
    `    ${env}${program} ${shellQuote(cliScriptPath)}${INJECT_TAIL}`,
    '    exec "$real" --remote-debugging-pipe "$@"',
    '  fi',
    'fi',
    'exec "$real" "$@" 3<&- 4<&-',
    '',
  ].join('\n');
}

// wrappers before the pipe opened a debug port any program on the Mac could use, Repair replaces them
export function isLegacyWrapper(script: string): boolean {
  return script.includes('--remote-debugging-port');
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
  const line = script.split('\n').find(l => l.endsWith(INJECT_TAIL));
  if (!line) return null;
  let words: string[];
  try {
    words = splitShellWords(line.slice(0, -INJECT_TAIL.length).trimStart());
  } catch {
    return null;
  }
  // skip env assignments like ELECTRON_RUN_AS_NODE=1
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  if (words.length !== 2) return null;
  return { program: words[0], cliScript: words[1] };
}

function pathExists(path: string): boolean {
  return existsSync(existencePath(path));
}

export type NotionStatus = 'not-installed' | 'installed' | 'needs-repair' | 'notion-missing' | 'unsupported';

// Notiskin themes Notion's web page through Chromium's DevTools, which only an Electron Notion has.
// Notion is moving its Mac app to SwiftUI (announced at WWDC 2026), a native Notion is left alone until Notiskin supports it
export function isElectronNotion(notionPath: string): boolean {
  return existsSync(join(appBundlePath(notionPath), 'Contents', 'Frameworks', 'Electron Framework.framework'));
}

export const UNSUPPORTED_MESSAGE =
  "This version of Notion isn't built on Electron, so Notiskin can't theme it yet. Notion was left unchanged.";

// read-only, works without root
export function getNotionStatus(): NotionStatus {
  let notionPath: string;
  try {
    notionPath = findNotionBinary();
  } catch {
    return 'notion-missing';
  }
  if (!isElectronNotion(notionPath)) return 'unsupported';
  if (isWrapperPresent(notionPath)) {
    const script = readFileSync(notionPath, 'utf-8');
    if (isLegacyWrapper(script)) return 'needs-repair';
    const target = wrapperInjectTarget(script);
    // Notiskin was moved or deleted after installing, Notion still starts but nothing gets themed
    if (!target || !pathExists(target.program) || !pathExists(target.cliScript)) return 'needs-repair';
    return 'installed';
  }
  // a Notion update replaced the wrapper with a fresh binary, or the whole app (Notion's updater swaps the bundle)
  if (existsSync(`${notionPath}.real`) || readConfig().notionInstalled) return 'needs-repair';
  return 'not-installed';
}

// the same file however it's spelled (symlinks, `..`), the part inside app.asar is compared as written
function canonicalPath(path: string): string {
  const onDisk = existencePath(path);
  try {
    return realpathSync(onDisk) + path.slice(onDisk.length);
  } catch {
    return resolve(path);
  }
}

// the same file, however each path is spelled
export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

// true when Notion's current wrapper runs a different Notiskin than the one given (what patchNotion() would write
// for that copy), e.g. Notion was installed from a worktree and then the app was downloaded. Read-only, no root.
// Not part of getNotionStatus(): every copy, the watcher included, would call the others' wrappers broken
export function wrapperRunsOtherCopy(program: string, cliScript: string): boolean {
  try {
    const notionPath = findNotionBinary();
    if (!isWrapperPresent(notionPath)) return false;
    const target = wrapperInjectTarget(readFileSync(notionPath, 'utf-8'));
    if (!target) return false;
    return !samePath(target.program, program) || !samePath(target.cliScript, cliScript);
  } catch {
    return false;
  }
}

// whether the watcher's LaunchAgent runs this copy of Notiskin, null when there's no watcher
export function watcherRunsThisCopy(): boolean | null {
  const installed = readWatcherTarget();
  if (!installed) return null;
  const ours = thisCopyWatcher();
  return installed.appMode === ours.appMode && samePath(installed.program, ours.program) && samePath(installed.script, ours.script);
}

// remembered so a Notion update, which leaves no trace of Notiskin in the app, shows as needs-repair
function setInstalled(installed: boolean): void {
  try {
    const config = readConfig();
    if (config.notionInstalled !== installed) writeConfig({ ...config, notionInstalled: installed });
  } catch (err: unknown) {
    console.warn(`[patcher] Warning: could not save the install state. ${(err as Error).message}`);
  }
}

// true when Notion has a wrapper from before the pipe, the desktop app repairs these on start
export function hasLegacyWrapper(): boolean {
  try {
    const notionPath = findNotionBinary();
    return isWrapperPresent(notionPath) && isLegacyWrapper(readFileSync(notionPath, 'utf-8'));
  } catch {
    return false;
  }
}

// true when Notion is patched but signed the old way (which blocked Notion's own updates), or not yet re-signed
// after the block setting changed. The desktop app re-signs these on start
export function hasOldSignature(): boolean {
  try {
    const notionPath = findNotionBinary();
    return isWrapperPresent(notionPath) && !hasCurrentSignature(notionPath);
  } catch {
    return false;
  }
}

// re-signs a patched Notion after the block setting changed
export function resignNotion(): 'signed' | 'not-patched' | 'failed' {
  let notionPath: string;
  try {
    notionPath = findNotionBinary();
  } catch {
    return 'not-patched';
  }
  if (!isWrapperPresent(notionPath)) return 'not-patched';
  const owner = bundleOwner(notionPath);
  const signed = signNotion(notionPath);
  restoreBundleOwner(notionPath, owner);
  return signed ? 'signed' : 'failed';
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

// older versions set up passwordless root signing for the watcher: this rule and a password helper app.
// Signing never needed root (Notion.app belongs to the user), so they aren't made any more, unpatch still removes them
const SUDOERS_FILE = '/etc/sudoers.d/notiskin';

// NOTISKIN_DIR already resolves the real user's home under sudo
export function signingHelperPath(): string {
  return join(NOTISKIN_DIR, 'Notiskin.app');
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
  signNotion(notionPath);
  restoreBundleOwner(notionPath, owner);
  setInstalled(true);
  console.log('[patcher] Done. Quit Notion and reopen it normally, themes and plugins will load automatically.');
}

export function patchNotion(nodePath: string, cliScriptPath: string, opts: WrapperOptions = {}): void {
  const notionPath = findNotionBinary();
  // checked before anything is touched, a native Notion wouldn't open the DevTools pipe the wrapper expects
  if (!isElectronNotion(notionPath)) throw new Error(UNSUPPORTED_MESSAGE);
  const realPath = `${notionPath}.real`;
  const backupDir = join(NOTISKIN_DIR, 'backup');
  const backupPath = join(backupDir, 'Notion.original');
  const script = makeWrapperScript(nodePath, cliScriptPath, opts);
  // before any change, codesign and the new wrapper would otherwise make root the owner
  const owner = bundleOwner(notionPath);

  if (isWrapperPresent(notionPath)) {
    if (readFileSync(notionPath, 'utf-8') === script) {
      console.log('[patcher] Already patched, wrapper is in place.');
      if (!hasCurrentSignature(notionPath)) {
        // signed the old way or before the block setting changed, re-sign so the next update is handled right
        signNotion(notionPath);
        restoreBundleOwner(notionPath, owner);
      }
      setInstalled(true);
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

  signNotion(notionPath);
  restoreBundleOwner(notionPath, owner);
  setInstalled(true);

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

  // Notion can still update itself after an uninstall, nothing is held back any more
  signNotion(notionPath, false);
  restoreBundleOwner(notionPath, owner);
  setInstalled(false);

  if (existsSync(SUDOERS_FILE)) {
    try {
      unlinkSync(SUDOERS_FILE);
      console.log(`[patcher] Sudoers rule removed (${SUDOERS_FILE}).`);
    } catch {
      console.warn(`[patcher] Could not remove ${SUDOERS_FILE}, remove it manually: sudo rm ${SUDOERS_FILE}`);
    }
  }

  try {
    if (uninstallWatcher()) console.log('[patcher] LaunchAgent removed.');
  } catch {
    console.warn(`[patcher] Could not remove LaunchAgent, remove it manually: rm "${watcherPlistPath()}"`);
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
