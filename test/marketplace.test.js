const { dataDir } = require('./helpers');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } = require('fs');
const { join } = require('path');
const lib = require('../dist/core/library');
const installed = require('../dist/core/installed');
const mp = require('../dist/core/marketplace');

const manifestPath = join(dataDir, 'installed.json');
const item = (over = {}) => ({ id: 'id-1', name: 'my theme', code: ':root{--ns-a:red}', version: 1, ...over });

beforeEach(() => {
  rmSync(join(dataDir, 'themes'), { recursive: true, force: true });
  rmSync(join(dataDir, 'plugins'), { recursive: true, force: true });
  rmSync(manifestPath, { force: true });
});

test('the manifest keeps only well-formed entries', () => {
  const parsed = installed.parseInstalled({
    'theme:ok': { id: 'a', version: 2 },
    'theme:../evil': { id: 'b', version: 1 },
    'other:x': { id: 'c', version: 1 },
    'plugin:noversion': { id: 'd' },
    'plugin:zero': { id: 'e', version: 0 },
    'plugin:noid': { version: 1 },
  });
  assert.deepEqual(parsed, { 'theme:ok': { id: 'a', version: 2 } });
  assert.deepEqual(installed.parseInstalled(null), {});
  assert.deepEqual(installed.parseInstalled([1]), {});
});

test('the manifest is written atomically and read back', () => {
  installed.recordInstall('theme', 'dark', { id: 'x', version: 3 });
  assert.deepEqual(installed.installedEntry('theme', 'dark'), { id: 'x', version: 3 });
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf-8')), { 'theme:dark': { id: 'x', version: 3 } });
  assert.ok(!readdirSync(dataDir).some(f => f.endsWith('.tmp')));
  installed.forgetInstall('theme', 'dark');
  assert.equal(installed.installedEntry('theme', 'dark'), null);
});

test('a broken manifest is set aside and nothing counts as installed', () => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(manifestPath, '{not json');
  assert.deepEqual(installed.readInstalled(), {});
  assert.ok(readdirSync(dataDir).some(f => f.startsWith('installed.json.corrupt-')));
});

test('installing writes the file and records the item and version', () => {
  const result = mp.installFromMarketplace('theme', item({ version: 2 }));
  assert.deepEqual(result, { outcome: 'installed', name: 'my-theme' });
  assert.equal(readFileSync(lib.itemPath('theme', 'my-theme'), 'utf-8'), ':root{--ns-a:red}');
  assert.deepEqual(installed.installedEntry('theme', 'my-theme'), { id: 'id-1', version: 2 });
});

test('installing the same item again leaves the file alone', () => {
  mp.installFromMarketplace('theme', item());
  writeFileSync(lib.itemPath('theme', 'my-theme'), 'edited by me');
  assert.equal(mp.installFromMarketplace('theme', item({ code: 'new' })).outcome, 'already-installed');
  assert.equal(readFileSync(lib.itemPath('theme', 'my-theme'), 'utf-8'), 'edited by me');
});

test("a theme the user made with the same name is never replaced", () => {
  lib.writeItem('theme', 'my-theme', 'my own css');
  assert.equal(mp.installFromMarketplace('theme', item()).outcome, 'conflict');
  assert.equal(readFileSync(lib.itemPath('theme', 'my-theme'), 'utf-8'), 'my own css');
  assert.equal(installed.installedEntry('theme', 'my-theme'), null);
});

test('a file from a different marketplace item with the same name is a conflict', () => {
  mp.installFromMarketplace('theme', item({ id: 'other' }));
  assert.equal(mp.installFromMarketplace('theme', item()).outcome, 'conflict');
});

test('a file installed before the manifest existed is adopted only if it matches exactly', () => {
  lib.writeItem('theme', 'my-theme', ':root{--ns-a:red}');
  assert.equal(mp.installFromMarketplace('theme', item({ version: 3 })).outcome, 'already-installed');
  assert.deepEqual(installed.installedEntry('theme', 'my-theme'), { id: 'id-1', version: 3 });
});

test('updating writes the new code and version', () => {
  mp.installFromMarketplace('plugin', item({ code: 'v1()' }));
  mp.updateFromMarketplace('plugin', 'my-theme', item({ code: 'v2()', version: 2 }));
  assert.equal(readFileSync(lib.itemPath('plugin', 'my-theme'), 'utf-8'), 'v2()');
  assert.deepEqual(installed.installedEntry('plugin', 'my-theme'), { id: 'id-1', version: 2 });
});

test('updating refuses user files, other items and versions that are not newer', () => {
  lib.writeItem('theme', 'mine', 'my own css');
  assert.throws(() => mp.updateFromMarketplace('theme', 'mine', item({ version: 2 })), /didn't come from the marketplace/);
  assert.equal(readFileSync(lib.itemPath('theme', 'mine'), 'utf-8'), 'my own css');

  mp.installFromMarketplace('theme', item({ version: 2 }));
  assert.throws(() => mp.updateFromMarketplace('theme', 'my-theme', item({ id: 'x', version: 3 })), /different/);
  assert.throws(() => mp.updateFromMarketplace('theme', 'my-theme', item({ version: 2 })), /up to date/);
  assert.throws(() => mp.updateFromMarketplace('theme', 'my-theme', item({ version: 1 })), /up to date/);
});

test('findUpdates lists only newer versions of installed marketplace files, with what changed', () => {
  mp.installFromMarketplace('theme', item({ version: 1 }));
  mp.installFromMarketplace('theme', item({ id: 'id-2', name: 'current', version: 4 }));
  mp.installFromMarketplace('theme', item({ id: 'id-3', name: 'gone' }));
  lib.writeItem('theme', 'mine', 'x');
  const latest = new Map([
    ['id-1', { version: 3, changes: [{ version: 3, changelog: 'three' }, { version: 2, changelog: 'two' }, { version: 1, changelog: '' }] }],
    ['id-2', { version: 4, changes: [] }],
  ]);
  assert.deepEqual(mp.findUpdates('theme', latest), [{
    type: 'theme',
    name: 'my-theme',
    id: 'id-1',
    installedVersion: 1,
    latestVersion: 3,
    changes: [{ version: 3, changelog: 'three' }, { version: 2, changelog: 'two' }],
  }]);
  assert.deepEqual(mp.findUpdates('plugin', latest), []);
});

test('a deleted file is forgotten, so a new file with that name is the user\'s own', () => {
  mp.installFromMarketplace('theme', item());
  lib.deleteItem('theme', 'my-theme');
  assert.equal(installed.installedEntry('theme', 'my-theme'), null);
  assert.ok(!existsSync(lib.itemPath('theme', 'my-theme')));
});

test('installedIds lists each marketplace item once per type', () => {
  mp.installFromMarketplace('theme', item());
  mp.installFromMarketplace('plugin', item({ id: 'p-1' }));
  assert.deepEqual(mp.installedIds('theme'), ['id-1']);
  assert.deepEqual(mp.installedIds('plugin'), ['p-1']);
});

test('sort and tag from the query string fall back safely', () => {
  assert.equal(mp.parseSort('rating'), 'rating');
  assert.equal(mp.parseSort('downloads'), 'downloads');
  for (const other of [undefined, '', 'newest', 'created_at.desc', ['rating']]) assert.equal(mp.parseSort(other), 'newest');
  assert.equal(mp.parseTag('dark'), 'dark');
  for (const bad of [undefined, '', 'Dark', 'evil', 'dark,light', ['dark']]) assert.equal(mp.parseTag(bad), null);
});
