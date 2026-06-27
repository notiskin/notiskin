#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { killNotion, launchNotion, waitForCDP, isCDPAvailable, patchNotion, unpatchNotion } from '../patcher/index';
import { applyAll, reloadAndReapply, PluginEntry } from '../injector/index';
import { readConfig, writeConfig } from '../utils/config';
import { sleep } from '../utils/sleep';

const CDP_PORT = 9222;
const THEMES_DIR = join(__dirname, '..', '..', 'themes');
const PLUGINS_DIR = join(__dirname, '..', '..', 'plugins');

const PLUGIN_WARNING = `
WARNING: Plugins run with full, unrestricted access to your Notion page and data.
Only enable plugins from sources you trust.
Notiskin does not sandbox or review plugin code.
`;

function listThemes(): string[] {
  return readdirSync(THEMES_DIR)
    .filter(f => f.endsWith('.css'))
    .map(f => f.replace(/\.css$/, ''));
}

function themePath(name: string): string {
  return join(THEMES_DIR, `${name}.css`);
}

function listPlugins(): string[] {
  if (!existsSync(PLUGINS_DIR)) return [];
  return readdirSync(PLUGINS_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => f.replace(/\.js$/, ''));
}

function pluginPath(name: string): string {
  return join(PLUGINS_DIR, `${name}.js`);
}

function loadEnabledPlugins(enabledNames: string[]): PluginEntry[] {
  const entries: PluginEntry[] = [];
  for (const name of enabledNames) {
    const path = pluginPath(name);
    if (!existsSync(path)) {
      console.warn(`[plugins] Warning: plugin '${name}' is enabled but plugins/${name}.js was not found, skipping.`);
      continue;
    }
    entries.push({ name, content: readFileSync(path, 'utf-8') });
  }
  return entries;
}

async function applyNotiskin(themeName: string): Promise<void> {
  const cssFile = themePath(themeName);
  if (!existsSync(cssFile)) {
    const available = listThemes();
    console.error(`Error: theme '${themeName}' not found in themes/`);
    console.error(`Available themes: ${available.join(', ')}`);
    process.exit(1);
  }

  const config = readConfig();
  const plugins = loadEnabledPlugins(config.enabledPlugins);
  const cssContent = readFileSync(cssFile, 'utf-8');

  console.log(`Notiskin: applying theme: ${themeName}`);
  if (plugins.length > 0) {
    console.log(`          plugins: ${plugins.map(p => p.name).join(', ')}`);
  }
  console.log('='.repeat(40));

  if (await isCDPAvailable(CDP_PORT)) {
    console.log('Notion is running, applying live (no restart)...');
    await applyAll(cssContent, plugins, CDP_PORT);
  } else {
    killNotion();
    await sleep(1500);
    console.log(`Launching Notion with remote debugging on port ${CDP_PORT}...`);
    launchNotion(CDP_PORT);
    await waitForCDP(CDP_PORT);
    await applyAll(cssContent, plugins, CDP_PORT);
  }

  console.log('');
  console.log(
    `Done! Theme '${themeName}' applied${plugins.length > 0 ? ` with ${plugins.length} plugin(s)` : ''}.`
  );
}

const PLIST_LABEL = 'com.notiskin.watcher';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

function installWatcher(): void {
  const watcherScript = join(__dirname, '..', 'patcher', 'watcher.js');
  if (!existsSync(watcherScript)) {
    console.error(`Error: ${watcherScript} not found. Run 'npm run build' first.`);
    process.exit(1);
  }

  const logsDir = join(homedir(), '.notiskin', 'logs');
  const watcherLog = join(logsDir, 'watcher.log');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${watcherScript}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${watcherLog}</string>
    <key>StandardErrorPath</key>
    <string>${watcherLog}</string>
</dict>
</plist>`;

  mkdirSync(logsDir, { recursive: true });
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(PLIST_PATH, plist, 'utf-8');
  console.log(`[watcher] Plist written to ${PLIST_PATH}`);

  try {
    execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'inherit' });
    console.log('[watcher] LaunchAgent loaded, watcher starts now and at every login.');
    console.log(`[watcher] Logs: ${watcherLog}`);
    console.log('[watcher] To stop: npm run watch:uninstall');
  } catch {
    console.error('[watcher] Failed to load LaunchAgent. The plist was written but not started.');
    console.error(`[watcher] Try manually: launchctl load "${PLIST_PATH}"`);
    process.exit(1);
  }
}

function uninstallWatcher(): void {
  if (!existsSync(PLIST_PATH)) {
    console.log('[watcher] No LaunchAgent found at', PLIST_PATH);
    return;
  }
  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' });
  } catch {
    // unload fails if the agent isn't currently running, that's fine, still remove the plist
  }
  unlinkSync(PLIST_PATH);
  console.log('[watcher] LaunchAgent unloaded and removed.');
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === 'themes') {
    const themes = listThemes();
    const active = readConfig().activeTheme;
    console.log('Available themes:');
    for (const t of themes) {
      console.log(`  ${t === active ? '* ' : '  '}${t}`);
    }
    return;
  }

  if (command === 'theme') {
    const subOrName = process.argv[3];

    if (subOrName === 'delete') {
      const name = process.argv[4];
      if (!name) {
        console.error('Usage: npm run theme -- delete <name>');
        process.exit(1);
      }
      if (!existsSync(themePath(name))) {
        console.error(`Theme '${name}' not found.`);
        process.exit(1);
      }
      try { unlinkSync(themePath(name)); } catch {}
      const config = readConfig();
      if (config.activeTheme === name) {
        writeConfig({ ...config, activeTheme: '' });
        console.log(`Active theme cleared. Notion will use default styling.`);
      } else {
        writeConfig(config);
      }
      console.log(`Theme '${name}' deleted.`);
      return;
    }

    const name = subOrName;
    if (!name) {
      console.error('Usage: npm run theme -- <name>');
      console.error(`Available themes: ${listThemes().join(', ')}`);
      process.exit(1);
    }
    if (!existsSync(themePath(name))) {
      const available = listThemes();
      console.error(`Error: theme '${name}' not found in themes/`);
      console.error(`Available themes: ${available.join(', ')}`);
      process.exit(1);
    }
    const existing = readConfig();
    writeConfig({ ...existing, activeTheme: name });
    console.log(`Active theme set to '${name}'.`);
    await applyNotiskin(name);
    return;
  }

  if (command === 'plugins') {
    const all = listPlugins();
    const { enabledPlugins } = readConfig();
    if (all.length === 0) {
      console.log('No plugins found in plugins/.');
      return;
    }
    console.log('Available plugins:');
    for (const p of all) {
      console.log(`  ${enabledPlugins.includes(p) ? '* ' : '  '}${p}`);
    }
    return;
  }

  if (command === 'plugin') {
    const subcommand = process.argv[3];
    const name = process.argv[4];

    if (subcommand === 'enable') {
      if (!name) {
        console.error('Usage: npm run plugin -- enable <name>');
        const available = listPlugins();
        if (available.length > 0) console.error(`Available plugins: ${available.join(', ')}`);
        process.exit(1);
      }
      if (!existsSync(pluginPath(name))) {
        const available = listPlugins();
        console.error(`Error: plugin '${name}' not found in plugins/`);
        if (available.length > 0) {
          console.error(`Available plugins: ${available.join(', ')}`);
        } else {
          console.error('No plugins found in plugins/.');
        }
        process.exit(1);
      }
      const config = readConfig();
      if (config.enabledPlugins.includes(name)) {
        console.log(`Plugin '${name}' is already enabled.`);
      } else {
        console.warn(PLUGIN_WARNING);
        config.enabledPlugins.push(name);
        writeConfig(config);
        console.log(`Plugin '${name}' enabled.`);
      }

      if (await isCDPAvailable(CDP_PORT)) {
        // inject only this plugin, don't restart or touch other running plugins
        console.log('Notion is running, injecting plugin live (no restart)...');
        const cssContent = readFileSync(themePath(config.activeTheme), 'utf-8');
        const plugin: PluginEntry = { name, content: readFileSync(pluginPath(name), 'utf-8') };
        await applyAll(cssContent, [plugin], CDP_PORT);
      } else {
        await applyNotiskin(config.activeTheme);
      }
      return;
    }

    if (subcommand === 'disable') {
      if (!name) {
        console.error('Usage: npm run plugin -- disable <name>');
        process.exit(1);
      }
      const config = readConfig();
      if (!config.enabledPlugins.includes(name)) {
        console.log(`Plugin '${name}' is not currently enabled.`);
        return;
      }
      config.enabledPlugins = config.enabledPlugins.filter(p => p !== name);
      writeConfig(config);
      console.log(`Plugin '${name}' disabled.`);

      if (await isCDPAvailable(CDP_PORT)) {
        // need a full reload to evict the plugin, can't selectively un-inject JS
        console.log('Notion is running, reloading page to remove plugin (takes ~1s)...');
        const cssContent = readFileSync(themePath(config.activeTheme), 'utf-8');
        const remainingPlugins = loadEnabledPlugins(config.enabledPlugins);
        await reloadAndReapply(cssContent, remainingPlugins, CDP_PORT);
      } else {
        await applyNotiskin(config.activeTheme);
      }
      return;
    }

    if (subcommand === 'delete') {
      if (!name) {
        console.error('Usage: npm run plugin -- delete <name>');
        process.exit(1);
      }
      if (!existsSync(pluginPath(name))) {
        console.error(`Plugin '${name}' not found.`);
        process.exit(1);
      }
      try { unlinkSync(pluginPath(name)); } catch {}
      const config = readConfig();
      config.enabledPlugins = config.enabledPlugins.filter(p => p !== name);
      config.acknowledgedPlugins = config.acknowledgedPlugins.filter(p => p !== name);
      writeConfig(config);
      console.log(`Plugin '${name}' deleted.`);
      return;
    }

    console.error('Usage: npm run plugin -- enable <name>');
    console.error('       npm run plugin -- disable <name>');
    console.error('       npm run plugin -- delete <name>');
    process.exit(1);
  }

  if (command === 'inject') {
    // auto-invoked by wrapper script on each launch; Notion is already up with CDP open
    const config = readConfig();
    const cssFile = themePath(config.activeTheme);
    if (!existsSync(cssFile)) {
      console.error(`[inject] Theme '${config.activeTheme}' not found, nothing to inject.`);
      process.exit(1);
    }
    const plugins = loadEnabledPlugins(config.enabledPlugins);
    const cssContent = readFileSync(cssFile, 'utf-8');
    await waitForCDP(CDP_PORT);
    await applyAll(cssContent, plugins, CDP_PORT);
    return;
  }

  if (command === 'patch') {
    patchNotion(process.execPath, join(__dirname, 'index.js'));
    return;
  }

  if (command === 'unpatch') {
    unpatchNotion();
    return;
  }

  if (command === 'watch:install') {
    installWatcher();
    return;
  }

  if (command === 'watch:uninstall') {
    uninstallWatcher();
    return;
  }

  // no command given → apply active theme
  const config = readConfig();
  await applyNotiskin(config.activeTheme);
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
