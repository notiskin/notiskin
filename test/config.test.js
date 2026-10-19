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
  });
  assert.deepEqual(parseConfig(null), { activeTheme: '', enabledPlugins: [], acknowledgedPlugins: [], safeMode: false });
});

test('missing config reads as the default without creating a file', () => {
  const path = join(dataDir, 'missing.json');
  assert.deepEqual(readConfig(path), { activeTheme: '', enabledPlugins: [], acknowledgedPlugins: [], safeMode: false });
  assert.ok(!readdirSync(dataDir).includes('missing.json'));
});

test('writeConfig round-trips and leaves no temp files', () => {
  const path = join(dataDir, 'roundtrip.json');
  const config = { activeTheme: 'Dark', enabledPlugins: ['p1'], acknowledgedPlugins: ['p1'], safeMode: true };
  writeConfig(config, path);
  assert.deepEqual(readConfig(path), config);
  assert.deepEqual(readdirSync(dataDir).filter(f => f.endsWith('.tmp')), []);
});

test('a corrupt config is set aside, not silently lost', () => {
  const path = join(dataDir, 'corrupt.json');
  writeFileSync(path, '{ not json');
  assert.deepEqual(readConfig(path), { activeTheme: '', enabledPlugins: [], acknowledgedPlugins: [], safeMode: false });
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
