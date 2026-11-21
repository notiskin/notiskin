// types/ is the npm package @notiskin/types: the root notiskin.d.ts, packed with a README and the license.
// These tests pack a throwaway copy of the repository's files (nothing is left in the repository), check what
// the tarball holds, install it offline into a throwaway plugin folder and type-check plugins there the way
// types/README.md says to use it. No network: the tarball has no dependencies and npm runs with --offline
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const dtsText = fs.readFileSync(path.join(root, 'notiskin.d.ts'), 'utf-8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'types', 'package.json'), 'utf-8'));
const apiVersion = dtsText.split('\n')[0].match(/version (\d+\.\d+\.\d+)$/)[1];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notiskin-types-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// npm with its own cache and no network, so the test can't reach the registry or touch the user's cache
function npm(args, cwd) {
  return execFileSync('npm', [...args, '--offline', '--cache', path.join(tmp, 'npm-cache'), '--no-audit', '--no-fund'], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// the files the package is made from, laid out like the repository
function copyOfRepo(name) {
  const dir = path.join(tmp, name);
  for (const file of ['notiskin.d.ts', 'LICENSE', 'scripts/pack-types.js', 'types/package.json', 'types/README.md']) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  return dir;
}

// packs a copy once, for the tests that need the tarball
let packed;
function packOnce() {
  if (packed) return packed;
  const dir = copyOfRepo('packed');
  const out = path.join(tmp, 'tarball');
  fs.mkdirSync(out);
  // prepack runs scripts/pack-types.js, so this is also what `npm publish ./types` does
  const [result] = JSON.parse(npm(['pack', path.join(dir, 'types'), '--pack-destination', out, '--json'], dir));
  packed = { dir, result, tarball: path.join(out, result.filename) };
  return packed;
}

test('the package version is the API version on the first line of notiskin.d.ts', () => {
  assert.equal(pkg.version, apiVersion);
});

test('types/package.json is a public package with only the types in it and nothing to install', () => {
  assert.equal(pkg.name, '@notiskin/types');
  assert.equal(pkg.types, 'notiskin.d.ts');
  assert.deepEqual([...pkg.files].sort(), ['LICENSE', 'README.md', 'notiskin.d.ts']);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.publishConfig, { access: 'public' });
  assert.equal(pkg.repository.url, 'git+https://github.com/notiskin/notiskin.git', 'provenance needs the real repository');
  assert.equal(pkg.repository.directory, 'types');
  assert.equal(pkg.homepage, 'https://notiskin.github.io/plugins.html');
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'bin', 'main']) {
    assert.equal(pkg[field], undefined, field);
  }
  assert.equal(pkg.scripts.prepack, 'node ../scripts/pack-types.js');
  assert.deepEqual(Object.keys(pkg.scripts), ['prepack']);
});

test('the copies the pack script makes are not kept in git', () => {
  const ignored = fs.readFileSync(path.join(root, '.gitignore'), 'utf-8').split('\n');
  assert.ok(ignored.includes('types/notiskin.d.ts'));
  assert.ok(ignored.includes('types/LICENSE'));
});

test('the pack script refuses when the versions differ, and copies nothing', () => {
  const dir = copyOfRepo('mismatch');
  const pkgPath = path.join(dir, 'types', 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify({ ...pkg, version: '0.0.1' }, null, 2));
  const run = spawnSync(process.execPath, [path.join(dir, 'scripts', 'pack-types.js')], { encoding: 'utf-8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, new RegExp(`API version ${apiVersion.replace(/\./g, '\\.')} but types/package\\.json says 0\\.0\\.1`));
  assert.ok(!fs.existsSync(path.join(dir, 'types', 'notiskin.d.ts')));
  assert.ok(!fs.existsSync(path.join(dir, 'types', 'LICENSE')));
});

test('the pack script refuses a notiskin.d.ts with no version on its first line', () => {
  const dir = copyOfRepo('noversion');
  fs.writeFileSync(path.join(dir, 'notiskin.d.ts'), `// Type definitions\n${dtsText}`);
  const run = spawnSync(process.execPath, [path.join(dir, 'scripts', 'pack-types.js')], { encoding: 'utf-8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no "version X\.Y\.Z"/);
});

test('the tarball holds exactly the d.ts, README, LICENSE and package.json, the d.ts and LICENSE as at the root', () => {
  const inRepo = ['notiskin.d.ts', 'LICENSE'].map(file => fs.existsSync(path.join(root, 'types', file)));
  const { dir, result } = packOnce();
  assert.equal(result.name, '@notiskin/types');
  assert.equal(result.version, apiVersion);
  assert.deepEqual(result.files.map(f => f.path).sort(), ['LICENSE', 'README.md', 'notiskin.d.ts', 'package.json']);
  assert.equal(fs.readFileSync(path.join(dir, 'types', 'notiskin.d.ts'), 'utf-8'), dtsText);
  assert.equal(fs.readFileSync(path.join(dir, 'types', 'LICENSE'), 'utf-8'), fs.readFileSync(path.join(root, 'LICENSE'), 'utf-8'));
  // packing the copy left the repository's own types/ as it was
  assert.deepEqual(['notiskin.d.ts', 'LICENSE'].map(file => fs.existsSync(path.join(root, 'types', file))), inRepo);
});

// ---- installed into a plugin folder and type-checked like an editor would ----

const PLUGIN_OPTIONS = { allowJs: true, checkJs: true, noEmit: true, strict: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], target: ts.ScriptTarget.ES2022 };
const REFERENCE = '// @ts-check\n/// <reference types="@notiskin/types" />\n';
const GOOD = `
  notiskin.ready(() => {});
  const button = notiskin.addToolbarButton('Go', clicked => clicked.classList.add('x'));
  notiskin.removeToolbarButton(button);
  const title = notiskin.getPageTitle();
  if (title !== null) title.toUpperCase();
  notiskin.settings.onChange((key, value) => { key.length; value; });
  window.notiskin.version === '${apiVersion}';
`;
const WRONG = {
  'a method that is not there': 'notiskin.getTitle();',
  'a number for the label': 'notiskin.addToolbarButton(1, () => {});',
  'the title used without checking for null': 'notiskin.getPageTitle().trim();',
};

let pluginDir;
function installOnce() {
  if (pluginDir) return pluginDir;
  const { tarball } = packOnce();
  pluginDir = path.join(tmp, 'my-plugin');
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(path.join(pluginDir, 'package.json'), '{ "private": true }\n');
  npm(['install', '--no-save', '--ignore-scripts', tarball], pluginDir);
  assert.ok(fs.existsSync(path.join(pluginDir, 'node_modules', '@notiskin', 'types', 'notiskin.d.ts')));
  return pluginDir;
}

// type errors for each file, by file name, from a real program over files on disk
function diagnostics(files, options) {
  const program = ts.createProgram(files, options);
  return Object.fromEntries(files.map(file => [
    path.basename(file),
    ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
  ]));
}

function writePlugin(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('installed, the reference line from the README gives a plugin the notiskin types, under every module resolution', () => {
  const dir = installOnce();
  const good = writePlugin(dir, 'good.js', REFERENCE + GOOD);
  const wrong = Object.values(WRONG).map((line, i) => writePlugin(dir, `wrong-${i}.js`, REFERENCE + line + '\n'));
  for (const moduleResolution of [ts.ModuleResolutionKind.Node10, ts.ModuleResolutionKind.Bundler, ts.ModuleResolutionKind.NodeNext]) {
    const module = moduleResolution === ts.ModuleResolutionKind.NodeNext ? ts.ModuleKind.NodeNext
      : moduleResolution === ts.ModuleResolutionKind.Bundler ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS;
    const found = diagnostics([good, ...wrong], { ...PLUGIN_OPTIONS, module, moduleResolution, ignoreDeprecations: '6.0' });
    assert.deepEqual(found['good.js'], [], `no errors in the correct plugin (resolution ${moduleResolution})`);
    Object.keys(WRONG).forEach((what, i) => {
      assert.ok(found[`wrong-${i}.js`].length > 0, `${what} should be an error (resolution ${moduleResolution})`);
    });
  }
});

test('installed, a jsconfig.json with "types": ["@notiskin/types"] works too, and without either notiskin is unknown', () => {
  const dir = installOnce();
  const folder = path.join(dir, 'with-jsconfig');
  fs.mkdirSync(folder);
  writePlugin(folder, 'good.js', '// @ts-check\n' + GOOD);
  writePlugin(folder, 'wrong.js', '// @ts-check\n' + WRONG['a method that is not there'] + '\n');
  // the README's jsconfig, plus the libs a plugin runs with
  fs.writeFileSync(path.join(folder, 'jsconfig.json'), JSON.stringify({
    compilerOptions: { checkJs: true, types: ['@notiskin/types'], strict: true, lib: ['es2022', 'dom'], noEmit: true },
  }));
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(folder, 'jsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => assert.fail(String(d.messageText)) });
  assert.deepEqual(parsed.errors, []);
  const found = diagnostics(parsed.fileNames, parsed.options);
  assert.deepEqual(found['good.js'], []);
  assert.ok(found['wrong.js'].length > 0);

  // the package isn't named @types/..., so nothing picks it up by itself
  const bare = writePlugin(dir, 'bare.js', '// @ts-check\n' + GOOD);
  const alone = diagnostics([bare], { ...PLUGIN_OPTIONS, types: undefined });
  assert.ok(alone['bare.js'].some(message => message.includes("Cannot find name 'notiskin'")), alone['bare.js'].join('\n'));
});
