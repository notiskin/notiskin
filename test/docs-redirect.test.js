// The docs live in notiskin/notiskin.github.io (https://notiskin.github.io/). This repository's site/ folder only keeps
// redirect pages at the old address, https://notiskin.github.io/notiskin/, because releases 0.7 to 0.10.2 open
// it (index, themes.html, plugins.html) and can't be changed
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const site = path.join(root, 'site');

test('site/ holds only the three redirect pages old versions of the app open', () => {
  assert.deepEqual(fs.readdirSync(site).sort(), ['.nojekyll', 'index.html', 'plugins.html', 'themes.html']);
});

test('each old page sends the browser to the same page at the new address, keeping a #section', () => {
  const targets = { 'index.html': 'https://notiskin.github.io/', 'themes.html': 'https://notiskin.github.io/themes.html', 'plugins.html': 'https://notiskin.github.io/plugins.html' };
  for (const [file, url] of Object.entries(targets)) {
    const html = fs.readFileSync(path.join(site, file), 'utf-8');
    assert.ok(html.includes(`<meta http-equiv="refresh" content="0; url=${url}">`), `${file} refresh`);
    assert.ok(html.includes(`location.replace("${url}" + location.hash)`), `${file} script`);
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), `${file} canonical`);
    assert.ok(html.includes(`<a href="${url}">`), `${file} has a visible link`);
  }
});

test('the app opens the docs at the new address', () => {
  const common = fs.readFileSync(path.join(root, 'src', 'gui', 'common.js'), 'utf-8');
  assert.match(common, /const DOCS_URL = 'https:\/\/notiskin\.github\.io\/';/);
});
