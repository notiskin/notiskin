const { dataDir } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const lib = require('../dist/core/library');
const { readConfig, writeConfig, parseConfig } = require('../dist/utils/config');
const { scanDevFolder, checkDevFolder, isDevName, devFileFor, MAX_DEV_PLUGINS } = require('../dist/core/dev-plugins');
const { MAX_ITEM_BYTES } = require('../dist/utils/constants');

function folder() {
  return mkdtempSync(join(tmpdir(), 'notiskin-dev-'));
}

test('a folder of .js files is read in place, in name order', () => {
  const dir = folder();
  writeFileSync(join(dir, 'b-second.js'), 'window.b = 1;');
  writeFileSync(join(dir, 'a first.js'), 'window.a = 1;');
  writeFileSync(join(dir, 'notes.txt'), 'not a plugin');
  writeFileSync(join(dir, 'style.css'), 'x');
  writeFileSync(join(dir, '.hidden.js'), 'x');
  const scan = scanDevFolder(dir);
  assert.equal(scan.error, undefined);
  assert.deepEqual(scan.plugins.map(p => p.name), ['dev/a first', 'dev/b-second']);
  assert.equal(scan.plugins[0].content, 'window.a = 1;');
  assert.deepEqual(scan.skipped, [], 'other file types and dot files are just not plugins');
  rmSync(dir, { recursive: true });
});

test('only plain files count: links, folders called x.js, huge files and odd names are skipped with a reason', () => {
  const dir = folder();
  const outside = folder();
  writeFileSync(join(outside, 'secret.js'), 'window.secret = 1;');
  symlinkSync(join(outside, 'secret.js'), join(dir, 'link.js'));
  mkdirSync(join(dir, 'folder.js'));
  writeFileSync(join(dir, 'big.js'), 'x'.repeat(MAX_ITEM_BYTES + 1));
  writeFileSync(join(dir, 'ok.js'), 'window.ok = 1;');
  writeFileSync(join(dir, 'bad;name.js'), 'x');
  writeFileSync(join(dir, `${'n'.repeat(81)}.js`), 'x');
  const scan = scanDevFolder(dir);
  assert.deepEqual(scan.plugins.map(p => p.name), ['dev/ok']);
  const reasons = Object.fromEntries(scan.skipped.map(s => [s.file, s.reason]));
  assert.match(reasons['link.js'], /link/);
  assert.match(reasons['folder.js'], /not a plain file/);
  assert.match(reasons['big.js'], /larger than/);
  assert.match(reasons['bad;name.js'], /name can use/);
  assert.equal(scan.skipped.length, 5);
  rmSync(dir, { recursive: true });
  rmSync(outside, { recursive: true });
});

test('a lot of files: only the first ones are used', () => {
  const dir = folder();
  for (let i = 0; i < MAX_DEV_PLUGINS + 3; i++) writeFileSync(join(dir, `p${String(i).padStart(3, '0')}.js`), '1;');
  const scan = scanDevFolder(dir);
  assert.equal(scan.plugins.length, MAX_DEV_PLUGINS);
  assert.equal(scan.skipped.length, 3);
  rmSync(dir, { recursive: true });
});

test('a folder that cannot be used says why, and uses nothing', () => {
  const dir = folder();
  writeFileSync(join(dir, 'file.js'), '1;');
  for (const [bad, text] of [['', /Choose a folder/], ['relative/path', /full path/], [join(dir, 'missing'), /does not exist/], [join(dir, 'file.js'), /not a folder/], [`${dir}\0x`, /not valid/], [undefined, /Choose a folder/], [42, /Choose a folder/]]) {
    assert.match(checkDevFolder(bad), text, String(bad));
  }
  assert.equal(checkDevFolder(dir), null);
  const scan = scanDevFolder(join(dir, 'missing'));
  assert.deepEqual(scan.plugins, []);
  assert.match(scan.error, /does not exist/);
  rmSync(dir, { recursive: true });
});

test('developer plugin names can never be an installed plugin\'s name', () => {
  assert.ok(isDevName('dev/my plugin'));
  assert.equal(devFileFor('dev/my plugin'), 'my plugin.js');
  for (const bad of ['dev/', 'dev/../x', 'dev/a/b', 'my-plugin', 'dev', 'dev/.x', 42, null, 'dev/a;b']) assert.equal(isDevName(bad), false, String(bad));
  assert.equal(lib.isValidItemName('dev/x'), false, 'an installed plugin name has no slash');
});

test('the config keeps developer mode only as a real true and a full path', () => {
  assert.deepEqual([parseConfig({}).developerMode, parseConfig({}).developerFolder], [false, '']);
  assert.equal(parseConfig({ developerMode: 'yes' }).developerMode, false);
  assert.equal(parseConfig({ developerMode: true }).developerMode, true);
  assert.equal(parseConfig({ developerFolder: '/Users/x/plugins' }).developerFolder, '/Users/x/plugins');
  assert.equal(parseConfig({ developerFolder: 'relative' }).developerFolder, '');
  assert.equal(parseConfig({ developerFolder: 5 }).developerFolder, '');
  assert.equal(parseConfig({ developerFolder: `/${'a'.repeat(1025)}` }).developerFolder, '');
});

test('the payload runs the folder\'s plugins only while developer mode is on, and never in safe mode', () => {
  const dir = folder();
  writeFileSync(join(dir, 'dev-one.js'), `/**\n * @notiskin-setting {"key":"n","type":"number","label":"N","default":3}\n */\nwindow.one = 1;`);
  writeFileSync(join(dir, 'plain.js'), 'window.plain = 1;');
  lib.writeItem('plugin', 'installed-one', 'window.inst = 1;');
  const base = { ...readConfig(), enabledPlugins: ['installed-one'], developerFolder: dir };

  // off: nothing from the folder, even with a folder remembered
  assert.deepEqual(lib.currentPayload({ ...base, developerMode: false }).plugins.map(p => p.name), ['installed-one']);

  const on = lib.currentPayload({ ...base, developerMode: true, pluginSettings: { 'dev/dev-one': { n: 9 } } }).plugins;
  assert.deepEqual(on.map(p => p.name), ['installed-one', 'dev/dev-one', 'dev/plain']);
  assert.deepEqual(on[1].settings, { n: 9 }, 'a developer plugin gets its settings like any other');
  assert.equal('settings' in on[2], false);

  assert.deepEqual(lib.currentPayload({ ...base, developerMode: true, safeMode: true }), { css: '', plugins: [] });

  // a folder that went away is a warning, the installed plugins still load
  const warnings = [];
  rmSync(dir, { recursive: true });
  const gone = lib.currentPayload({ ...base, developerMode: true }, w => warnings.push(w));
  assert.deepEqual(gone.plugins.map(p => p.name), ['installed-one']);
  assert.match(warnings.join(' '), /Developer mode: That folder does not exist/);

  lib.deleteItem('plugin', 'installed-one');
  writeConfig({ ...readConfig(), developerMode: false, developerFolder: '' });
  assert.ok(dataDir);
});
