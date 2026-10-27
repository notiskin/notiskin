const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CORE_CSS } = require('../dist/injector/index');

test('the core CSS no longer flattens every color with a blanket rule', () => {
  assert.doesNotMatch(CORE_CSS, /\.notion-app-inner \* \{/);
  // plain text still takes the theme color
  assert.match(CORE_CSS, /\.notion-app-inner :not\([^)]*\) \{ color: var\(--ns-text\) !important; \}/);
});

test('text Notion colored is left out of the theme text color, with its descendants', () => {
  const rule = CORE_CSS.split('\n').find(line => line.includes('var(--ns-text) !important'));
  for (const hue of ['gra', 'bro', 'ora', 'yel', 'gre', 'blu', 'pur', 'pin', 'red']) {
    assert.ok(rule.includes(`[style*="color:var(--c-${hue}Tex"],`), `${hue} on a span`);
    assert.ok(rule.includes(`[style*="color: var(--c-${hue}Tex"] *`), `${hue} on a block, children too`);
  }
});

test('every color has palette variables that fall back to Notion\'s own token', () => {
  for (const [hue, name] of [['gra', 'gray'], ['bro', 'brown'], ['ora', 'orange'], ['yel', 'yellow'], ['gre', 'green'],
    ['blu', 'blue'], ['pur', 'purple'], ['pin', 'pink'], ['red', 'red']]) {
    assert.ok(CORE_CSS.includes(`color: var(--ns-color-${name}, var(--c-${hue}TexSec)) !important`), `${name} text`);
    assert.ok(CORE_CSS.includes(`background: var(--ns-color-${name}-bg, var(--c-${hue}BacSec)) !important`), `${name} block background`);
    assert.ok(CORE_CSS.includes(`background: var(--ns-color-${name}-bg, var(--ca-${hue}BacSecTra)) !important`), `${name} highlight`);
  }
});

test('the palette is not set by default, so Notion\'s colors stay unless a theme sets them', () => {
  const root = CORE_CSS.match(/:root \{[^}]*\}/)[0];
  assert.doesNotMatch(root, /--ns-color-/);
});

const { coreCssFor, fontCss } = require('../dist/injector/index');

test('fonts are only overridden for the font variables a theme sets', () => {
  assert.equal(fontCss(':root { --ns-bg: #fff; }'), '');
  assert.equal(coreCssFor(':root { --ns-bg: #fff; }'), CORE_CSS);

  const body = fontCss(':root { --ns-font: "Inter", serif; }');
  assert.match(body, /font-family: var\(--ns-font\) !important/);
  assert.match(body, /var\(--ns-font-title, var\(--ns-font\)\)/, 'titles follow the body font');
  assert.doesNotMatch(body, /--ns-font-code/);
  // the text inside a heading has Notion's sans stack inline, which names Apple Color Emoji: only a style that starts with it is emoji
  assert.match(body, /notion-header-block[^{]*\*:not\(\[style\*="SFMono-Regular"\], \[style\*='font-family: "Apple Color Emoji"'\]\) \{ font-family: var\(--ns-font-title/);

  const code = fontCss(':root { --ns-font-code: monospace; }');
  assert.match(code, /--ns-font-code/);
  assert.doesNotMatch(code, /var\(--ns-font\) !important/);
  assert.doesNotMatch(code, /page-block/);

  // --ns-font-title must not count as --ns-font
  assert.doesNotMatch(fontCss(':root { --ns-font-title: serif; }'), /\.notion-app-inner,/);
  // a variant inside @media counts too
  assert.match(fontCss('@media (prefers-color-scheme: dark) { :root { --ns-font: serif; } }'), /--ns-font\)/);
});

test('the new look variables are not set by default, so a theme that sets none changes nothing', () => {
  const root = CORE_CSS.match(/:root \{[^}]*\}/)[0];
  for (const name of ['border-color', 'radius', 'table-header-bg', 'table-row-hover-bg', 'board-card-bg', 'font']) {
    assert.doesNotMatch(root, new RegExp(`--ns-${name}`));
    assert.ok(CORE_CSS.includes(`--ns-${name}`) || name === 'font', `${name} is used`);
  }
  assert.match(CORE_CSS, /\.notion-table-view-row:hover \.notion-table-view-cell \{ background-image: linear-gradient\(var\(--ns-table-row-hover-bg, transparent\)/);
});

const { tokenCss, TOKEN_VARS } = require('../dist/injector/index');

test('Notion\'s own interface colors are only overridden for the variables a theme sets', () => {
  assert.equal(tokenCss(':root { --ns-bg: #fff; }'), '');
  assert.equal(coreCssFor(':root { --ns-bg: #fff; }'), CORE_CSS);

  const popup = tokenCss(':root { --ns-popup-bg: #2a1450; }');
  assert.match(popup, /^:root, \.notion-light-theme, \.notion-dark-theme \{ --c-popBac: var\(--ns-popup-bg\) !important; \}$/);

  // --ns-text must not count as --ns-text-secondary, and the other way round
  assert.equal(tokenCss(':root { --ns-text: #fff; }'), '');
  const secondary = tokenCss(':root { --ns-text-secondary: #999; }');
  assert.match(secondary, /--c-texSec: var\(--ns-text-secondary\) !important/);
  assert.doesNotMatch(secondary, /--c-texTer/);

  // a variant inside @media counts too
  assert.match(tokenCss('@media (prefers-color-scheme: dark) { :root { --ns-icon-color: #ffd166; } }'), /--c-icoPri: var\(--ns-icon-color\)/);
});

test('every theme variable for Notion\'s interface points at tokens that start with --c- or --ca-', () => {
  assert.ok(TOKEN_VARS.length >= 6);
  for (const [name, tokens] of TOKEN_VARS) {
    assert.match(name, /^[a-z-]+$/);
    assert.ok(tokens.length > 0);
    for (const token of tokens) assert.match(token, /^--c[a]?-[A-Za-z0-9]+$/, `${name} -> ${token}`);
  }
});

test('the accent recolors the accent tokens but not the blue Notion uses for colored content', () => {
  const css = tokenCss(':root { --ns-accent: #ff5d8f; }');
  for (const token of ['--c-bluBacAccPri', '--c-bluBorAccPri', '--c-bluIcoAccPri', '--c-bluTexAccPri', '--c-palUiBlu600', '--c-bluButHovBac', '--ca-palUiBlu100']) {
    assert.ok(css.includes(`${token}:`), token);
  }
  // blue text and blue blocks a person made keep their color
  assert.doesNotMatch(css, /--c-bluTexSec|--c-bluBacSec|--ca-bluBac|--c-bluTexPri/);
  assert.match(css, /--ca-palUiBlu50: color-mix\(in srgb, var\(--ns-accent\) 3\.5%, transparent\)/);
});

test('text selection and the caret have their own rules, only when a theme sets them', () => {
  assert.match(tokenCss(':root { --ns-selection-bg: #2563eb40; }'), /::selection \{ background: var\(--ns-selection-bg\); \}/);
  assert.match(tokenCss(':root { --ns-caret-color: #ffd166; }'), /caret-color: var\(--ns-caret-color\) !important/);
  assert.equal(tokenCss(':root { --ns-accent-nothing: red; }'), '');
});

test('the header around the top bar follows the top bar color, and menus keep their own background', () => {
  assert.match(CORE_CSS, /header:has\(\.notion-topbar\) \{ background: var\(--ns-topbar-bg\) !important; \}/);
  // popups are .notion-scroller too, only the page's own scrollers take the page color
  assert.doesNotMatch(CORE_CSS, /\.notion-page-content, \.notion-scroller \{/);
  assert.match(CORE_CSS, /\.notion-frame \.notion-scroller/);
});

test('the page API is version 1.2.0 and keeps every older method', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require('path').join(__dirname, '..', 'src/injector/index.ts'), 'utf-8');
  assert.match(source, /version: '1\.2\.0'/);
  for (const m of ['onPageChange', 'onBlockLoad', 'getPageTitle', 'addToolbarButton', 'removeToolbarButton', 'getPageUrl', 'ready']) {
    assert.match(source, new RegExp(`\\n      ${m}\\(`), m);
  }
});
