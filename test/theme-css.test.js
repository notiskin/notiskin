const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateThemeCss } = require('../supabase/functions/_shared/css.ts');

test('accepts a normal color theme', () => {
  const css = `/* Dark */
:root {
  --ns-bg: #1a1a1a;
  --ns-text: rgb(224, 224, 224);
  --ns-hover-bg: color-mix(in srgb, var(--ns-bg) 80%, white);
  --ns-callout-bg: linear-gradient(90deg, #111 0%, #222 100%);
}`;
  assert.equal(validateThemeCss(css), null);
});

test('rejects rules outside :root', () => {
  assert.match(validateThemeCss(':root { --ns-bg: red; } body { display: none; }'), /inside a :root block/);
});

test('rejects properties that are not --ns- variables', () => {
  assert.match(validateThemeCss(':root { color: red; }'), /must start with --ns-/);
});

test('rejects url() and string-based image loading', () => {
  assert.ok(validateThemeCss(':root { --ns-bg: url(https://evil.test/x.png); }'));
  assert.ok(validateThemeCss(':root { --ns-bg: image-set("https://evil.test/x.png" 1x); }'));
  assert.ok(validateThemeCss(':root { --ns-bg: image-set(x 1x); }'));
});

test('rejects CSS escapes that spell url(', () => {
  assert.ok(validateThemeCss(':root { --ns-bg: \\75rl(https://evil.test/x.png); }'));
});

test('rejects @import and nested blocks', () => {
  assert.ok(validateThemeCss('@import "https://evil.test/a.css"; :root { --ns-bg: red; }'));
  assert.ok(validateThemeCss(':root { --ns-bg: red; :root { --ns-a: b } }'));
});

test('rejects empty, huge, and non-string input', () => {
  assert.ok(validateThemeCss(''));
  assert.ok(validateThemeCss(undefined));
  assert.ok(validateThemeCss(`:root { --ns-bg: ${'a'.repeat(30_000)}; }`));
});

test('rejects unclosed comments', () => {
  assert.ok(validateThemeCss(':root { --ns-bg: red; } /* oops'));
});
