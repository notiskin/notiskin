// fs.watch uses FSEvents on macOS, not polling
import { watch } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { appBundlePath, findNotionBinary, getNotionStatus, patchNotion } from './index';

// __dirname here is dist/patcher/, step up one level to reach dist/cli/index.js
const CLI_SCRIPT = join(__dirname, '..', 'cli', 'index.js');

// a missed event (the Mac was asleep, say) is caught by this slower check
const FALLBACK_CHECK_MS = 10 * 60_000;

function pgrep(name: string): boolean {
  try {
    execFileSync('pgrep', ['-x', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// a patched Notion runs as Notion.real, so both names count as running
function isNotionRunning(): boolean {
  return pgrep('Notion') || pgrep('Notion.real');
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

function notify(message: string): void {
  try {
    execFileSync('osascript', ['-e', `display notification "${message}" with title "Notiskin"`], { stdio: 'ignore' });
  } catch {
    // osascript needs a UI session, skip if the machine is locked or headless
  }
}

// the same patch the CLI and the app run, as the user: Notion.app belongs to the user, so no sudo is needed
async function repatch(): Promise<void> {
  console.log('[watcher] Notion was updated. Waiting for Notion to close before touching files...');
  await waitUntilNotionClosed();

  // re-check after Notion has fully quit, the user may have repaired it in the meantime
  if (getNotionStatus() !== 'needs-repair') {
    console.log('[watcher] Nothing to repair after quit.');
    return;
  }

  console.log('[watcher] Repatching...');
  try {
    patchNotion(process.execPath, CLI_SCRIPT, { appMode: Boolean(process.versions.electron) });
    console.log('[watcher] Repatch complete.');
  } catch (err: unknown) {
    console.error('[watcher] Repatch failed:', (err as Error).message);
    notify('Notion was updated but Notiskin could not reinstall. Open Notiskin and click Repair.');
  }
}

function main(): void {
  let notionPath: string;
  try {
    notionPath = findNotionBinary();
  } catch (err: unknown) {
    console.error('[watcher]', (err as Error).message);
    process.exit(1);
  }

  let macosWatch: ReturnType<typeof watch> | null = null;
  const watchMacOS = (): void => {
    macosWatch?.close();
    try {
      macosWatch = watch(dirname(notionPath), (_event, filename) => {
        if (filename === 'Notion') void check();
      });
    } catch {
      macosWatch = null; // Notion.app is being swapped right now, the next check tries again
    }
  };
  let busy = false;
  const check = async (): Promise<void> => {
    if (busy || getNotionStatus() !== 'needs-repair') return;
    busy = true;
    try {
      await repatch();
    } finally {
      // the folder being watched belonged to the Notion.app that was just replaced
      watchMacOS();
      busy = false;
    }
  };

  const bundle = appBundlePath(notionPath);
  const appsDir = dirname(bundle);
  console.log(`[watcher] Watching ${appsDir} and ${dirname(notionPath)} for Notion updates...`);
  // Notion's updater swaps the whole Notion.app, which only shows up in the folder that holds it,
  // older updates overwrote Contents/MacOS/Notion in place, which only shows up in that folder
  watch(appsDir, (_event, filename) => {
    if (filename === 'Notion.app') void check();
  });
  watchMacOS();
  setInterval(() => {
    watchMacOS();
    void check();
  }, FALLBACK_CHECK_MS);
  void check();
}

main();
