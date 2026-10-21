import { assertEquals } from 'jsr:@std/assert@1';
import { cleanLink, cleanTags } from './details.ts';

Deno.test('cleanTags allows up to 3 known tags', () => {
  assertEquals(cleanTags(undefined), []);
  assertEquals(cleanTags(null), []);
  assertEquals(cleanTags([]), []);
  assertEquals(cleanTags(['dark', 'minimal']), ['dark', 'minimal']);
  assertEquals(cleanTags(['dark', 'dark']), ['dark']);
  assertEquals(cleanTags(['dark', 'light', 'fun']), ['dark', 'light', 'fun']);
});

Deno.test('cleanTags refuses unknown tags, too many, and non-lists', () => {
  for (const bad of [['dark', 'evil'], ['dark', 'light', 'fun', 'fonts'], 'dark', [1], [null], ['Dark']]) {
    assertEquals(cleanTags(bad), null, JSON.stringify(bad));
  }
});

Deno.test('cleanLink allows only https github.com and gist links', () => {
  assertEquals(cleanLink(undefined), null);
  assertEquals(cleanLink(''), null);
  assertEquals(cleanLink('  '), null);
  assertEquals(cleanLink('https://github.com/octocat/dark-theme'), 'https://github.com/octocat/dark-theme');
  assertEquals(cleanLink(' https://gist.github.com/octocat/abc123 '), 'https://gist.github.com/octocat/abc123');
  for (const bad of [
    'http://github.com/x',
    'https://evil.example/x',
    'https://github.com.evil.example/x',
    'https://github.com/x?y=1',
    'https://github.com/x#readme',
    'javascript:alert(1)',
    'https://github.com/' + 'a'.repeat(201),
    'https://github.com/',
    42,
  ]) {
    assertEquals(cleanLink(bad), false, String(bad));
  }
});
