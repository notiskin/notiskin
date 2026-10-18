#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync, truncateSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { patchNotion, unpatchNotion } from '../patcher/index';
import { readConfig, writeConfig } from '../utils/config';
import { CDP_PORT, LOGS_DIR, NOTISKIN_DIR, THEMES_DIR, PLUGINS_DIR, INJECTOR_PID_PATH } from '../utils/constants';
import { acquirePidLock } from '../utils/pidlock';
import {
  applyConfig,
  deleteItem,
  itemExists,
  listPlugins,
  listThemes,
  activeThemeCss,
  loadEnabledPlugins,
} from '../core/library';
import { startInjectorDaemon } from '../injector/daemon';

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

// started by the wrapper script on every Notion launch (and by apply), runs until Notion quits
async function inject(): Promise<void> {
  const release = acquirePidLock(INJECTOR_PID_PATH);
  if (!release) {
    console.log('[inject] Injector is already running.');
    return;
  }
  capLog(join(LOGS_DIR, 'inject.log'));
  const stamp = (msg: string) => console.log(`[${new Date().toISOString()}] [inject] ${msg}`);

  const daemon = await startInjectorDaemon({
    port: CDP_PORT,
    loadPayload: () => {
      const config = readConfig();
      return { css: activeThemeCss(config), plugins: loadEnabledPlugins(config, stamp) };
    },
    watchPaths: [NOTISKIN_DIR, THEMES_DIR, PLUGINS_DIR],
    log: stamp,
  });
  stamp(`Watching ${daemon.attachedTargets().length} Notion tab(s).`);

  const stop = () => void daemon.stop();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await daemon.done;
  release();
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
    case 'inject':
      return inject();
    case 'patch':
      // inside the desktop app this runs on Electron's binary, so the wrapper has to set ELECTRON_RUN_AS_NODE too
      return patchNotion(process.execPath, join(__dirname, 'index.js'), { appMode: Boolean(process.versions.electron) });
    case 'unpatch':
      return unpatchNotion();
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
