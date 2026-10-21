import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { validateThemeCss } from './css.ts';

const ok = (css: string) => assertEquals(validateThemeCss(css), null, css);
const bad = (css: unknown) => assertNotEquals(validateThemeCss(css), null, String(css));

Deno.test('accepts plain --ns-* colors inside :root', () => {
  ok(':root { --ns-bg: #fff; --ns-text: rgb(10, 20, 30); }');
  ok(':root{--ns-accent:oklch(60% 0.2 30)}');
  ok('/* my theme */ :root { --ns-bg: linear-gradient(to right, #000, #fff); --ns-x: calc(var(--ns-y) * 2); }');
});

Deno.test('rejects empty, non-string and oversized input', () => {
  bad('');
  bad('   ');
  bad(undefined);
  bad(42);
  bad(':root { --ns-a: red; }' + ' '.repeat(20_000));
});

Deno.test('rejects rules outside :root and other selectors', () => {
  bad('body { color: red; }');
  bad(':root { --ns-a: red; } body { background: red; }');
  bad('--ns-a: red;');
  bad('.x:root { --ns-a: red; }');
});

Deno.test('rejects properties that are not --ns-*', () => {
  bad(':root { color: red; }');
  bad(':root { --other: red; }');
  bad(':root { --ns-: red; }');
  bad(':root { background: url(x) ; }');
});

Deno.test('rejects url(), image-set() and other functions off the allowlist', () => {
  bad(':root { --ns-a: url(https://evil.example/x.png); }');
  bad(':root { --ns-a: image-set(red 1x); }');
  bad(':root { --ns-a: image-set("a.png" 1x); }');
  bad(':root { --ns-a: expression(alert(1)); }');
  bad(':root { --ns-a: attr(x); }');
});

Deno.test('rejects CSS escapes, quotes and string tricks', () => {
  bad(String.raw`:root { --ns-a: \75rl(https://evil.example/x); }`);
  bad(':root { --ns-a: "red"; }');
  bad(":root { --ns-a: 'red'; }");
  bad(':root { --ns-a: red; } @import "x";');
  bad(String.raw`:root { --ns-a: red\; }`);
});

Deno.test('rejects sneaky structure', () => {
  bad(':root { --ns-a: red');
  bad(':root { --ns-a: red; /* open comment');
  bad(':root { --ns-a }');
  bad(':root { --ns-a: ; }');
  bad(':root { --ns-a: red; :root { --ns-b: blue; } }');
  bad(':root { --ns-a: {x}; }');
});

Deno.test('function names are checked case-insensitively', () => {
  ok(':root { --ns-a: RGB(1,2,3); }');
  bad(':root { --ns-a: URL(x); }');
});
