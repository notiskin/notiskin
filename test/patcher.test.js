// wrapper text, shell quoting, and status detection, all against temp folders that imitate Notion.app
const { dataDir } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, readdirSync, statSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

// unpatch looks for a LaunchAgent in the home folder, keep it away from the real one
process.env.HOME = mkdtempSync(join(tmpdir(), 'notiskin-home-'));

const patcher = require('../dist/patcher/index');
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

      patcher.unpatchNotion();
      assert.equal(patcher.getNotionStatus(), 'not-installed');
      assert.equal(readFileSync(notion, 'utf-8'), original);
      assert.ok(!existsSync(real));
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
