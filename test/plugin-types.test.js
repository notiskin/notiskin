// notiskin.d.ts is what plugin authors get for editor help. These tests keep it true to the code that makes
// window.notiskin (CORE_JS in src/injector/index.ts): same names, same kinds, same version, and the starter
// plugins and a few correct and wrong calls type-check the way they should
require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const dtsPath = path.join(root, 'notiskin.d.ts');
const dtsText = fs.readFileSync(dtsPath, 'utf-8');
const { CORE_JS } = require('../dist/injector/index');

// window.notiskin as the page makes it, with just enough of a page for the code to run
function realApi() {
  const element = () => ({ id: '', className: '', textContent: '', style: {}, appendChild() {}, remove() {}, addEventListener() {} });
  const window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
  };
  const document = {
    body: element(), head: element(), documentElement: element(), readyState: 'complete',
    createElement: element, getElementById: () => null, querySelector: () => null,
  };
  class MutationObserver { observe() {} }
  vm.runInNewContext(CORE_JS, { window, document, location: { href: 'https://www.notion.so/', pathname: '/' }, MutationObserver, console, setTimeout });
  assert.ok(window.notiskin, 'CORE_JS makes window.notiskin');
  return window.notiskin;
}

// the members of an interface in the .d.ts: name -> { kind: 'method' | 'property', type }
function members(sourceFile, interfaceName) {
  const out = new Map();
  ts.forEachChild(sourceFile, node => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== interfaceName) return;
    for (const m of node.members) {
      const name = m.name.getText(sourceFile);
      if (ts.isMethodSignature(m)) out.set(name, { kind: 'method' });
      else if (ts.isPropertySignature(m)) out.set(name, { kind: 'property', type: m.type.getText(sourceFile) });
    }
  });
  return out;
}

const dts = ts.createSourceFile('notiskin.d.ts', dtsText, ts.ScriptTarget.ES2022, true);

test('notiskin.d.ts declares exactly what window.notiskin has: the same names, methods as methods', () => {
  const api = realApi();
  const declared = members(dts, 'Notiskin');
  assert.ok(declared.size > 0, 'found interface Notiskin');
  const runtime = Object.keys(api);
  assert.deepEqual([...declared.keys()].sort(), [...runtime].sort(), 'same member names');
  for (const name of runtime) {
    if (typeof api[name] === 'function') assert.equal(declared.get(name).kind, 'method', `${name} is a method`);
    else assert.equal(declared.get(name).kind, 'property', `${name} is a property`);
  }
  // the internals are not public: not enumerable, so not in the types
  for (const name of ['__forPlugin', '__updateSettings']) {
    assert.ok(!declared.has(name), name);
    assert.ok(!(name in declared));
  }
});

test('notiskin.d.ts declares the settings API the same way, for the page object and for a plugin\'s own', () => {
  const api = realApi();
  const declared = members(dts, 'NotiskinSettings');
  assert.deepEqual([...declared.keys()].sort(), Object.keys(api.settings).sort());
  for (const [name, member] of declared) {
    assert.equal(member.kind, 'method', name);
    assert.equal(typeof api.settings[name], 'function', name);
  }
  // a plugin that declares settings gets notiskin.__forPlugin(name), which has the same shape
  const own = api.__forPlugin('example');
  assert.deepEqual(Object.keys(own.settings).sort(), Object.keys(api.settings).sort());
  assert.equal(members(dts, 'Notiskin').get('settings').type, 'NotiskinSettings');
});

test('the version in notiskin.d.ts is the version of the API, in the type and in the header', () => {
  const api = realApi();
  assert.match(api.version, /^\d+\.\d+\.\d+$/);
  assert.equal(members(dts, 'Notiskin').get('version').type, `'${api.version}'`);
  assert.match(dtsText.split('\n')[0], new RegExp(`version ${api.version.replace(/\./g, '\\.')}$`));
});

test('every setting type the app understands is in the declaration type, with its fields', () => {
  const settings = fs.readFileSync(path.join(root, 'src', 'core', 'plugin-settings.ts'), 'utf-8');
  const inApp = [...settings.matchAll(/\| \(SettingBase & \{ type: '(\w+)'/g)].map(m => m[1]);
  const inTypes = [...dtsText.matchAll(/NotiskinSettingBase & \{ type: '(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(inTypes.sort(), inApp.sort());
  assert.ok(inApp.length === 5, 'toggle, text, number, select, color');
  // the fields each one takes
  for (const field of ['maxLength', 'min', 'max', 'step', 'options']) {
    assert.ok(settings.includes(field) && dtsText.includes(field), field);
  }
});

// ---- type-checking with the real compiler ----

const LIBS = { allowJs: true, checkJs: true, noEmit: true, strict: false, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], target: ts.ScriptTarget.ES2022, types: [] };

// diagnostics for source text, as if it were a plugin file next to notiskin.d.ts
function check(fileName, source, options = LIBS) {
  const virtual = path.join(root, '__virtual__', fileName);
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) => (name === virtual ? ts.createSourceFile(name, source, languageVersion, true) : original(name, languageVersion, ...rest));
  host.fileExists = name => name === virtual || ts.sys.fileExists(name);
  host.readFile = name => (name === virtual ? source : ts.sys.readFile(name));
  const program = ts.createProgram([dtsPath, virtual], options, host);
  return ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

test('the starter plugins type-check against notiskin.d.ts', () => {
  const dir = path.join(root, 'starter', 'plugins');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  assert.ok(files.length >= 4);
  for (const file of files) {
    const problems = check(`starter-${file}`, fs.readFileSync(path.join(dir, file), 'utf-8'));
    assert.deepEqual(problems, [], file);
  }
});

test('a plugin that uses every method correctly has no type errors', () => {
  const good = `
    // @ts-check
    notiskin.ready(() => {});
    notiskin.onPageChange(() => {});
    notiskin.onBlockLoad(content => content.querySelector('div'));
    const unsubscribe = notiskin.onContentChange(content => content.children.length);
    unsubscribe();
    const title = notiskin.getPageTitle();
    if (title !== null) title.toUpperCase();
    const id = notiskin.getPageId();
    const url = notiskin.getPageUrl().length;
    const scroller = notiskin.getPageScroller();
    if (scroller) scroller.scrollTop = 0;
    const button = notiskin.addToolbarButton('Go', clicked => clicked.classList.add('x'));
    notiskin.removeToolbarButton(button);
    const style = notiskin.addStyle('mine', 'body { color: red }');
    style.disabled = false;
    notiskin.removeStyle('mine');
    const scheme = notiskin.getColorScheme();
    if (scheme === 'dark') notiskin.removeStyle('x');
    const off = notiskin.onColorSchemeChange(next => next === 'light');
    off();
    const height = notiskin.settings.get('height');
    if (typeof height === 'number') height.toFixed(1);
    const all = notiskin.settings.getAll();
    notiskin.settings.onChange((key, value, everything) => { key.length; value; everything.x; })();
    window.notiskin.version === '1.2.0';
    all.y;
    id; url;
  `;
  assert.deepEqual(check('good.js', good), []);
});

test('mistakes in a plugin are underlined: a method that does not exist, wrong arguments, wrong values', () => {
  const wrong = {
    'a method that is not there': 'notiskin.getTitle();',
    'a number for the label': "notiskin.addToolbarButton(1, () => {});",
    'a missing callback': "notiskin.addToolbarButton('Go');",
    'a color scheme that does not exist': "if (notiskin.getColorScheme() === 'blue') {}",
    'the title used without checking for null': "notiskin.getPageTitle().trim();",
    'css that is not a string': "notiskin.addStyle('x', 12);",
    'a setting key that is not a string': "notiskin.settings.get(3);",
    'assigning to settings': "notiskin.settings = null;",
    'the wrong version': "const v = notiskin.version === '0.9.0';",
  };
  const strict = { ...LIBS, strict: true };
  for (const [what, line] of Object.entries(wrong)) {
    assert.ok(check('wrong.js', `// @ts-check\n${line}\n`, strict).length > 0, `${what} should be an error`);
  }
});

test('notiskin.d.ts is valid on its own, and the repository points to it', () => {
  const problems = check('empty.js', '');
  assert.deepEqual(problems, []);
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf-8'), /notiskin\.d\.ts/);
  assert.match(fs.readFileSync(path.join(root, 'site', 'plugins.html'), 'utf-8'), /notiskin\.d\.ts/);
});
