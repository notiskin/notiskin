// fs.watch uses FSEvents on macOS, not polling
import { watch } from 'fs';
import { execSync } from 'child_process';
import { existsSync, copyFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { findNotionBinary, isWrapperPresent, makeWrapperScript, signingHelperPath } from './index';

// __dirname here is dist/patcher/, step up one level to reach dist/cli/index.js
const CLI_SCRIPT = join(__dirname, '..', 'cli', 'index.js');

function isNotionRunning(): boolean {
  try {
    execSync('pgrep -x Notion', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntilNotionClosed(): Promise<void> {
  while (isNotionRunning()) {
    await sleep(2000);
  }
  // Brief settle so the OS releases all file handles before we touch anything
  await sleep(1000);
}

function appBundlePath(notionPath: string): string {
  return dirname(dirname(dirname(notionPath)));
}

async function repatch(notionPath: string): Promise<void> {
  const realPath = `${notionPath}.real`;
  const backupDir = join(homedir(), '.notiskin', 'backup');
  const backupPath = join(backupDir, 'Notion.original');

  console.log('[watcher] Notion update detected. Waiting for Notion to close before touching files...');
  await waitUntilNotionClosed();

  // Re-check after Notion has fully quit, rare but the update might have re-run
  if (isWrapperPresent(notionPath)) {
    console.log('[watcher] Wrapper already in place after quit. Nothing to do.');
    return;
  }

  console.log('[watcher] Repatching...');

  // backup the updated binary so unpatch doesn't restore a stale version
  try {
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(notionPath, backupPath);
    console.log(`[watcher] Backed up updated binary to ${backupPath}`);
  } catch (err: unknown) {
    const msg = (err as NodeJS.ErrnoException).code === 'EACCES'
      ? 'Permission denied, watcher needs the same privileges used for the original patch (sudo).'
      : (err as Error).message;
    throw new Error(`Backup failed: ${msg}`);
  }

  renameSync(notionPath, realPath);
  writeFileSync(notionPath, makeWrapperScript(process.execPath, CLI_SCRIPT), { encoding: 'utf-8', mode: 0o755 });

  const bundle = appBundlePath(notionPath);
  let signed = false;

  // tier 1: passwordless via sudoers rule installed at patch time, no prompt, normal path
  try {
    execSync(`sudo /usr/bin/codesign --force --deep --sign - "${bundle}"`, { stdio: 'pipe' });
    signed = true;
    console.log('[watcher] Bundle re-signed successfully.');
  } catch (signErr: unknown) {
    const detail =
      (signErr as { stderr?: Buffer }).stderr?.toString().trim() ||
      (signErr as Error).message;
    console.warn('[watcher] Passwordless codesign failed (sudoers rule may be missing):', detail);
  }

  // tier 2: Notiskin.app helper shows "Notiskin" in the dialog, not "osascript"; watcher stays unprivileged
  if (!signed) {
    const helperApp = signingHelperPath();
    if (existsSync(helperApp)) {
      console.log('[watcher] Prompting for administrator password via Notiskin signing helper...');
      try {
        execSync(`osascript "${helperApp}" "${bundle}"`, { stdio: 'pipe' });
        signed = true;
        console.log('[watcher] Bundle re-signed successfully (via admin prompt).');
      } catch (elevErr: unknown) {
        const elevDetail =
          (elevErr as { stderr?: Buffer }).stderr?.toString().trim() ||
          (elevErr as Error).message;
        if (elevDetail) console.warn('[watcher] Signing helper failed:', elevDetail);
      }
    } else {
      console.warn('[watcher] Signing helper not found at', helperApp);
    }
  }

  // tier 3: pop a notification so the user isn't silently left with an unsigned bundle
  if (!signed) {
    console.warn('[watcher] Re-signing was not completed (prompt cancelled or no UI session).');
    console.warn('[watcher] Repatch is complete but the bundle is unsigned.');
    console.warn('[watcher] Fix: run sudo npm run patch to reinstall the signing setup.');
    try {
      execSync(
        `osascript -e 'display notification "Bundle not signed after auto-repatch. Run: sudo npm run patch" with title "Notiskin" subtitle "Action required"'`,
        { stdio: 'ignore' }
      );
    } catch {
      // osascript needs a UI session, skip if the machine is locked or headless
    }
  }

  console.log('[watcher] Repatch complete.');
}

function main(): void {
  let notionPath: string;
  try {
    notionPath = findNotionBinary();
  } catch (err: unknown) {
    console.error('[watcher]', (err as Error).message);
    process.exit(1);
  }

  const watchDir = dirname(notionPath);
  console.log(`[watcher] Watching ${watchDir} for changes...`);

  let busy = false;

  watch(watchDir, async (_event, filename) => {
    if (busy) return;
    // only repatch when the main executable changes, ignore Notion.real and other files
    if (filename !== 'Notion') return;
    if (!existsSync(notionPath)) return;
    if (isWrapperPresent(notionPath)) return;

    busy = true;
    try {
      await repatch(notionPath);
    } catch (err: unknown) {
      console.error('[watcher] Repatch failed:', (err as Error).message);
    } finally {
      busy = false;
    }
  });
}

main();
