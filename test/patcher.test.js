// wrapper text, shell quoting, and status detection, all against temp folders that imitate Notion.app
const { dataDir, infoPlist, makeFramework, makeElectronFramework } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, readdirSync, statSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

// unpatch looks for a LaunchAgent in the home folder, keep it away from the real one
process.env.HOME = mkdtempSync(join(tmpdir(), 'notiskin-home-'));

const patcher = require('../dist/patcher/index');
const { readConfig, writeConfig } = require('../dist/utils/config');
const admin = require('../dist/patcher/admin');

const TRICKY = [
  'plain',
  '/Applications/My Apps/notiskin.app',
  "it's",
  'a "quoted" path',
  '$HOME and `whoami` and $(id)',
  "mixed ' \" $x \\ end",
];

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

// temp folder laid out like Notion.app/Contents/MacOS, the "real" Notion is a tiny shell script
function fakeNotionApp({ binary = '#!/bin/sh\necho real-notion\n' } = {}) {
  const app = join(tempDir('notiskin-notion-'), 'Notion.app');
  const macos = join(app, 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  executable(join(macos, 'Notion'), binary);
  // what tells an Electron Notion apart from a native one
  mkdirSync(join(app, 'Contents', 'Frameworks', 'Electron Framework.framework'), { recursive: true });
  return { app, macos, notion: join(macos, 'Notion'), real: join(macos, 'Notion.real') };
}

function withNotionApp(app, fn) {
  const before = process.env.NOTISKIN_NOTION_APP;
  process.env.NOTISKIN_NOTION_APP = app;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.NOTISKIN_NOTION_APP;
    else process.env.NOTISKIN_NOTION_APP = before;
  }
}

// what versions before the DevTools pipe wrote, they opened port 9222 to every program on the Mac
const LEGACY_CLI_WRAPPER =
  '#!/bin/sh\n' +
  '# notiskin-wrapper\n' +
  'mkdir -p "$HOME/.notiskin/logs"\n' +
  '"/usr/local/bin/node" "/Users/me/notiskin/dist/cli/index.js" inject >> "$HOME/.notiskin/logs/inject.log" 2>&1 &\n' +
  'exec "$(dirname "$0")/Notion.real" --remote-debugging-port=9222 "$@"\n';
const LEGACY_APP_WRAPPER =
  '#!/bin/sh\n' +
  '# notiskin-wrapper\n' +
  'mkdir -p "$HOME/.notiskin/logs"\n' +
  "ELECTRON_RUN_AS_NODE=1 '/Applications/notiskin.app/Contents/MacOS/notiskin' " +
  "'/Applications/notiskin.app/Contents/Resources/app.asar/dist/cli/index.js' " +
  'inject >> "$HOME/.notiskin/logs/inject.log" 2>&1 &\n' +
  'exec "$(dirname "$0")/Notion.real" --remote-debugging-port=9222 "$@"\n';

test('the wrapper never opens a debug port', () => {
  for (const appMode of [false, true]) {
    const script = patcher.makeWrapperScript('/usr/local/bin/node', '/Users/me/notiskin/dist/cli/index.js', { appMode });
    assert.ok(script.includes('# notiskin-wrapper'));
    assert.ok(!script.includes('--remote-debugging-port'));
    assert.ok(script.includes('--remote-debugging-pipe'));
    assert.ok(!patcher.isLegacyWrapper(script));
  }
  assert.ok(patcher.isLegacyWrapper(LEGACY_CLI_WRAPPER));
  assert.ok(patcher.isLegacyWrapper(LEGACY_APP_WRAPPER));
});

test('app wrapper runs the inject line as Node and quotes the paths', () => {
  const script = patcher.makeWrapperScript(
    '/Applications/notiskin.app/Contents/MacOS/notiskin',
    "/Applications/notiskin.app/Contents/Resources/app.asar/dist/cli/index.js",
    { appMode: true }
  );
  const lines = script.split('\n');
  // the archive is what exists on disk, sh can't look inside it
  assert.equal(
    lines[3],
    "if [ -x '/Applications/notiskin.app/Contents/MacOS/notiskin' ] && " +
      "[ -e '/Applications/notiskin.app/Contents/Resources/app.asar' ]; then"
  );
  assert.equal(
    lines[6],
    "    ELECTRON_RUN_AS_NODE=1 '/Applications/notiskin.app/Contents/MacOS/notiskin' " +
      "'/Applications/notiskin.app/Contents/Resources/app.asar/dist/cli/index.js' " +
      'inject "$run" 3<&- 4<&- >> "$HOME/.notiskin/logs/inject.log" 2>&1 &'
  );
  assert.equal(lines[7], '    exec "$real" --remote-debugging-pipe "$@"');
  assert.ok(patcher.wrapperInjectTarget(script));
});

test('shellQuote survives spaces, quotes, and $', () => {
  for (const value of TRICKY) {
    const echoed = execFileSync('sh', ['-c', `printf '%s' ${admin.shellQuote(value)}`], { encoding: 'utf-8' });
    assert.equal(echoed, value);
  }
});

test('wrapperInjectTarget reads back both wrapper styles', () => {
  for (const value of TRICKY) {
    for (const appMode of [false, true]) {
      const script = patcher.makeWrapperScript(`/bin/${value}`, `/cli/${value}.js`, { appMode });
      assert.deepEqual(patcher.wrapperInjectTarget(script), { program: `/bin/${value}`, cliScript: `/cli/${value}.js` });
    }
  }
  assert.equal(patcher.wrapperInjectTarget('#!/bin/sh\nexec something\n'), null);
  // old port wrappers aren't read as current ones, they need a repair
  assert.equal(patcher.wrapperInjectTarget(LEGACY_APP_WRAPPER), null);
});

// runs the generated wrapper with sh, Notion.real and the inject program are stand-ins that record what they got
// (their arguments, ELECTRON_RUN_AS_NODE, and whether fds 3 and 4 are pipes)
function runWrapper(appMode, { injectExists = true, expectInject = injectExists, home: homeSetup } = {}) {
  const { macos, notion, real } = fakeNotionApp();
  const home = tempDir("notiskin wrapper home's $x-");
  homeSetup?.(home);
  const out = tempDir('notiskin-wrapper-out-');
  const record = file =>
    '#!/bin/sh\n' +
    'fds=""; [ -p /dev/fd/3 ] && fds="$fds 3"; [ -p /dev/fd/4 ] && fds="$fds 4"\n' +
    `echo "\${ELECTRON_RUN_AS_NODE:-unset} $*|pipes:$fds" > ${admin.shellQuote(join(out, file))}\n`;
  executable(real, record('notion'));
  const injectDir = join(home, "inject dir's $HOME");
  const injector = join(injectDir, 'run');
  const cli = join(injectDir, 'index "1".js');
  if (injectExists) {
    mkdirSync(injectDir);
    executable(injector, record('inject'));
    writeFileSync(cli, '');
  }
  executable(notion, patcher.makeWrapperScript(injector, cli, { appMode }));
  execFileSync(notion, ['--flag'], { env: { PATH: process.env.PATH, HOME: home } });
  // the inject line runs in the background
  const deadline = Date.now() + 5000;
  while (expectInject && !existsSync(join(out, 'inject')) && Date.now() < deadline) execFileSync('sleep', ['0.05']);
  const runRoot = join(home, '.notiskin', 'run');
  const runs = existsSync(runRoot) ? readdirSync(runRoot).map(name => join(runRoot, name)) : [];
  return {
    notion: readFileSync(join(out, 'notion'), 'utf-8').trim(),
    inject: existsSync(join(out, 'inject')) ? readFileSync(join(out, 'inject'), 'utf-8').trim() : null,
    log: existsSync(join(home, '.notiskin', 'logs', 'inject.log')),
    runRoot,
    runs,
    cli,
    macos,
  };
}

const mode = path => (statSync(path).mode & 0o777).toString(8);

for (const appMode of [true, false]) {
  test(`${appMode ? 'app' : 'CLI'} wrapper gives Notion the pipe on fds 3 and 4 and starts the injector`, () => {
    const run = runWrapper(appMode);
    assert.equal(run.notion, 'unset --remote-debugging-pipe --flag|pipes: 3 4');
    // ELECTRON_RUN_AS_NODE reaches the injector only, and the injector doesn't hold Notion's pipes open
    assert.equal(run.runs.length, 1);
    assert.equal(run.inject, `${appMode ? '1' : 'unset'} ${run.cli} inject ${run.runs[0]}|pipes:`);
    assert.ok(run.log);
    // only this user can open the pipes
    assert.equal(mode(run.runRoot), '700');
    assert.equal(mode(run.runs[0]), '700');
    assert.ok(statSync(join(run.runs[0], 'in')).isFIFO());
    assert.equal(mode(join(run.runs[0], 'in')), '600');
    assert.equal(mode(join(run.runs[0], 'out')), '600');
  });
}

test('Notion still starts, with no pipe, when Notiskin was moved or deleted', () => {
  for (const appMode of [true, false]) {
    const run = runWrapper(appMode, { injectExists: false });
    assert.equal(run.notion, 'unset --flag|pipes:');
    assert.equal(run.inject, null);
    assert.equal(run.runs.length, 0);
  }
});

test("Notion still starts, with no pipe, when the pipe folder can't be made", () => {
  // ~/.notiskin is a file, so every mkdir fails
  const run = runWrapper(true, { expectInject: false, home: home => writeFileSync(join(home, '.notiskin'), '') });
  assert.equal(run.notion, 'unset --flag|pipes:');
  assert.equal(run.inject, null);
});

test('status: notion-missing when there is no Notion.app', () => {
  withNotionApp(join(tempDir('notiskin-empty-'), 'Notion.app'), () => {
    assert.equal(patcher.getNotionStatus(), 'notion-missing');
  });
});

test('status: not-installed, installed, and needs-repair', () => {
  const { app, notion, real } = fakeNotionApp({ binary: 'x'.repeat(4096) });
  const tools = tempDir('notiskin-tools-');
  const program = join(tools, 'notiskin');
  const cli = join(tools, 'index.js');
  writeFileSync(program, '');
  writeFileSync(cli, '');

  withNotionApp(app, () => {
    assert.equal(patcher.getNotionStatus(), 'not-installed');

    writeFileSync(real, 'x'.repeat(4096));
    writeFileSync(notion, patcher.makeWrapperScript(program, cli, { appMode: true }));
    assert.equal(patcher.getNotionStatus(), 'installed');

    writeFileSync(notion, patcher.makeWrapperScript(program, cli));
    assert.equal(patcher.getNotionStatus(), 'installed');
    assert.equal(patcher.hasLegacyWrapper(), false);

    // wrappers from before the pipe opened a debug port, they need a repair
    for (const legacy of [LEGACY_CLI_WRAPPER, LEGACY_APP_WRAPPER]) {
      writeFileSync(notion, legacy);
      assert.equal(patcher.getNotionStatus(), 'needs-repair');
      assert.equal(patcher.hasLegacyWrapper(), true);
    }
    writeFileSync(notion, patcher.makeWrapperScript(program, cli));

    // Notiskin moved or deleted
    rmSync(cli);
    assert.equal(patcher.getNotionStatus(), 'needs-repair');
    writeFileSync(cli, '');

    // a Notion update put a fresh binary where the wrapper was
    writeFileSync(notion, 'x'.repeat(4096));
    assert.equal(patcher.getNotionStatus(), 'needs-repair');
  });
});

test('a Notion without Electron is unsupported and patch leaves it alone', () => {
  const original = 'x'.repeat(4096);
  const { app, notion, real } = fakeNotionApp({ binary: original });
  rmSync(join(app, 'Contents', 'Frameworks'), { recursive: true });
  withNotionApp(app, () => {
    assert.equal(patcher.getNotionStatus(), 'unsupported');
    assert.throws(() => patcher.patchNotion('/usr/local/bin/node', '/x/index.js'), { message: patcher.UNSUPPORTED_MESSAGE });
    assert.equal(readFileSync(notion, 'utf-8'), original);
    assert.ok(!existsSync(real));
  });
});

test('status: a CLI inside app.asar counts as present when the archive exists', () => {
  const { app, notion, real } = fakeNotionApp();
  const resources = tempDir('notiskin-resources-');
  const program = join(resources, 'notiskin');
  writeFileSync(program, '');
  writeFileSync(join(resources, 'app.asar'), '');
  writeFileSync(real, '');
  writeFileSync(notion, patcher.makeWrapperScript(program, join(resources, 'app.asar', 'dist', 'cli', 'index.js'), { appMode: true }));
  withNotionApp(app, () => assert.equal(patcher.getNotionStatus(), 'installed'));
  rmSync(join(resources, 'app.asar'));
  withNotionApp(app, () => assert.equal(patcher.getNotionStatus(), 'needs-repair'));
});

// as root, patch would try to install a sudoers rule, only run this as a normal user
const rootSkip = process.getuid?.() === 0 && 'patching as root would touch /etc/sudoers.d';

test('patch, repair a stale wrapper, and unpatch a temp Notion.app', { skip: rootSkip }, () => {
  const original = 'x'.repeat(4096);
  const { app, notion, real } = fakeNotionApp({ binary: original });
  const tools = tempDir('notiskin-tools-');
  const program = join(tools, 'notiskin');
  writeFileSync(program, '');
  writeFileSync(join(tools, 'index.js'), '');
  const silence = ['log', 'warn'].map(k => [k, console[k]]);
  for (const [k] of silence) console[k] = () => {};
  try {
    withNotionApp(app, () => {
      patcher.patchNotion(program, join(tools, 'index.js'), { appMode: true });
      assert.equal(patcher.getNotionStatus(), 'installed');
      assert.equal(readFileSync(real, 'utf-8'), original);
      assert.equal(readFileSync(join(dataDir, 'backup', 'Notion.original'), 'utf-8'), original);

      // pointing at a CLI that no longer exists, patching again rewrites just the wrapper
      writeFileSync(notion, patcher.makeWrapperScript(program, join(tools, 'gone.js'), { appMode: true }));
      assert.equal(patcher.getNotionStatus(), 'needs-repair');
      patcher.patchNotion(program, join(tools, 'index.js'), { appMode: true });
      assert.equal(patcher.getNotionStatus(), 'installed');
      assert.equal(readFileSync(real, 'utf-8'), original);

      // an old port wrapper is replaced the same way
      writeFileSync(notion, LEGACY_APP_WRAPPER);
      patcher.patchNotion(program, join(tools, 'index.js'), { appMode: true });
      assert.equal(patcher.getNotionStatus(), 'installed');
      assert.ok(!readFileSync(notion, 'utf-8').includes('--remote-debugging-port'));
      assert.equal(readFileSync(real, 'utf-8'), original);

      // Notion's updater swaps in a whole new Notion.app: no wrapper and no Notion.real, but it still needs a repair
      rmSync(real);
      writeFileSync(notion, original);
      assert.equal(patcher.getNotionStatus(), 'needs-repair');
      patcher.patchNotion(program, join(tools, 'index.js'), { appMode: true });
      assert.equal(patcher.getNotionStatus(), 'installed');

      patcher.unpatchNotion();
      assert.equal(patcher.getNotionStatus(), 'not-installed');
      assert.equal(readFileSync(notion, 'utf-8'), original);
      assert.ok(!existsSync(real));
    });
  } finally {
    for (const [k, fn] of silence) console[k] = fn;
  }
});

function codesign(...args) {
  return execFileSync('codesign', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// codesign -dv writes to stderr
function signatureInfo(path) {
  return execFileSync('sh', ['-c', 'codesign -dvvv "$1" 2>&1', 'sh', path], { encoding: 'utf-8' });
}

function designated(path) {
  // a script app also lists a host requirement, only the designated one matters
  return codesign('-d', '-r-', path).match(/^(?:# )?designated => (.*)$/m)[1];
}

function meets(path, requirement) {
  try {
    codesign('--verify', `-R=${requirement}`, path);
    return true;
  } catch {
    return false;
  }
}

// a signed Notion.app look-alike: a real program as Notion, and a real Electron Framework.framework inside signed on
// its own, standing in for Notion's frameworks and helpers. Notion itself is never used
function signedNotionApp(program) {
  const { app, macos, notion, real } = fakeNotionApp();
  writeFileSync(join(app, 'Contents', 'Info.plist'), infoPlist('notion.id', 'Notion'));
  execFileSync('cp', [program, notion]);
  const frameworks = join(app, 'Contents', 'Frameworks');
  rmSync(frameworks, { recursive: true });
  const framework = makeElectronFramework(frameworks);
  codesign('--force', '--sign', '-', app);
  return { app, macos, notion, real, framework };
}

const signSkip = rootSkip || (process.platform !== 'darwin' && 'needs macOS codesign');

test('the patched Notion still accepts Notion-signed updates, and meets its own requirement', { skip: signSkip }, t => {
  // a tiny real program, the patched Notion has to be something macOS will actually run
  const build = tempDir('notiskin-cc-');
  const program = join(build, 'notion');
  try {
    execFileSync('cc', ['-x', 'c', '-o', program, '-'], { input: 'int main(void) { return 0; }\n', stdio: ['pipe', 'ignore', 'ignore'] });
  } catch {
    return t.skip('no C compiler');
  }
  const { app, notion, real, framework } = signedNotionApp(program);
  const frameworkBefore = signatureInfo(framework).match(/CDHash=\w+/)[0];
  const silence = ['log', 'warn'].map(k => [k, console[k]]);
  for (const [k] of silence) console[k] = () => {};
  try {
    withNotionApp(app, () => {
      // the plain ad hoc signing older versions did, which made Notion refuse every update
      codesign('--force', '--deep', '--sign', '-', app);
      assert.match(designated(app), /^cdhash /);

      patcher.patchNotion(join(build, 'gone'), join(build, 'gone.js'));
      assert.equal(patcher.getNotionStatus(), 'needs-repair'); // the made-up CLI paths don't exist
      for (const path of [real, app]) {
        const requirement = designated(path);
        // a real Notion update is signed by Notion's team and passes the first half
        assert.ok(requirement.includes('certificate leaf[subject.OU] = LBQJ96FQ8D'), requirement);
        assert.ok(requirement.includes('identifier "notion.id"'), requirement);
        // the keychain and privacy permissions need the patched Notion to meet its own requirement
        assert.ok(meets(path, requirement), `${path} meets its own requirement`);
      }
      assert.doesNotThrow(() => codesign('--verify', '--deep', '--strict', app));
      assert.equal(patcher.hasOldSignature(), false);

      // an update that isn't Notion's (plain ad hoc) is still turned away
      const other = signedNotionApp(program);
      assert.ok(!meets(other.app, designated(real)));

      // the wrapper starts the re-signed program, and the framework inside was left alone
      execFileSync(notion, [], { stdio: 'ignore' });
      assert.equal(signatureInfo(framework).match(/CDHash=\w+/)[0], frameworkBefore);

      // an install signed the old way gets re-signed by the next patch, the wrapper itself unchanged
      codesign('--force', '--deep', '--sign', '-', app);
      assert.equal(patcher.hasOldSignature(), true);
      const wrapper = readFileSync(notion, 'utf-8');
      patcher.patchNotion(join(build, 'gone'), join(build, 'gone.js'));
      assert.equal(readFileSync(notion, 'utf-8'), wrapper);
      assert.equal(patcher.hasOldSignature(), false);

      // on by default: the Notion half also asks for an Electron app. Turning it off re-signs without it
      assert.ok(designated(real).includes('info[NSPrincipalClass] = AtomApplication'));
      writeConfig({ ...readConfig(), blockNativeNotion: false });
      assert.equal(patcher.hasOldSignature(), true, 'a changed setting counts as an old signature');
      assert.equal(patcher.resignNotion(), 'signed');
      assert.ok(!designated(real).includes('AtomApplication'));
      assert.ok(meets(real, designated(real)));
      assert.equal(patcher.hasOldSignature(), false);
      writeConfig({ ...readConfig(), blockNativeNotion: true });
      assert.equal(patcher.resignNotion(), 'signed');
      assert.ok(designated(real).includes('AtomApplication'));

      // uninstalling holds nothing back, Notion installs every update afterwards
      patcher.unpatchNotion();
      assert.ok(!designated(app).includes('AtomApplication'));
      assert.equal(patcher.resignNotion(), 'not-patched');
      assert.ok(designated(app).includes('certificate leaf[subject.OU] = LBQJ96FQ8D'));
      assert.ok(meets(app, designated(app)));
      assert.doesNotThrow(() => codesign('--verify', '--deep', '--strict', app));
      execFileSync(notion, [], { stdio: 'ignore' });
    });
  } finally {
    for (const [k, fn] of silence) console[k] = fn;
  }
});

// an update can't be signed by Notion here, so swap Notion's half for one ad hoc test apps can meet and check the
// Electron part on its own: an app without Electron's principal class is refused while the switch is on
test('the hold-back requirement refuses an app that is not Electron', { skip: signSkip }, () => {
  const testable = on => patcher.signingRequirement(on).replace(patcher.NOTION_REQUIREMENT, 'identifier "notion.id"').replace(/^designated => /, '');
  const appWith = principal => {
    const { app } = fakeNotionApp();
    rmSync(join(app, 'Contents', 'Frameworks'), { recursive: true });
    const plist = infoPlist('notion.id', 'Notion').replace('</dict>', principal ? `<key>NSPrincipalClass</key><string>${principal}</string></dict>` : '</dict>');
    writeFileSync(join(app, 'Contents', 'Info.plist'), plist);
    codesign('--force', '--sign', '-', app);
    return app;
  };
  const electron = appWith('AtomApplication');
  const native = appWith('NSApplication');
  assert.ok(meets(electron, testable(true)));
  assert.ok(!meets(native, testable(true)));
  assert.ok(meets(native, testable(false)));
});

// older versions signed Notion with --deep, which skipped ShipIt (Notion's installer), so it kept Notion's team and
// couldn't load the ad hoc Mantle next to it: updates were accepted and never installed. Node's own binary is
// Developer ID signed, so a copy of it plays a ShipIt that still has a team
test('ShipIt is signed to match the libraries next to it', { skip: signSkip }, t => {
  if (!/TeamIdentifier=(?!not set)/.test(signatureInfo(process.execPath))) {
    return t.skip('this Node binary has no team signature');
  }
  const build = tempDir('notiskin-cc-');
  const program = join(build, 'notion');
  try {
    execFileSync('cc', ['-x', 'c', '-o', program, '-'], { input: 'int main(void) { return 0; }\n', stdio: ['pipe', 'ignore', 'ignore'] });
  } catch {
    return t.skip('no C compiler');
  }
  const { app, notion } = signedNotionApp(program);
  const frameworks = join(app, 'Contents', 'Frameworks');
  makeFramework(frameworks, 'Mantle');
  const squirrel = makeFramework(frameworks, 'Squirrel', { ShipIt: process.execPath });
  const shipIt = join(squirrel, 'Versions', 'A', 'Resources', 'ShipIt');
  codesign('--force', '--sign', '-', app);
  assert.match(signatureInfo(shipIt), /TeamIdentifier=(?!not set)/);
  const silence = ['log', 'warn'].map(k => [k, console[k]]);
  for (const [k] of silence) console[k] = () => {};
  try {
    withNotionApp(app, () => {
      assert.equal(patcher.shipItMismatch(notion), true);
      assert.equal(patcher.hasCurrentSignature(notion), false, 'a ShipIt that cannot start counts as an old signature');

      patcher.patchNotion(join(build, 'gone'), join(build, 'gone.js'));
      assert.equal(patcher.shipItMismatch(notion), false);
      assert.match(signatureInfo(shipIt), /TeamIdentifier=not set/);
      assert.doesNotThrow(() => codesign('--verify', '--deep', '--strict', app));
      assert.equal(patcher.hasOldSignature(), false);
    });
  } finally {
    for (const [k, fn] of silence) console[k] = fn;
  }
});

test('admin command passes the real user and runs the CLI as Node', () => {
  const dir = tempDir("notiskin admin's $dir-");
  const exec = join(dir, 'fake "exec" $(id)');
  executable(exec, '#!/bin/sh\nprintf \'%s|\' "$SUDO_USER" "$ELECTRON_RUN_AS_NODE" "$@"\n');
  for (const cliPath of TRICKY) {
    const command = admin.buildAdminCommand('patch', { user: 'remi', execPath: exec, cliPath });
    const out = execFileSync('sh', ['-c', command], { encoding: 'utf-8', env: { PATH: process.env.PATH } });
    assert.equal(out, `remi|1|${cliPath}|patch|`);
  }
});

test('admin command refuses odd user names', () => {
  for (const user of ['', 'a b', "x'y", 'root ALL=(ALL) ALL', 'a\nb', '-rf']) {
    assert.throws(() => admin.buildAdminCommand('patch', { user, execPath: '/x', cliPath: '/y' }), user);
  }
});

test('osascript gets the command and prompt as arguments, not AppleScript source', () => {
  const args = admin.osascriptArgs("evil\" & do shell script \"rm -rf ~\" & \"", 'prompt "text"');
  assert.deepEqual(args.slice(0, 6), [
    '-e', 'on run argv',
    '-e', 'do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges',
    '-e', 'end run',
  ]);
  assert.equal(args[6], "evil\" & do shell script \"rm -rf ~\" & \"");
  assert.equal(args[7], 'prompt "text"');
});

test('a cancelled password dialog is recognised', () => {
  assert.ok(admin.isCancelled('0:180: execution error: User canceled. (-128)\n'));
  assert.ok(!admin.isCancelled('0:180: execution error: Error: Permission denied. (1)\n'));
});

test('errors from the CLI come back in plain words', () => {
  assert.equal(
    admin.errorFromOutput('0:180: execution error: [patcher] Backing up\r\rError: Could not find Notion.app. (1)\n'),
    'Could not find Notion.app.'
  );
  assert.equal(admin.errorFromOutput('0:1: execution error: something odd (1)'), 'something odd');
});

test('the server runs the real CLI as the user to install and uninstall', { skip: rootSkip }, async () => {
  const { notionSetup, setupFailureReason } = require('../dist/gui/server');
  const original = 'x'.repeat(4096);
  const { app, macos, notion } = fakeNotionApp({ binary: original });
  process.env.NOTISKIN_NOTION_APP = app;
  try {
    const install = await notionSetup.run('patch');
    assert.equal(install.status, 'ok', install.output);
    assert.equal(patcher.getNotionStatus(), 'installed');

    const uninstall = await notionSetup.run('unpatch');
    assert.equal(uninstall.status, 'ok', uninstall.output);
    assert.equal(patcher.getNotionStatus(), 'not-installed');
    assert.equal(readFileSync(notion, 'utf-8'), original);

    // a Notion.app the user can't write to, like one owned by another account
    chmodSync(macos, 0o555);
    const refused = await notionSetup.run('patch');
    assert.equal(refused.status, 'error');
    assert.equal(setupFailureReason(refused.output), 'not-owner');
    assert.equal(readFileSync(notion, 'utf-8'), original);
  } finally {
    chmodSync(macos, 0o755);
    delete process.env.NOTISKIN_NOTION_APP;
  }
});
