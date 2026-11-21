const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('fs');
const { join } = require('path');
const {
  parsePermissionDeclarations, scanPlugin, comparePermissions, pluginPermissionReport, permissionChanges, isValidHost,
  MAX_HOSTS, MAX_HOSTS_PER_LINE,
} = require('../dist/core/plugin-permissions');
const { parseSettingDeclarations } = require('../dist/core/plugin-settings');

const block = (...lines) => `/**\n${lines.map(l => ` * ${l}`).join('\n')}\n */\nconsole.log('plugin');\n`;
const hostsOf = n => Array.from({ length: n }, (_, i) => `h${i}.example.com`);
// what the scan found, as "category what" strings
const found = code => scanPlugin(code).evidence.map(e => `${e.category} ${e.what}`);
const categories = code => scanPlugin(code).detected;

// ---- the header lines ----

test('permission lines are read from a /** */ header, next to settings', () => {
  const code = block(
    '@notiskin-setting {"key":"on","type":"toggle","label":"On","default":true}',
    '@notiskin-permission network api.example.com *.example.org',
    '@notiskin-permission storage',
    '@notiskin-permission page-scripts',
    '@notiskin-permission dynamic-code',
  );
  assert.deepEqual(parsePermissionDeclarations(code), {
    declared: ['network', 'storage', 'page-scripts', 'dynamic-code'],
    hosts: ['api.example.com', '*.example.org'],
    problems: [],
  });
  // the settings in the same header still work
  assert.equal(parseSettingDeclarations(code).settings.length, 1);
});

test('permission lines also work as // comments and in a one-line block comment', () => {
  const code = '// My plugin\n// @notiskin-permission storage\n/* @notiskin-permission network a.example.com */\nrun();\n';
  assert.deepEqual(parsePermissionDeclarations(code).declared, ['network', 'storage']);
  assert.deepEqual(parsePermissionDeclarations(code).hosts, ['a.example.com']);
});

test('only the header counts: a line after the first code, or in a string, is not a declaration', () => {
  const code = 'run();\n// @notiskin-permission storage\nconst s = "@notiskin-permission network x.example.com";\n';
  assert.deepEqual(parsePermissionDeclarations(code), { declared: [], hosts: [], problems: [] });
});

test('duplicates merge, in a fixed order', () => {
  const code = block('@notiskin-permission storage', '@notiskin-permission network a.example.com b.example.com', '@notiskin-permission storage', '@notiskin-permission network b.example.com c.example.com');
  const parsed = parsePermissionDeclarations(code);
  assert.deepEqual(parsed.declared, ['network', 'storage']);
  assert.deepEqual(parsed.hosts, ['a.example.com', 'b.example.com', 'c.example.com']);
  assert.deepEqual(parsed.problems, []);
});

test('a bad line is skipped with a sentence and the rest still count', () => {
  const cases = [
    ['@notiskin-permission', /no name/],
    ['@notiskin-permission camera', /unknown permission "camera"/],
    ['@notiskin-permission network', /names no hosts/],
    ['@notiskin-permission network https://api.example.com', /isn't a host name/],
    ['@notiskin-permission network API.example.com', /isn't a host name/],
    ['@notiskin-permission network *.com', /isn't a host name/],
    ['@notiskin-permission network a.*.example.com', /isn't a host name/],
    ['@notiskin-permission network localhost', /isn't a host name/],
    ['@notiskin-permission network 10.0.0.1', /isn't a host name/],
    ['@notiskin-permission network ok.example.com bad_host.com', /isn't a host name/],
    ['@notiskin-permission storage everything', /storage takes nothing after it/],
    [`@notiskin-permission network ${hostsOf(MAX_HOSTS_PER_LINE + 1).join(' ')}`, /more than 10 hosts/],
    [`@notiskin-permission network ${'a'.repeat(1001)}.com`, /longer than/],
  ];
  for (const [bad, why] of cases) {
    const parsed = parsePermissionDeclarations(block(bad, '@notiskin-permission dynamic-code'));
    assert.deepEqual(parsed.declared, ['dynamic-code'], bad);
    assert.deepEqual(parsed.hosts, [], bad);
    assert.equal(parsed.problems.length, 1, bad);
    assert.match(parsed.problems[0], why, bad);
  }
  // @notiskin-permissions (with an s) is some other tag, not ours
  assert.deepEqual(parsePermissionDeclarations(block('@notiskin-permissions storage')), { declared: [], hosts: [], problems: [] });
});

test('hosts: lowercase names with a dot, one leading *. allowed, 20 at most in all', () => {
  for (const ok of ['api.example.com', '*.example.com', 'a-b.c-d.io', 'x1.example.co.uk']) assert.equal(isValidHost(ok), true, ok);
  for (const bad of ['example', '*.com', '**.example.com', '-a.example.com', 'a..example.com', 'Example.com', 'example.com/', 'example.com:443', '']) {
    assert.equal(isValidHost(bad), false, bad);
  }
  const lines = [0, 1, 2].map(i => `@notiskin-permission network ${hostsOf(30).slice(i * 10, i * 10 + 10).join(' ')}`);
  const parsed = parsePermissionDeclarations(block(...lines));
  assert.equal(parsed.hosts.length, MAX_HOSTS);
  assert.deepEqual(parsed.problems, [`Only the first ${MAX_HOSTS} hosts are used.`]);
  assert.deepEqual(parsed.declared, ['network']);
});

// ---- the scan ----

test('network: requests, images, elements that load, addresses on elements, HTML, CSS url(), window.open, forms', () => {
  const cases = {
    "fetch('/x')": 'fetch',
    'window.fetch(u)': 'window.fetch',
    'globalThis["fetch"](u)': 'globalThis.fetch',
    'new XMLHttpRequest()': 'XMLHttpRequest',
    'new WebSocket(u)': 'WebSocket',
    'new EventSource(u)': 'EventSource',
    'navigator.sendBeacon(u, d)': 'navigator.sendBeacon',
    'new Image()': 'new Image',
    "document.createElement('img')": "createElement('img')",
    "document.createElement('IFRAME')": "createElement('IFRAME')",
    "document.createElement('link')": "createElement('link')",
    'el.src = u': 'sets .src',
    'el.srcset = u': 'sets .srcset',
    'a.href = u': 'sets .href',
    "el.setAttribute('src', u)": "setAttribute('src')",
    "el.insertAdjacentHTML('beforeend', h)": 'insertAdjacentHTML(), which can load images or other files',
    'el.innerHTML = h': 'sets innerHTML, which can load images or other files',
    'el.outerHTML += h': 'sets outerHTML, which can load images or other files',
    "s.textContent = 'body { background: url(https://x.test/p.png) }'": 'CSS url( in text',
    'const css = `a { background: URL( ${u} ) }`': 'CSS url( in text',
    "x = '@import \"y.css\";'": 'CSS @import in text',
    'window.open(u)': 'window.open',
    'open(u)': 'window.open',
    'form.submit()': 'submits a form (.submit())',
    'location.href = u': 'sets .href',
    'location.assign(u)': 'location.assign()',
    "document.write('<b>')": 'document.write()',
    'const { fetch: f } = window': 'takes fetch out of an object',
  };
  for (const [code, what] of Object.entries(cases)) {
    assert.ok(found(code).includes(`network ${what}`), `${code} -> ${JSON.stringify(found(code))}`);
    assert.ok(categories(code).includes('network'), code);
  }
});

test('storage: cookies, localStorage, sessionStorage, indexedDB, however they are reached', () => {
  for (const code of ['document.cookie', 'localStorage.getItem("a")', 'window.sessionStorage.x = 1', 'indexedDB.open("db")', 'const { localStorage: ls } = window', "self['localStorage']"]) {
    assert.deepEqual(categories(code), ['storage'], code);
  }
});

test('dynamic code: eval, Function, import(), timers given text, script elements, .constructor()', () => {
  const cases = {
    "eval('1')": 'eval',
    '(0, eval)(s)': 'eval',
    "new Function('return 1')": 'Function',
    "Function('return 1')()": 'Function',
    "import('./x.js')": 'import()',
    "setTimeout('run()', 10)": 'setTimeout() with text instead of a function',
    "setInterval('a' + b, 10)": 'setInterval() with text instead of a function',
    'setTimeout(`go()`, 1)': 'setTimeout() with text instead of a function',
    "document.createElement('script')": "createElement('script')",
    "(() => {}).constructor('return 1')": 'calls .constructor() directly, which can build code from text',
  };
  for (const [code, what] of Object.entries(cases)) {
    assert.ok(found(code).includes(`dynamic-code ${what}`), `${code} -> ${JSON.stringify(found(code))}`);
  }
  // a timer given a function is fine
  assert.deepEqual(categories('setTimeout(() => run(), 10); setInterval(run, 5)'), []);
});

test("page scripts: React's internal keys and Notion's own globals", () => {
  for (const code of [
    "Object.keys(el).find(k => k.startsWith('__reactFiber'))",
    'el.__reactProps$abc',
    'root._reactRootContainer',
    'window.__NEXT_DATA__',
    "window['webpackChunk_notion']",
    '__notionStore.get()',
    'window.__REDUX_DEVTOOLS_EXTENSION__',
  ]) {
    assert.deepEqual(categories(code), ['page-scripts'], code);
  }
  // other globals are not flagged: the scan stays conservative
  assert.deepEqual(categories('window.innerWidth; navigator.language; customGlobal.run(); notiskin.ready(() => {})'), []);
});

test('names the plugin declares itself are not mistaken for the browser\'s', () => {
  assert.deepEqual(categories('function open(x) { return x; } open(1);'), []);
  assert.deepEqual(categories('const fetch = () => 1; fetch();'), []);
  assert.deepEqual(categories('const storage = { localStorage: 1 }; obj.toString(); x.constructor; ({}).hasOwnProperty("a")'), []);
});

test('a name the scan cannot read is a hidden-access note, not a category', () => {
  const scan = scanPlugin("const k = 'fe' + 'tch'; window[k](u); document[name]; createEl(document.createElement(tag))");
  assert.deepEqual(scan.detected, []);
  assert.deepEqual(scan.notes.map(n => n.what), [
    "window[...] with a name the scan can't read",
    "document[...] with a name the scan can't read",
    "createElement() with a tag the scan can't read",
  ]);
  assert.ok(scan.notes.every(n => n.category === 'hidden-access' && n.line === 1));
  // a flag set to fixed text can't carry an address, a computed attribute with a value from elsewhere can
  assert.deepEqual(scanPlugin("el.setAttribute(name, '')").notes, []);
  assert.equal(scanPlugin('el.setAttribute(name, value)').notes.length, 1);
});

test('evidence has line numbers, and addresses written in the code are listed', () => {
  const code = "// header\nconst a = 1;\nfetch('https://API.Example.com/v1');\nimg.src = 'https://cdn.other.test/p.png';\n";
  const scan = scanPlugin(code);
  assert.deepEqual(scan.evidence, [
    { category: 'network', line: 3, what: 'fetch' },
    { category: 'network', line: 4, what: 'sets .src' },
  ]);
  assert.deepEqual(scan.hosts, ['api.example.com', 'cdn.other.test']);
});

test('code that does not parse gives one problem and no detections, it never throws', () => {
  for (const code of ['this is not ( javascript', '}}}', 'fetch(']) {
    assert.deepEqual(scanPlugin(code), { detected: [], evidence: [], notes: [], hosts: [], problems: ["Couldn't read the code to scan it."] });
  }
  // modules and top-level await and return parse too, plugins are written all sorts of ways
  assert.deepEqual(categories('await notiskin.ready(); if (x) return; fetch(u)'), ['network']);
  assert.deepEqual(categories("import x from 'y'; fetch(u)"), ['network']);
});

test('the starter plugins scan clean and declare nothing', () => {
  const dir = join(__dirname, 'fixtures', 'starter-plugins');
  const files = readdirSync(dir).filter(f => f.endsWith('.js'));
  assert.equal(files.length, 4);
  for (const file of files) {
    const report = pluginPermissionReport(readFileSync(join(dir, file), 'utf-8'));
    assert.deepEqual(report.permissions, { declared: [], hosts: [], problems: [] }, file);
    assert.deepEqual(report.scan.detected, [], file);
    assert.deepEqual(report.scan.notes, [], file);
    assert.deepEqual(report.scan.problems, [], file);
  }
});

// ---- comparing ----

test('undeclared is what the scan found minus what the plugin says, any network line covers network', () => {
  const code = `${block('@notiskin-permission network api.example.com')}fetch('https://api.example.com/a'); fetch('https://other.test/b'); localStorage.x = 1; eval(s);`;
  const report = pluginPermissionReport(code);
  assert.deepEqual(report.scan.detected, ['network', 'storage', 'dynamic-code']);
  assert.deepEqual(report.scan.undeclared, ['storage', 'dynamic-code']);
  assert.deepEqual(report.scan.unlistedHosts, ['other.test']);

  const wildcard = comparePermissions(
    { declared: ['network'], hosts: ['*.example.com'], problems: [] },
    { detected: ['network'], evidence: [], notes: [], hosts: ['example.com', 'a.example.com', 'b.a.example.com', 'notexample.com'], problems: [] },
  );
  assert.deepEqual(wildcard.undeclared, []);
  assert.deepEqual(wildcard.unlistedHosts, ['notexample.com']);
});

test('permissionChanges says what a new version adds over the installed one', () => {
  const before = `${block('@notiskin-permission network a.example.com')}fetch(u);`;
  const after = `${block('@notiskin-permission network a.example.com b.example.com', '@notiskin-permission storage')}fetch(u); localStorage.x = 1; eval(s);`;
  const changes = permissionChanges(before, after);
  assert.deepEqual(changes.added, ['storage']);
  assert.deepEqual(changes.addedHosts, ['b.example.com']);
  assert.deepEqual(changes.newlyFound, ['storage', 'dynamic-code']);
  assert.deepEqual(changes.report.scan.undeclared, ['dynamic-code']);
  const same = permissionChanges(before, before);
  assert.deepEqual([same.added, same.addedHosts, same.newlyFound], [[], [], []]);
});
