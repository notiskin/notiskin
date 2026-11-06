const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateThemeCss } = require('../supabase/functions/_shared/css.ts');
const editor = require('../src/gui/theme-editor.js');

const { getVar, setVar, removeVar, varsOf, findBlocks, pickerHex, START_CSS, GROUPS } = editor;

const ALL_VARS = GROUPS.flatMap(g => g.vars.map(([key]) => key));

test('a new theme starts valid and every picker variable can be set on it, still valid', () => {
  let css = START_CSS('my theme');
  assert.equal(validateThemeCss(css), null);
  ALL_VARS.forEach((key, i) => {
    const value = `#${(0x112233 + i).toString(16)}`;
    css = setVar(css, 'base', key, value);
    assert.equal(getVar(css, 'base', key), value);
  });
  assert.equal(validateThemeCss(css), null, css);
  assert.deepEqual(Object.keys(varsOf(css, 'base')).sort(), [...ALL_VARS].sort());
});

// a theme with everything the editor doesn't know about
const SAVED = `/* Solar, v2
   :root { --ns-bg: red; } not a real block */
:root {
  --ns-bg: #fdf6e3;   /* page */
  --ns-text: color-mix(in srgb, #000 90%, white);
  --ns-font: "Georgia", serif;
  --ns-radius: 6px;
  --ns-color-red: #cb4b16;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ns-bg: #002b36;
    --ns-font-code: "Menlo", monospace;
  }
}
`;

test('an existing theme file round-trips: reading it and writing the same values back changes nothing', () => {
  assert.equal(validateThemeCss(SAVED), null);
  assert.equal(getVar(SAVED, 'base', 'bg'), '#fdf6e3');
  assert.equal(getVar(SAVED, 'base', 'text'), 'color-mix(in srgb, #000 90%, white)');
  assert.equal(getVar(SAVED, 'dark', 'bg'), '#002b36');
  assert.equal(getVar(SAVED, 'dark', 'text'), null, 'the dark version has no text of its own');
  assert.equal(getVar(SAVED, 'light', 'bg'), null);
  assert.equal(setVar(SAVED, 'base', 'bg', '#fdf6e3'), SAVED);
  assert.equal(setVar(SAVED, 'dark', 'bg', '#002b36'), SAVED);
  assert.equal(setVar(SAVED, 'base', 'text', 'color-mix(in srgb, #000 90%, white)'), SAVED);
});

test('comments are never read as CSS', () => {
  assert.deepEqual(findBlocks(SAVED).map(b => b.scope), ['base', 'dark']);
  // the :root in the comment has its own --ns-bg: red, which must not be found
  assert.equal(getVar(SAVED, 'base', 'bg'), '#fdf6e3');
  assert.equal(getVar('/* :root { --ns-bg: red; } */', 'base', 'bg'), null);
});

test('changing a value touches only that value, everything else comes back as it was', () => {
  const next = setVar(SAVED, 'base', 'bg', '#ffffff');
  assert.equal(next, SAVED.replace('--ns-bg: #fdf6e3;', '--ns-bg: #ffffff;'));
  assert.ok(next.includes('/* page */'), 'the comment next to it stays');
  assert.equal(validateThemeCss(next), null);

  const dark = setVar(SAVED, 'dark', 'bg', '#000000');
  assert.equal(dark, SAVED.replace('#002b36', '#000000'));
  assert.equal(validateThemeCss(dark), null);
});

test('a variable that is not there yet is added in the right block, on its own line', () => {
  const base = setVar(SAVED, 'base', 'sidebar-bg', '#eee8d5');
  assert.equal(getVar(base, 'base', 'sidebar-bg'), '#eee8d5');
  assert.equal(getVar(base, 'dark', 'sidebar-bg'), null);
  assert.match(base, /--ns-color-red: #cb4b16;\n {2}--ns-sidebar-bg: #eee8d5;\n}/);
  assert.equal(validateThemeCss(base), null);

  const dark = setVar(SAVED, 'dark', 'sidebar-bg', '#073642');
  assert.equal(getVar(dark, 'dark', 'sidebar-bg'), '#073642');
  assert.equal(getVar(dark, 'base', 'sidebar-bg'), null);
  assert.match(dark, /--ns-font-code: "Menlo", monospace;\n {4}--ns-sidebar-bg: #073642;\n {2}}/);
  assert.equal(validateThemeCss(dark), null);
});

test('a first dark or light version is added as a prefers-color-scheme block', () => {
  const css = ':root { --ns-bg: #fff; }\n';
  const dark = setVar(css, 'dark', 'bg', '#111');
  assert.equal(dark, ':root { --ns-bg: #fff; }\n@media (prefers-color-scheme: dark) {\n  :root {\n    --ns-bg: #111;\n  }\n}\n');
  assert.equal(validateThemeCss(dark), null);
  assert.equal(getVar(dark, 'dark', 'bg'), '#111');
  assert.equal(validateThemeCss(setVar(dark, 'light', 'text', '#000')), null);
});

test('one-line and unterminated declarations, and a file with no :root at all', () => {
  assert.equal(setVar(':root{--ns-bg:#fff}', 'base', 'text', '#000'), ':root{--ns-bg:#fff; --ns-text: #000; }');
  assert.equal(setVar(':root { }', 'base', 'text', '#000'), ':root { --ns-text: #000; }');
  assert.equal(setVar(':root {\n  --ns-bg: #fff\n}\n', 'base', 'text', '#000'), ':root {\n  --ns-bg: #fff;\n  --ns-text: #000;\n}\n');
  // a plain CSS theme made by hand: the editor adds a :root block and leaves the rest alone
  const plain = '.notion-sidebar { background: red; }';
  assert.equal(setVar(plain, 'base', 'bg', '#fff'), `${plain}\n:root {\n  --ns-bg: #fff;\n}\n`);
});

test('removing a variable removes its line, and only that', () => {
  const css = START_CSS('t');
  const next = removeVar(css, 'base', 'text');
  assert.equal(getVar(next, 'base', 'text'), null);
  assert.equal(next, css.replace('  --ns-text: #37352f;\n', ''));
  assert.equal(removeVar(next, 'base', 'text'), next, 'removing what is not there changes nothing');
  assert.equal(validateThemeCss(next), null);

  const noDark = removeVar(SAVED, 'dark', 'bg');
  assert.equal(getVar(noDark, 'dark', 'bg'), null);
  assert.equal(getVar(noDark, 'dark', 'font-code'), '"Menlo", monospace');
  assert.equal(getVar(noDark, 'base', 'bg'), '#fdf6e3');
  assert.equal(validateThemeCss(noDark), null);
});

test('the last declaration wins, and a value with no space or semicolon is read right', () => {
  assert.equal(getVar(':root { --ns-bg: red; --ns-bg: blue; }', 'base', 'bg'), 'blue');
  assert.equal(setVar(':root { --ns-bg: red; --ns-bg: blue; }', 'base', 'bg', 'green'), ':root { --ns-bg: red; --ns-bg: green; }');
  assert.equal(getVar(':root { --ns-bg:red }', 'base', 'bg'), 'red');
  assert.equal(setVar(':root { --ns-bg:red }', 'base', 'bg', 'blue'), ':root { --ns-bg:blue }');
});

test('hex colors for the native picker, anything else is left as typed', () => {
  assert.equal(pickerHex('#ABC'), '#aabbcc');
  assert.equal(pickerHex(' #1a1a1a '), '#1a1a1a');
  assert.equal(pickerHex('rgb(1, 2, 3)'), null);
  assert.equal(pickerHex('color-mix(in srgb, red, blue)'), null);
  assert.equal(pickerHex(undefined), null);
});

test('every edit the editor can make stays inside what the marketplace check accepts', () => {
  let css = START_CSS('x');
  for (const scope of ['base', 'dark', 'light']) {
    for (const key of ALL_VARS) css = setVar(css, scope, key, '#abcdef');
  }
  assert.equal(validateThemeCss(css), null);
  for (const scope of ['base', 'dark', 'light']) {
    for (const key of ALL_VARS) css = removeVar(css, scope, key);
  }
  assert.equal(validateThemeCss(css), null);
});

test('Save and publish finds the theme you own in the "Publish a new version" list, whatever the label says', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const gui = file => fs.readFileSync(path.join(__dirname, '..', 'src', 'gui', file), 'utf8');

  // the label the list is drawn with, and the pattern publishFromEditor() strips from it, are in different files
  const label = gui('marketplace.js').match(/<option value="[^"]*">\$\{esc\(s\.name\)\} (\(version \$\{esc\(s\.version \|\| 1\)\}\))<\/option>/);
  assert.ok(label, 'could not find the option label in marketplace.js');
  const strip = gui('themes.js').match(/o\.textContent\.replace\(\/(.+?)\/, ''\) === display/);
  assert.ok(strip, 'could not find the label pattern in publishFromEditor()');
  const pattern = new RegExp(strip[1]);

  assert.equal('quiet (version 1)'.replace(pattern, ''), 'quiet');
  assert.equal('my theme (version 12)'.replace(pattern, ''), 'my theme');
  // labels from before the copy change still work
  assert.equal('quiet (now version 3)'.replace(pattern, ''), 'quiet');
  // a name that merely contains the word is left alone
  assert.equal('version control'.replace(pattern, ''), 'version control');
});

test('a new theme\'s placeholder comment is swapped for its name, and only the placeholder', () => {
  const { nameComment, PLACEHOLDER_NAME } = editor;
  const fresh = START_CSS(PLACEHOLDER_NAME);
  const named = nameComment(fresh, 'sunset');
  assert.equal(named.split('\n')[0], '/* sunset */');
  assert.equal(named.split('\n').slice(1).join('\n'), fresh.split('\n').slice(1).join('\n'), 'nothing else changes');
  assert.equal(validateThemeCss(named), null);
  // a first line the person wrote, or no comment at all, stays as it is
  const own = '/* my own notes */\n:root { --ns-bg: #fff; }\n';
  assert.equal(nameComment(own, 'sunset'), own);
  assert.equal(nameComment(':root { --ns-bg: #fff; }\n', 'sunset'), ':root { --ns-bg: #fff; }\n');
  // the page starts from the same placeholder the helper looks for
  const fs = require('fs');
  const page = fs.readFileSync(require('path').join(__dirname, '..', 'src/gui/themes.js'), 'utf-8');
  assert.match(page, /START_CSS\(nsThemeEditor\.PLACEHOLDER_NAME\)/);
});

test('Settings looks at the developer folder again while developer mode is on, so its count stays true', () => {
  const fs = require('fs');
  const page = fs.readFileSync(require('path').join(__dirname, '..', 'src/gui/settings.js'), 'utf-8');
  const loop = page.match(/setInterval\(async \(\) => \{[\s\S]*?\}, (\d+)\);/);
  assert.ok(loop, 'there is a refresh loop');
  assert.match(loop[0], /developer\.enabled/, 'only while developer mode is on');
  assert.match(loop[0], /document\.hidden/, 'not while the page is hidden');
  assert.match(loop[0], /\/api\/developer/);
  assert.ok(Number(loop[1]) >= 2000, 'not more often than every 2 seconds');
});
