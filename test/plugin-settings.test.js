require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../dist/core/library');
const { readConfig, writeConfig, parseConfig } = require('../dist/utils/config');
const { parseSettingDeclarations, resolveSettings, checkSettingValue, parsePluginSettings, MAX_SETTINGS } = require('../dist/core/plugin-settings');
const { pluginExpression } = require('../dist/injector/index');

const line = obj => ` * @notiskin-setting ${JSON.stringify(obj)}`;
const header = (...objs) => `/**\n${objs.map(line).join('\n')}\n */\nconsole.log('plugin');\n`;

const ALL = [
  { key: 'compact', type: 'toggle', label: 'Compact sidebar', default: false },
  { key: 'greeting', type: 'text', label: 'Greeting', default: 'hi', maxLength: 10, description: 'Shown in the top bar' },
  { key: 'size', type: 'number', label: 'Size', default: 14, min: 8, max: 32, step: 2 },
  { key: 'mode', type: 'select', label: 'Mode', default: 'a', options: ['a', 'b', 'c'] },
  { key: 'accent', type: 'color', label: 'Accent', default: '#E8590C' },
];

test('every kind of setting is read from the header comment', () => {
  const { settings, problems } = parseSettingDeclarations(header(...ALL));
  assert.deepEqual(problems, []);
  assert.deepEqual(settings.map(s => s.key), ['compact', 'greeting', 'size', 'mode', 'accent']);
  assert.deepEqual(settings[0], { key: 'compact', label: 'Compact sidebar', type: 'toggle', default: false });
  assert.equal(settings[1].description, 'Shown in the top bar');
  assert.equal(settings[2].step, 2);
  assert.equal(settings[4].default, '#e8590c', 'colors are kept lower case');
});

test('both comment styles work, with a BOM, Windows line endings and other comments first', () => {
  const src = `\uFEFF// my plugin\r\n// @notiskin-setting ${JSON.stringify(ALL[0])}\r\n/* more\r\n * @notiskin-setting ${JSON.stringify(ALL[3])}\r\n */\r\nconsole.log(1);\r\n`;
  assert.deepEqual(parseSettingDeclarations(src).settings.map(s => s.key), ['compact', 'mode']);
});

test('only the header counts: a line after the first code is not a setting', () => {
  const src = `/** ${'x'.repeat(10)} */\nvar a = 1;\n/**\n${line(ALL[0])}\n */\n// ${line(ALL[1])}\n`;
  assert.deepEqual(parseSettingDeclarations(src).settings, []);
  // nor is one in a string
  assert.deepEqual(parseSettingDeclarations(`var s = '@notiskin-setting ${JSON.stringify(ALL[0])}';`).settings, []);
  assert.deepEqual(parseSettingDeclarations('').settings, []);
  assert.deepEqual(parseSettingDeclarations('/* never closed @notiskin-setting {}').settings, []);
});

test('a bad line is skipped with a plain note, the good ones around it still work', () => {
  const src = [
    '/**',
    line(ALL[0]),
    ' * @notiskin-setting {not json',
    line({ key: 'x', type: 'colour', label: 'X', default: 'red' }),
    line({ key: '1bad', type: 'toggle', label: 'Bad key', default: true }),
    line({ key: 'dup', type: 'toggle', label: 'First', default: true }),
    line({ key: 'dup', type: 'toggle', label: 'Second', default: false }),
    line(ALL[3]),
    ' */',
  ].join('\n');
  const { settings, problems } = parseSettingDeclarations(src);
  assert.deepEqual(settings.map(s => s.key), ['compact', 'dup', 'mode']);
  assert.equal(settings[1].label, 'First', 'the first one of a name wins');
  assert.equal(problems.length, 4);
  assert.match(problems.join(' '), /valid JSON/);
  assert.match(problems.join(' '), /second setting called "dup"/);
});

test('declarations that make no sense are refused', () => {
  const bad = [
    { type: 'toggle', label: 'No key', default: true },
    { key: 'a', type: 'toggle', default: true },
    { key: 'a', type: 'toggle', label: '', default: true },
    { key: 'a', type: 'toggle', label: 'L'.repeat(61), default: true },
    { key: 'a', type: 'toggle', label: 'L', default: 'yes' },
    { key: 'a', type: 'toggle', label: 'L', default: true, description: 'd'.repeat(201) },
    { key: 'a'.repeat(41), type: 'toggle', label: 'L', default: true },
    { key: 'a-b', type: 'toggle', label: 'L', default: true },
    { key: '__proto__', type: 'toggle', label: 'L', default: true },
    { key: 'a', type: 'text', label: 'L', default: 'x'.repeat(11), maxLength: 10 },
    { key: 'a', type: 'text', label: 'L', default: 'x', maxLength: 0 },
    { key: 'a', type: 'text', label: 'L', default: 'x', maxLength: 2001 },
    { key: 'a', type: 'text', label: 'L', default: 5 },
    { key: 'a', type: 'number', label: 'L', default: 'five' },
    { key: 'a', type: 'number', label: 'L', default: 5, min: 10 },
    { key: 'a', type: 'number', label: 'L', default: 5, min: 9, max: 3 },
    { key: 'a', type: 'number', label: 'L', default: 5, step: 0 },
    { key: 'a', type: 'number', label: 'L', default: null },
    { key: 'a', type: 'select', label: 'L', default: 'a' },
    { key: 'a', type: 'select', label: 'L', default: 'z', options: ['a'] },
    { key: 'a', type: 'select', label: 'L', default: 'a', options: [] },
    { key: 'a', type: 'select', label: 'L', default: 'a', options: ['a', 'a'] },
    { key: 'a', type: 'select', label: 'L', default: 'a', options: ['a', 3] },
    { key: 'a', type: 'select', label: 'L', default: 'a', options: Array.from({ length: 21 }, (_, i) => `o${i}`) },
    { key: 'a', type: 'color', label: 'L', default: 'red' },
    { key: 'a', type: 'color', label: 'L', default: '#fff' },
    { key: 'a', type: 'color', label: 'L', default: 'url(x)' },
    { key: 'a', type: 'range', label: 'L', default: 1 },
    null,
    [],
    'text',
  ];
  for (const decl of bad) {
    const src = `/**\n * @notiskin-setting ${JSON.stringify(decl)}\n */\n`;
    const { settings, problems } = parseSettingDeclarations(src);
    assert.equal(settings.length, 0, JSON.stringify(decl));
    assert.equal(problems.length, 1, JSON.stringify(decl));
  }
});

test('no more than 20 settings, and a huge line is skipped', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ key: `k${i}`, type: 'toggle', label: `K${i}`, default: true }));
  const { settings, problems } = parseSettingDeclarations(header(...many));
  assert.equal(settings.length, MAX_SETTINGS);
  assert.match(problems.join(' '), /first 20/);
  const big = { key: 'a', type: 'text', label: 'L', default: '', description: 'x'.repeat(2000) };
  assert.equal(parseSettingDeclarations(header(big)).settings.length, 0);
});

test('a plugin is never run to read its settings', () => {
  // the plugin below throws and loops if it were executed, parsing only reads comments
  const src = `/**\n${line(ALL[0])}\n */\nwhile (true) {}\nthrow new Error('never');\n`;
  assert.equal(parseSettingDeclarations(src).settings.length, 1);
});

test('values: the default, then what the user saved, anything that no longer fits falls back', () => {
  const { settings } = parseSettingDeclarations(header(...ALL));
  assert.deepEqual(resolveSettings(settings), { compact: false, greeting: 'hi', size: 14, mode: 'a', accent: '#e8590c' });
  assert.deepEqual(resolveSettings(settings, { compact: true, greeting: 'yo', size: 20, mode: 'c', accent: '#00FF00' }), {
    compact: true, greeting: 'yo', size: 20, mode: 'c', accent: '#00ff00',
  });
  assert.deepEqual(
    resolveSettings(settings, { compact: 'yes', greeting: 'x'.repeat(11), size: 'big', mode: 'z', accent: 'red', gone: 1 }),
    { compact: false, greeting: 'hi', size: 14, mode: 'a', accent: '#e8590c' },
    'wrong types, too long, not a choice and not a color are ignored, a key the plugin dropped stays out'
  );
  // a range that was narrowed since the value was saved pulls the number in
  assert.equal(resolveSettings(settings, { size: 99 }).size, 32);
  assert.equal(resolveSettings(settings, { size: -5 }).size, 8);
  assert.equal(resolveSettings(settings, { size: NaN }).size, 14);
});

test('what the form may send is checked strictly', () => {
  const { settings } = parseSettingDeclarations(header(...ALL));
  const by = key => settings.find(s => s.key === key);
  assert.deepEqual(checkSettingValue(by('compact'), true), { ok: true, value: true });
  assert.equal(checkSettingValue(by('compact'), 'true').ok, false);
  assert.equal(checkSettingValue(by('greeting'), 'x'.repeat(11)).ok, false);
  assert.equal(checkSettingValue(by('greeting'), 5).ok, false);
  assert.equal(checkSettingValue(by('size'), 33).ok, false);
  assert.equal(checkSettingValue(by('size'), 7).ok, false);
  assert.equal(checkSettingValue(by('size'), '20').ok, false);
  assert.equal(checkSettingValue(by('size'), Infinity).ok, false);
  assert.equal(checkSettingValue(by('mode'), 'z').ok, false);
  assert.deepEqual(checkSettingValue(by('accent'), '#ABCDEF'), { ok: true, value: '#abcdef' });
  assert.equal(checkSettingValue(by('accent'), 'url(https://x)').ok, false);
  assert.match(checkSettingValue(by('size'), 33).error, /^Size: must be at most 32/);
});

test('the config keeps plugin settings and drops anything that is not a plain value', () => {
  const config = parseConfig({
    pluginSettings: {
      good: { a: true, b: 'text', c: 4.5 },
      mixed: { ok: 1, nested: { x: 1 }, list: [1], nothing: null, 'bad-key': 'x', __proto__: 'x' },
      notAnObject: 'x',
      empty: {},
      arr: [1],
    },
  });
  assert.deepEqual(config.pluginSettings, { good: { a: true, b: 'text', c: 4.5 }, mixed: { ok: 1 } });
  assert.deepEqual(parseConfig({}).pluginSettings, {});
  assert.deepEqual(parseConfig({ pluginSettings: 'x' }).pluginSettings, {});
  assert.deepEqual(parsePluginSettings({ p: { n: NaN, i: Infinity } }), {});
});

test('plugin settings round-trip through the config file', () => {
  const before = readConfig();
  writeConfig({ ...before, pluginSettings: { demo: { size: 20, compact: true, greeting: 'yo' } } });
  assert.deepEqual(readConfig().pluginSettings, { demo: { size: 20, compact: true, greeting: 'yo' } });
  writeConfig({ ...readConfig(), pluginSettings: {} });
  assert.deepEqual(readConfig().pluginSettings, {});
});

test('the payload gives a plugin its values, the user\'s over its defaults, and a plain plugin nothing extra', () => {
  lib.writeItem('plugin', 'with-settings', header(...ALL));
  lib.writeItem('plugin', 'plain', "console.log('plain');");
  writeConfig({
    ...readConfig(),
    enabledPlugins: ['with-settings', 'plain'],
    pluginSettings: { 'with-settings': { size: 20, compact: true } },
  });
  const { plugins } = lib.currentPayload(readConfig());
  const withSettings = plugins.find(p => p.name === 'with-settings');
  const plain = plugins.find(p => p.name === 'plain');
  assert.deepEqual(withSettings.settings, { compact: true, greeting: 'hi', size: 20, mode: 'a', accent: '#e8590c' });
  assert.equal('settings' in plain, false, 'a plugin without settings is injected exactly as before');
  assert.equal(pluginExpression(plain), plain.content);

  // safe mode sends nothing, values included
  assert.deepEqual(lib.currentPayload({ ...readConfig(), safeMode: true }), { css: '', plugins: [] });

  // deleting a plugin drops its saved values, a new plugin with that name starts from its defaults
  lib.deleteItem('plugin', 'with-settings');
  assert.equal(readConfig().pluginSettings['with-settings'], undefined);
  lib.deleteItem('plugin', 'plain');
  writeConfig({ ...readConfig(), enabledPlugins: [] });
});

test('a plugin with settings is wrapped so it gets its own notiskin, a plain one is not', () => {
  const wrapped = pluginExpression({ name: 'a "quoted" name', content: '// c\nvar x = 1;', settings: { a: 1 } });
  assert.match(wrapped, /^\(function \(notiskin\) \{\n\/\/ c\nvar x = 1;\n\}\)\.call\(window,/);
  assert.match(wrapped, /__forPlugin\("a \\"quoted\\" name"\)/);
  // a trailing line comment can't swallow the closing of the wrapper
  assert.doesNotThrow(() => new Function(pluginExpression({ name: 'p', content: '// last line, no newline', settings: {} })));
});
