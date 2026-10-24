// the docs site (site/, published with GitHub Pages): it has to stay true to the code and its links have to work
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, readdirSync } = require('fs');
const { join } = require('path');

const site = join(__dirname, '..', 'site');
const read = file => readFileSync(join(site, file), 'utf-8');
const pages = readdirSync(site).filter(f => f.endsWith('.html'));
const src = file => readFileSync(join(__dirname, '..', file), 'utf-8');
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('the site has its three pages, a stylesheet and the fonts, and no Jekyll processing', () => {
  assert.deepEqual(pages.sort(), ['index.html', 'plugins.html', 'themes.html']);
  for (const f of ['style.css', '.nojekyll', 'fonts/fraunces.woff2', 'fonts/inter.woff2', 'fonts/LICENSE-fraunces.txt', 'fonts/LICENSE-inter.txt']) {
    assert.ok(existsSync(join(site, f)), f);
  }
});

test('every page has a title, a description, one h1 and ids that are not repeated', () => {
  for (const page of pages) {
    const html = read(page);
    assert.match(html, /<title>[^<]+· Notiskin docs<\/title>/, page);
    assert.match(html, /<meta name="description" content="[^"]{20,}">/, page);
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1, `${page} h1`);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${page} repeats an id`);
  }
});

test('every link inside the site goes somewhere: pages, anchors, the stylesheet', () => {
  const idsOf = page => new Set([...read(page).matchAll(/ id="([^"]+)"/g)].map(m => m[1]));
  for (const page of pages) {
    const html = read(page);
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [file, anchor] = href.split('#');
      const target = file || page;
      assert.ok(existsSync(join(site, target)), `${page} links to ${href}`);
      if (anchor) assert.ok(idsOf(target).has(anchor), `${page} links to a missing anchor ${href}`);
    }
    // outside links are https, and only to GitHub
    for (const [, href] of html.matchAll(/href="(https?:[^"]+)"/g)) {
      assert.match(href, /^https:\/\/github\.com\/notiskin\/notiskin(\/|$)/, `${page}: ${href}`);
    }
  }
});

test('the stylesheet\'s colors are the app\'s (src/gui/brand.css), light and dark', () => {
  const tokens = css => {
    const out = { light: {}, dark: {} };
    const darkAt = css.indexOf('prefers-color-scheme: dark');
    const light = css.slice(0, darkAt);
    const dark = css.slice(darkAt);
    for (const [, name, value] of light.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) out.light[name] = value.trim();
    for (const [, name, value] of dark.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) out.dark[name] = value.trim();
    return out;
  };
  const brand = tokens(src('src/gui/brand.css'));
  const docs = tokens(readFileSync(join(site, 'style.css'), 'utf-8'));
  assert.ok(Object.keys(brand.light).length > 30);
  for (const mode of ['light', 'dark']) {
    for (const [name, value] of Object.entries(brand[mode])) assert.equal(docs[mode][name], value, `${mode} ${name}`);
  }
});

test('the themes page lists every --ns- variable the injector uses', () => {
  const core = src('src/injector/index.ts');
  const used = new Set([...core.matchAll(/var\(--ns-([a-z0-9-]+)/g)].map(m => m[1]));
  // the palette is written as --ns-color-<name> in the code
  for (const name of [...used]) if (name.startsWith('color-')) used.delete(name);
  const doc = text(read('themes.html'));
  assert.ok(used.size >= 20, `found ${used.size}`);
  for (const name of used) assert.ok(doc.includes(`--ns-${name}`), `--ns-${name} is not on the themes page`);
  for (const color of ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']) {
    assert.ok(doc.includes(`--ns-color-${color}`) && doc.includes(`--ns-color-${color}-bg`), color);
    assert.ok(core.includes(`'${color}'`), `the injector no longer has ${color}`);
  }
});

test('the themes page states the marketplace rules the check enforces', () => {
  const css = src('supabase/functions/_shared/css.ts');
  const doc = text(read('themes.html'));
  const functions = [...css.matchAll(/'([a-z-]+)'/g)].map(m => m[1]).filter(n => src('supabase/functions/_shared/css.ts').split('ALLOWED_FUNCTIONS')[1].split(']);')[0].includes(`'${n}'`));
  assert.ok(functions.length > 15);
  for (const fn of functions) {
    // repeating- versions are written once as "their repeating- versions"
    if (fn.startsWith('repeating-')) continue;
    assert.ok(doc.includes(fn), `${fn}() is allowed by the check but not on the page`);
  }
  for (const prop of ['--ns-font', '--ns-font-title', '--ns-font-code']) assert.ok(css.includes(`'${prop}'`) && doc.includes(prop), prop);
  assert.match(css, /MAX_CSS_LENGTH = 20_000/);
  assert.ok(doc.includes('20,000'));
  assert.match(css, /MAX_SCHEME_BLOCKS = 2/);
  assert.match(css, /\{0,7\}/, 'up to 8 font names');
  assert.ok(doc.includes('up to 8 font names'));
  assert.match(css, /\{0,39\}/, 'font names up to 40 characters');
  assert.ok(doc.includes('up to 40 characters'));
  const tags = src('src/core/marketplace.ts').match(/MARKETPLACE_TAGS = \[([^\]]+)\]/)[1].replace(/['\s]/g, '').split(',');
  assert.ok(doc.includes(tags.join(', ')), 'the tag list');
  assert.match(src('supabase/functions/_shared/limits.ts'), /submit: \{ max: 5, windowMinutes: 60/);
  assert.ok(doc.includes('5 things per hour'));
});

test('the plugins page documents every method of window.notiskin and the settings API', () => {
  const core = src('src/injector/index.ts');
  const doc = text(read('plugins.html'));
  const api = core.slice(core.indexOf('const api = {'), core.indexOf('// plugin settings.'));
  const methods = [...api.matchAll(/^\s{6}(\w+)\(/gm)].map(m => m[1]);
  assert.deepEqual(methods.sort(), ['addToolbarButton', 'getPageTitle', 'getPageUrl', 'onBlockLoad', 'onPageChange', 'ready', 'removeToolbarButton']);
  for (const m of methods) assert.ok(doc.includes(`${m}(`), `${m}() is missing from the plugins page`);
  const version = core.match(/version: '([\d.]+)'/)[1];
  assert.ok(doc.includes(version), `version ${version}`);
  for (const m of ['settings.get(key)', 'getAll()', 'onChange(fn)']) assert.ok(doc.includes(m), m);

  const settings = src('src/core/plugin-settings.ts');
  for (const type of ['toggle', 'text', 'number', 'select', 'color']) assert.ok(doc.includes(`${type}`) && settings.includes(`case '${type}'`), type);
  assert.match(settings, /MAX_SETTINGS = 20/);
  assert.ok(doc.includes('up to 20'));
  assert.ok(doc.includes('@notiskin-setting') && settings.includes("'@notiskin-setting'"));
  assert.match(src('supabase/functions/submit-plugin/handler.ts'), /MAX_JS_LENGTH = 200_000/);
  assert.ok(doc.includes('200,000'));
});

test('every example on the docs pages that is a theme passes the marketplace check', () => {
  const { validateThemeCss } = require('../supabase/functions/_shared/css.ts');
  const blocks = [...read('themes.html').matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(m => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  const themes = blocks.filter(b => b.includes(':root'));
  assert.ok(themes.length >= 6, `found ${themes.length}`);
  for (const css of themes) assert.equal(validateThemeCss(css), null, css);
});

test('every example plugin header on the plugins page declares settings that parse without problems', () => {
  const { parseSettingDeclarations } = require('../dist/core/plugin-settings');
  const blocks = [...read('plugins.html').matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(m => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  const withSettings = blocks.filter(b => b.includes('@notiskin-setting'));
  assert.equal(withSettings.length, 1);
  const { settings, problems } = parseSettingDeclarations(withSettings[0]);
  assert.deepEqual(problems, []);
  assert.deepEqual(settings.map(s => s.type), ['toggle', 'text', 'number', 'select', 'color']);
  for (const code of blocks) assert.doesNotThrow(() => new Function(code.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, '')), code.slice(0, 60));
});
