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
