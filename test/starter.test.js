const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateThemeCss } = require('../supabase/functions/_shared/css.ts');
const { isValidItemName } = require('../dist/core/library');
const { parseSettingDeclarations } = require('../dist/core/plugin-settings');
const { MAX_ITEM_BYTES } = require('../dist/utils/constants');

const ROOT = path.join(__dirname, '..', 'starter');

function files(kind, ext) {
  const dir = path.join(ROOT, kind);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(ext))
    .map(f => ({ name: f.slice(0, -ext.length), content: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

const themes = files('themes', '.css');
const plugins = files('plugins', '.js');

// starter plugins run in every user's Notion with full access, so they stay off the network and out of eval
const FORBIDDEN = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'eval', 'new Function', 'importScripts', '<script', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie'];

test('there are starter themes and plugins, and nothing else is in the folders', () => {
  assert.ok(themes.length > 0);
  assert.ok(plugins.length > 0);
  assert.equal(fs.readdirSync(path.join(ROOT, 'themes')).length, themes.length);
  assert.equal(fs.readdirSync(path.join(ROOT, 'plugins')).length, plugins.length);
});

for (const { name, content } of themes) {
  test(`starter theme "${name}" passes the marketplace check`, () => {
    assert.ok(isValidItemName(name), 'the file name has to be a valid item name');
    assert.equal(validateThemeCss(content), null);
    assert.ok(Buffer.byteLength(content) <= MAX_ITEM_BYTES);
  });
}

for (const { name, content } of plugins) {
  test(`starter plugin "${name}" has valid settings and stays off the network`, () => {
    assert.ok(isValidItemName(name), 'the file name has to be a valid item name');
    assert.ok(Buffer.byteLength(content) <= 200 * 1024);
    const { settings, problems } = parseSettingDeclarations(content);
    assert.deepEqual(problems, []);
    assert.ok(settings.length > 0, 'a starter plugin shows off settings');
    for (const word of FORBIDDEN) {
      assert.ok(!content.includes(word), `${name} must not use ${word}`);
    }
  });

  test(`starter plugin "${name}" parses as a script`, () => {
    // the page wraps a plugin with settings in a function, so it has to compile as a function body
    assert.doesNotThrow(() => new Function('notiskin', content));
  });
}

test('names are unique across themes and plugins as the marketplace shows them', () => {
  const names = [...themes, ...plugins].map(i => i.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
});
