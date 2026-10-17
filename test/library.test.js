const { dataDir } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('fs');
const { join } = require('path');
const lib = require('../dist/core/library');
const { readConfig, writeConfig } = require('../dist/utils/config');

test('isValidItemName blocks anything that could escape the folder', () => {
  for (const ok of ['Dark', 'a-good-plugin', '12-to-the3', 'My Theme', 'v1.2']) {
    assert.ok(lib.isValidItemName(ok), ok);
  }
  for (const bad of ['', '../x', '..', '.hidden', 'a/b', 'a\\b', 'x'.repeat(81), null, 42, 'a\nb']) {
    assert.ok(!lib.isValidItemName(bad), String(bad));
  }
});

test('itemPath throws on unsafe names', () => {
  assert.throws(() => lib.itemPath('theme', '../../evil'));
  assert.equal(lib.itemPath('plugin', 'ok'), join(dataDir, 'plugins', 'ok.js'));
});

test('toFileStem matches the names earlier versions used', () => {
  assert.equal(lib.toFileStem('a good plugin'), 'a-good-plugin');
  assert.equal(lib.toFileStem('  Rainbow  '), 'Rainbow');
  assert.equal(lib.toFileStem('../../etc'), 'etc');
});

test('write, list, and delete items keeps config in sync', () => {
  lib.writeItem('theme', 'Dark', ':root { --ns-bg: #000; }');
  lib.writeItem('plugin', 'hello', 'console.log("hi")');
  assert.deepEqual(lib.listThemes(), ['Dark']);
  assert.deepEqual(lib.listPlugins(), ['hello']);

  writeConfig({ activeTheme: 'Dark', enabledPlugins: ['hello'], acknowledgedPlugins: ['hello'] });
  assert.equal(lib.activeThemeCss(readConfig()), ':root { --ns-bg: #000; }');
  assert.deepEqual(lib.loadEnabledPlugins(readConfig()).map(p => p.name), ['hello']);

  assert.ok(lib.deleteItem('plugin', 'hello'));
  assert.ok(lib.deleteItem('theme', 'Dark'));
  assert.ok(!lib.deleteItem('theme', 'Dark'));
  assert.deepEqual(readConfig(), { activeTheme: '', enabledPlugins: [], acknowledgedPlugins: [] });
  assert.ok(!existsSync(join(dataDir, 'themes', 'Dark.css')));
});

test('no active theme means empty CSS instead of a crash', () => {
  assert.equal(lib.activeThemeCss({ activeTheme: '', enabledPlugins: [], acknowledgedPlugins: [] }), '');
  assert.equal(lib.activeThemeCss({ activeTheme: 'gone', enabledPlugins: [], acknowledgedPlugins: [] }), '');
});

test('missing enabled plugins are skipped with a warning', () => {
  const warnings = [];
  const plugins = lib.loadEnabledPlugins({ activeTheme: '', enabledPlugins: ['nope'], acknowledgedPlugins: [] }, w => warnings.push(w));
  assert.deepEqual(plugins, []);
  assert.equal(warnings.length, 1);
});

test('oversized items are refused', () => {
  assert.throws(() => lib.writeItem('plugin', 'big', 'x'.repeat(600 * 1024)), /too large/);
});
