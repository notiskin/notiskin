#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync, truncateSync } from 'fs';
import { basename, join, resolve } from 'path';
import { homedir } from 'os';
import { patchNotion, unpatchNotion } from '../patcher/index';
import { readConfig, writeConfig } from '../utils/config';
import { LOGS_DIR, NOTISKIN_DIR, THEMES_DIR, PLUGINS_DIR, INJECTOR_PID_PATH } from '../utils/constants';
import { acquirePidLock } from '../utils/pidlock';
import {
  applyConfig,
  currentPayload,
  deleteItem,
  itemExists,
  listPlugins,
  listThemes,
} from '../core/library';
import { startInjectorDaemon } from '../injector/daemon';
import { findNotionRun, PipeRun, runPid } from '../injector/pipe';
import { askInjector } from '../injector/control';
import { sleep } from '../utils/sleep';
import { diagnosticsReport } from '../core/diagnostics';

const PLUGIN_WARNING = `
WARNING: Plugins run with full, unrestricted access to your Notion page and data.
Only enable plugins from sources you trust.
Notiskin does not sandbox or review plugin code.
`;

const USAGE = `Usage: notiskin <command>

  (no command)              apply the active theme and enabled plugins
  themes                    list installed themes (* = active)
  theme <name>              switch theme and apply
  theme clear               remove the active theme
  theme delete <name>       delete an installed theme
  plugins                   list installed plugins (* = enabled)
  plugin enable <name>      enable a plugin and apply
  plugin disable <name>     disable a plugin and apply
  plugin delete <name>      delete an installed plugin
  safe-mode [on|off]        pause all themes and plugins (or show whether they're paused)
  diagnostics               print a report for bug reports (page links, IDs and your username hidden)
  patch                     make Notion load Notiskin on every launch
  unpatch                   fully restore Notion and remove everything patch added
  watch:install             repatch automatically after Notion updates
  watch:uninstall           stop the update watcher

Themes live in ~/.notiskin/themes, plugins in ~/.notiskin/plugins.`;

class UsageError extends Error {}

function log(msg: string): void {
  console.log(msg);
}

function requireName(name: string | undefined, usage: string): string {
  if (!name) throw new UsageError(`Usage: notiskin ${usage}`);
  return name;
}

function notFound(kind: 'theme' | 'plugin', name: string): never {
  const available = kind === 'theme' ? listThemes() : listPlugins();
  throw new Error(
    `${kind === 'theme' ? 'Theme' : 'Plugin'} '${name}' not found. ` +
      (available.length ? `Installed: ${available.join(', ')}` : `No ${kind}s installed yet.`)
  );
}

async function apply(opts: { reload?: boolean } = {}): Promise<void> {
  const config = readConfig();
  if (config.safeMode) console.log('Safe mode is on, nothing will be injected. Turn it off with: notiskin safe-mode off');
  console.log(`Theme:   ${config.activeTheme || '(none)'}`);
  console.log(`Plugins: ${config.enabledPlugins.join(', ') || '(none)'}`);
  await applyConfig({ restartIfNeeded: true, reload: opts.reload, log });
  console.log('Done.');
}

function printList(items: string[], isActive: (name: string) => boolean, empty: string): void {
  if (items.length === 0) {
    console.log(empty);
    return;
  }
  for (const item of items) console.log(`  ${isActive(item) ? '*' : ' '} ${item}`);
}

const PLIST_LABEL = 'com.notiskin.watcher';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function installWatcher(): void {
  const watcherScript = join(__dirname, '..', 'patcher', 'watcher.js');
  if (!existsSync(watcherScript)) {
    throw new Error(`${watcherScript} not found. Run 'npm run build' first.`);
  }
  const watcherLog = join(LOGS_DIR, 'watcher.log');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(process.execPath)}</string>
        <string>${xmlEscape(watcherScript)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(watcherLog)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(watcherLog)}</string>
</dict>
</plist>`;

  mkdirSync(LOGS_DIR, { recursive: true });
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(PLIST_PATH, plist, 'utf-8');
  console.log(`[watcher] Plist written to ${PLIST_PATH}`);

  try {
    execFileSync('launchctl', ['load', PLIST_PATH], { stdio: 'inherit' });
  } catch {
    throw new Error(`Failed to load the LaunchAgent. The plist was written, try: launchctl load "${PLIST_PATH}"`);
  }
  console.log('[watcher] LaunchAgent loaded, the watcher runs now and at every login.');
  console.log(`[watcher] Logs: ${watcherLog}`);
  console.log('[watcher] To stop: notiskin watch:uninstall');
}

function uninstallWatcher(): void {
  if (!existsSync(PLIST_PATH)) {
    console.log('[watcher] No LaunchAgent found at', PLIST_PATH);
    return;
  }
  // unload fails if the agent isn't running, still remove the plist
  try { execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' }); } catch {}
  unlinkSync(PLIST_PATH);
  console.log('[watcher] LaunchAgent unloaded and removed.');
}

async function themeCommand(args: string[]): Promise<void> {
  const [sub, arg] = args;
  if (sub === 'clear') {
    writeConfig({ ...readConfig(), activeTheme: '' });
    console.log('Active theme cleared.');
    await apply();
    return;
  }
  if (sub === 'delete') {
    const name = requireName(arg, 'theme delete <name>');
    if (!deleteItem('theme', name)) notFound('theme', name);
    console.log(`Theme '${name}' deleted.`);
    return;
  }
  const name = requireName(sub, 'theme <name>');
  if (!itemExists('theme', name)) notFound('theme', name);
  writeConfig({ ...readConfig(), activeTheme: name });
  console.log(`Active theme set to '${name}'.`);
  await apply();
}

async function pluginCommand(args: string[]): Promise<void> {
  const [sub, arg] = args;
  if (sub === 'enable') {
    const name = requireName(arg, 'plugin enable <name>');
    if (!itemExists('plugin', name)) notFound('plugin', name);
    const config = readConfig();
    if (config.enabledPlugins.includes(name)) {
      console.log(`Plugin '${name}' is already enabled.`);
    } else {
      console.warn(PLUGIN_WARNING);
      config.enabledPlugins.push(name);
      // enabling from the CLI is an explicit choice, count it as acknowledging the warning
      if (!config.acknowledgedPlugins.includes(name)) config.acknowledgedPlugins.push(name);
      writeConfig(config);
      console.log(`Plugin '${name}' enabled.`);
    }
    await apply();
    return;
  }
  if (sub === 'disable') {
    const name = requireName(arg, 'plugin disable <name>');
    const config = readConfig();
    if (!config.enabledPlugins.includes(name)) {
      console.log(`Plugin '${name}' is not currently enabled.`);
      return;
    }
    config.enabledPlugins = config.enabledPlugins.filter(p => p !== name);
    writeConfig(config);
    console.log(`Plugin '${name}' disabled. Reloading Notion to remove it...`);
    // JS can't be un-run, the page has to reload to drop the plugin
    await apply({ reload: true });
    return;
  }
  if (sub === 'delete') {
    const name = requireName(arg, 'plugin delete <name>');
    const wasEnabled = readConfig().enabledPlugins.includes(name);
    if (!deleteItem('plugin', name)) notFound('plugin', name);
    console.log(`Plugin '${name}' deleted.`);
    if (wasEnabled) await applyConfig({ reload: true, log });
    return;
  }
  throw new UsageError('Usage: notiskin plugin <enable|disable|delete> <name>');
}

async function safeModeCommand(args: string[]): Promise<void> {
  const [sub] = args;
  const config = readConfig();
  if (sub === undefined) {
    console.log(`Safe mode is ${config.safeMode ? 'on' : 'off'}.`);
    return;
  }
  if (sub !== 'on' && sub !== 'off') throw new UsageError('Usage: notiskin safe-mode [on|off]');
  const on = sub === 'on';
  writeConfig({ ...config, safeMode: on });
  // plugins can't be un-run, so turning it on reloads the page; never restarts a closed Notion
  const applied = await applyConfig({ reload: on, log });
  console.log(on ? 'Safe mode on, themes and plugins are paused.' : 'Safe mode off, themes and plugins are back.');
  if (!applied) console.log('(Notion is not running with Notiskin right now, the change applies next time it starts.)');
}

// started by the wrapper script on every Notion launch (with Notion's pipe folder), and by the app and
// CLI without one when Notion is running but the injector isn't. Runs until Notion quits
async function inject(runArg?: string): Promise<void> {
  const stamp = (msg: string) => console.log(`[${new Date().toISOString()}] [inject] ${msg}`);
  let run: PipeRun | null = null;
  if (runArg) {
    const pid = runPid(resolve(runArg));
    if (pid) run = { dir: resolve(runArg), pid };
  } else {
    run = findNotionRun();
  }
  if (!run) {
    stamp('Notion is not running with Notiskin. If Notion was started by an older Notiskin, repair it in Settings or run: notiskin patch');
    return;
  }

  let release = acquirePidLock(INJECTOR_PID_PATH);
  if (!release) {
    const status = await askInjector({ cmd: 'status' }, 2000);
    if (status?.pid === run.pid) {
      console.log('[inject] Injector is already running.');
      return;
    }
    // the one holding the lock serves a Notion that just quit, it notices within a second
    for (let i = 0; i < 40 && !release; i++) {
      await sleep(250);
      release = acquirePidLock(INJECTOR_PID_PATH);
    }
    if (!release) {
      console.log('[inject] Another injector is still running.');
      return;
    }
  }
  capLog(join(LOGS_DIR, 'inject.log'));

  const daemon = await startInjectorDaemon({
    run,
    loadPayload: () => currentPayload(readConfig(), stamp),
    watchPaths: [NOTISKIN_DIR, THEMES_DIR, PLUGINS_DIR],
    controlSocket: true,
    cleanUpRun: true,
    log: stamp,
  });
  stamp(`Watching ${daemon.attachedTargets().length} Notion tab(s).`);

  // the lock is only given up when this process exits (acquirePidLock releases it on exit), so a new injector
  // can never start while this one still has Notion's pipe open, two readers would steal each other's replies
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= daemon.stop().catch(() => {});
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await daemon.done;
  // tidying up after a stop (detaching from tabs) gets a few seconds at most
  if (stopping) await Promise.race([stopping, sleep(3000)]);
  process.exit(0);
}

// `sudo npm run patch` rebuilds dist/ as root first, hand it back so the next plain `npm run ...` can rebuild it
function restoreDistOwner(): void {
  const sudoUser = process.env.SUDO_USER;
  const dist = join(__dirname, '..');
  if (process.getuid?.() !== 0 || !sudoUser || dist.includes('.asar') || basename(dist) !== 'dist') return;
  try {
    execFileSync('chown', ['-R', sudoUser, dist], { stdio: 'ignore' });
  } catch {
    console.warn(`[patcher] Could not give ${dist} back to ${sudoUser}, run: sudo chown -R ${sudoUser} "${dist}"`);
  }
}

function asRootCommand(fn: () => void): void {
  try {
    fn();
  } finally {
    restoreDistOwner();
  }
}

// the injector now lives as long as Notion, keep its log from growing forever
function capLog(path: string, maxBytes = 1024 * 1024): void {
  try {
    if (statSync(path).size > maxBytes) truncateSync(path, 0);
  } catch {}
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case 'apply':
      return apply();
    case 'themes': {
      const active = readConfig().activeTheme;
      console.log('Installed themes:');
      return printList(listThemes(), t => t === active, '  (none, install some from the Notiskin app)');
    }
    case 'theme':
      return themeCommand(rest);
    case 'plugins': {
      const { enabledPlugins } = readConfig();
      console.log('Installed plugins:');
      return printList(listPlugins(), p => enabledPlugins.includes(p), '  (none, install some from the Notiskin app)');
    }
    case 'plugin':
      return pluginCommand(rest);
    case 'safe-mode':
      return safeModeCommand(rest);
    case 'diagnostics':
      console.log(await diagnosticsReport());
      return;
    case 'inject':
      return inject(rest[0]);
    case 'patch':
      // inside the desktop app this runs on Electron's binary, so the wrapper has to set ELECTRON_RUN_AS_NODE too
      return asRootCommand(() =>
        patchNotion(process.execPath, join(__dirname, 'index.js'), { appMode: Boolean(process.versions.electron) })
      );
    case 'unpatch':
      return asRootCommand(unpatchNotion);
    case 'watch:install':
      return installWatcher();
    case 'watch:uninstall':
      return uninstallWatcher();
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      throw new UsageError(`Unknown command '${command}'.\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(err.message);
    process.exit(2);
  }
  console.error('\nError:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
