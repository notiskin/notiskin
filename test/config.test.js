const { dataDir } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, readdirSync, readFileSync } = require('fs');
const { join } = require('path');
const { parseConfig, readConfig, writeConfig } = require('../dist/utils/config');

test('parseConfig drops wrong types and duplicates', () => {
  assert.deepEqual(parseConfig({ activeTheme: 5, enabledPlugins: ['a', 'a', 3], acknowledgedPlugins: 'x' }), {
    activeTheme: '',
    enabledPlugins: ['a'],
    acknowledgedPlugins: [],
    safeMode: false,
    setupDone: false,
    notionInstalled: false,
    blockNativeNotion: true,
    autoRepair: false,
    pluginSettings: {},
    developerMode: false,
    developerFolder: '',
  });
  assert.deepEqual(parseConfig(null), { activeTheme: '', enabledPlugins: [], acknowledgedPlugins: [], safeMode: false, setupDone: false, notionInstalled: false, blockNativeNotion: true, autoRepair: false, pluginSettings: {}, developerMode: false, developerFolder: '' });
});

test('missing config reads as the default without creating a file', () => {
  const path = join(dataDir, 'missing.json');
  assert.deepEqual(readConfig(path), { activeTheme: '', enabledPlugins: [], acknowledgedPlugins: [], safeMode: false, setupDone: false, notionInstalled: false, blockNativeNotion: true, autoRepair: false, pluginSettings: {}, developerMode: false, developerFolder: '' });
  assert.ok(!readdirSync(dataDir).includes('missing.json'));
});

test('holding back a native Notion is on unless turned off', () => {
  assert.equal(parseConfig({}).blockNativeNotion, true);
  assert.equal(parseConfig({ blockNativeNotion: 'no' }).blockNativeNotion, true);
  assert.equal(parseConfig({ blockNativeNotion: false }).blockNativeNotion, false);
  // the watcher runs in the background, so it's only on when turned on
  assert.equal(parseConfig({}).autoRepair, false);
  assert.equal(parseConfig({ autoRepair: 'yes' }).autoRepair, false);
  assert.equal(parseConfig({ autoRepair: true }).autoRepair, true);
});

test('writeConfig round-trips and leaves no temp files', () => {
  const path = join(dataDir, 'roundtrip.json');
  const config = { activeTheme: 'Dark', enabledPlugins: ['p1'], acknowledgedPlugins: ['p1'], safeMode: true, setupDone: true, notionInstalled: true, blockNativeNotion: false, autoRepair: true, pluginSettings: { p1: { size: 3, on: true, name: 'x' } }, developerMode: true, developerFolder: '/Users/x/plugins' };
  writeConfig(config, path);
  assert.deepEqual(readConfig(path), config);
  assert.deepEqual(readdirSync(dataDir).filter(f => f.endsWith('.tmp')), []);
});

test('a corrupt config is set aside, not silently lost', () => {
  const path = join(dataDir, 'corrupt.json');
  writeFileSync(path, '{ not json');
  assert.deepEqual(readConfig(path), { activeTheme: '', enabledPlugins: [], acknowledgedPlugins: [], safeMode: false, setupDone: false, notionInstalled: false, blockNativeNotion: true, autoRepair: false, pluginSettings: {}, developerMode: false, developerFolder: '' });
  const backup = readdirSync(dataDir).find(f => f.startsWith('corrupt.json.corrupt-'));
  assert.ok(backup, 'expected a .corrupt-* backup');
  assert.equal(readFileSync(join(dataDir, backup), 'utf-8'), '{ not json');
});

test('safeMode only turns on for a real true', () => {
  assert.equal(parseConfig({ safeMode: 'yes' }).safeMode, false);
  assert.equal(parseConfig({ safeMode: 1 }).safeMode, false);
  assert.equal(parseConfig({ safeMode: true }).safeMode, true);
  // config files from before safe mode existed
  assert.equal(parseConfig({ activeTheme: 'Dark' }).safeMode, false);
});

test('setupDone only counts a real true, so older configs still get the welcome tour', () => {
  assert.equal(parseConfig({ setupDone: 'yes' }).setupDone, false);
  assert.equal(parseConfig({ setupDone: true }).setupDone, true);
  assert.equal(parseConfig({ activeTheme: 'Dark' }).setupDone, false);
});
