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

Deno.test('font variables accept quoted names and plain words, up to 8', () => {
  ok(':root { --ns-font: "Inter Display", "Helvetica Neue", Arial, sans-serif; }');
  ok(':root { --ns-font-title: Georgia, serif; --ns-font-code: "JetBrains Mono", monospace; }');
  ok(':root{--ns-font:"Fira-Code"}');
  ok(':root { --ns-font: a, b, c, d, e, f, g, h; }');
  bad(':root { --ns-font: a, b, c, d, e, f, g, h, i; }');
});

Deno.test('font variables still refuse anything that could load or escape', () => {
  bad(':root { --ns-font: url(https://evil.example/x.woff); }');
  bad(':root { --ns-font: "a", url(x); }');
  bad(":root { --ns-font: 'Inter'; }");
  bad(':root { --ns-font: "Inter; } body { display: none; } :root { --ns-x: "; }');
  bad(':root { --ns-font: "a\\"; }');
  bad(String.raw`:root { --ns-font: "\75rl(x)"; }`);
  bad(':root { --ns-font: "a(b)"; }');
  bad(':root { --ns-font: "a:b"; }');
  bad(':root { --ns-font: "a;b"; }');
  bad(':root { --ns-font: "a{b}"; }');
  bad(':root { --ns-font: "a/b"; }');
  bad(':root { --ns-font: "a" "b"; }');
  bad(':root { --ns-font: var(--ns-x); }');
  bad(':root { --ns-font: ; }');
  bad(`:root { --ns-font: "${'a'.repeat(41)}"; }`);
});

Deno.test('quotes stay banned in every other variable, including look-alike names', () => {
  bad(':root { --ns-bg: "red"; }');
  bad(':root { --ns-fonts: "Inter"; }');
  bad(':root { --ns-font-size: "Inter"; }');
  bad(':root { --ns-font2: "Inter"; }');
  bad(':root { --ns-bg: image-set("https://evil.example/x.png" 1x); }');
});

Deno.test('a dark or light variant may wrap :root in a prefers-color-scheme block', () => {
  ok(`:root { --ns-bg: #fff; }
@media (prefers-color-scheme: dark) { :root { --ns-bg: #111; --ns-text: #eee; } }`);
  ok(`@media (prefers-color-scheme:light){:root{--ns-bg:#fff}}
@media (prefers-color-scheme:dark){:root{--ns-bg:#000}}`);
  ok(`/* both */ :root { --ns-font: "Inter", sans-serif; }
@media (prefers-color-scheme: dark) { :root { --ns-font: Georgia, serif; } }`);
});

Deno.test('the prefers-color-scheme wrapper is the only @media allowed, and holds nothing but :root', () => {
  bad('@media (min-width: 1px) { :root { --ns-bg: red; } }');
  bad('@media screen { :root { --ns-bg: red; } }');
  bad('@media (prefers-color-scheme: dark) and (min-width: 1px) { :root { --ns-bg: red; } }');
  bad('@media (prefers-color-scheme: dark), print { :root { --ns-bg: red; } }');
  bad('@media not (prefers-color-scheme: dark) { :root { --ns-bg: red; } }');
  bad('@media (prefers-color-scheme: sepia) { :root { --ns-bg: red; } }');
  bad('@media (prefers-color-scheme: dark) { body { display: none; } }');
  bad('@media (prefers-color-scheme: dark) { :root { --ns-bg: red; } body { display: none; } }');
  bad('@media (prefers-color-scheme: dark) { :root { --ns-bg: red; } :root { color: red; } }');
  bad('@media (prefers-color-scheme: dark) { :root { --ns-bg: url(x); } }');
  bad('@media (prefers-color-scheme: dark) { @media (prefers-color-scheme: dark) { :root { --ns-bg: red; } } }');
  bad('@media (prefers-color-scheme: dark) { :root { --ns-bg: red; }');
  bad('@media (prefers-color-scheme: dark) { }');
  bad('@media (prefers-color-scheme: dark) { :root { } } body { display: none; }');
  bad('@import "x"; @media (prefers-color-scheme: dark) { :root { --ns-bg: red; } }');
  bad('@media (prefers-color-scheme: dark) { :root { --ns-bg: red; } } @media print { :root { --ns-bg: blue; } }');
});

Deno.test('no more than one dark and one light block', () => {
  const dark = '@media (prefers-color-scheme: dark) { :root { --ns-bg: #000; } }';
  ok(`${dark} @media (prefers-color-scheme: light) { :root { --ns-bg: #fff; } }`);
  bad(`${dark} ${dark} ${dark}`);
});
