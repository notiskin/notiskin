// wrapper text, shell quoting, and status detection, all against temp folders that imitate Notion.app
const { dataDir } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } = require('fs');
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

test('CLI wrapper is byte-for-byte what earlier versions wrote', () => {
  assert.equal(
    patcher.makeWrapperScript('/usr/local/bin/node', '/Users/me/notiskin/dist/cli/index.js'),
    '#!/bin/sh\n' +
      '# notiskin-wrapper\n' +
      'mkdir -p "$HOME/.notiskin/logs"\n' +
      '"/usr/local/bin/node" "/Users/me/notiskin/dist/cli/index.js" inject >> "$HOME/.notiskin/logs/inject.log" 2>&1 &\n' +
      'exec "$(dirname "$0")/Notion.real" --remote-debugging-port=9222 "$@"\n'
  );
});

test('app wrapper runs the inject line as Node and quotes the paths', () => {
  const script = patcher.makeWrapperScript(
    '/Applications/notiskin.app/Contents/MacOS/notiskin',
    "/Applications/notiskin.app/Contents/Resources/app.asar/dist/cli/index.js",
    { appMode: true }
  );
  const lines = script.split('\n');
  assert.equal(
    lines[3],
    "ELECTRON_RUN_AS_NODE=1 '/Applications/notiskin.app/Contents/MacOS/notiskin' " +
      "'/Applications/notiskin.app/Contents/Resources/app.asar/dist/cli/index.js' " +
      'inject >> "$HOME/.notiskin/logs/inject.log" 2>&1 &'
  );
  assert.equal(lines[4], 'exec "$(dirname "$0")/Notion.real" --remote-debugging-port=9222 "$@"');
  assert.ok(patcher.wrapperInjectTarget(script));
});

test('shellQuote survives spaces, quotes, and $', () => {
  for (const value of TRICKY) {
    const echoed = execFileSync('sh', ['-c', `printf '%s' ${admin.shellQuote(value)}`], { encoding: 'utf-8' });
    assert.equal(echoed, value);
  }
});

test('wrapperInjectTarget reads back both wrapper styles', () => {
  for (const value of TRICKY.filter(v => !v.includes('"'))) {
    const cli = patcher.makeWrapperScript(`/bin/${value}`, `/cli/${value}.js`);
    assert.deepEqual(patcher.wrapperInjectTarget(cli), { program: `/bin/${value}`, cliScript: `/cli/${value}.js` });
  }
  for (const value of TRICKY) {
    const app = patcher.makeWrapperScript(`/bin/${value}`, `/cli/${value}.js`, { appMode: true });
    assert.deepEqual(patcher.wrapperInjectTarget(app), { program: `/bin/${value}`, cliScript: `/cli/${value}.js` });
  }
  assert.equal(patcher.wrapperInjectTarget('#!/bin/sh\nexec something\n'), null);
});

// runs the generated wrapper with sh, Notion.real and the inject program are stand-ins that record what they got
function runWrapper(appMode, { injectExists = true } = {}) {
  const { macos, notion, real } = fakeNotionApp();
  const home = tempDir("notiskin wrapper home's $x-");
  const out = join(home, 'out');
  mkdirSync(out);
  const record = file => `#!/bin/sh\necho "\${ELECTRON_RUN_AS_NODE:-unset} $*" > ${admin.shellQuote(join(out, file))}\n`;
  executable(real, record('notion'));
  // the CLI wrapper never handled $ or " in paths (kept as is), the app wrapper does
  const injectDir = appMode ? join(home, "inject dir's $HOME") : join(tempDir('notiskin-inject-'), 'inject dir');
  const injector = join(injectDir, 'run');
  if (injectExists) {
    mkdirSync(injectDir);
    executable(injector, record('inject'));
  }
  executable(notion, patcher.makeWrapperScript(injector, '/cli/index.js', { appMode }));
  execFileSync(notion, ['--flag'], { env: { PATH: process.env.PATH, HOME: home } });
  // the inject line runs in the background
  const deadline = Date.now() + 5000;
  while (injectExists && !existsSync(join(out, 'inject')) && Date.now() < deadline) execFileSync('sleep', ['0.05']);
  return {
    notion: readFileSync(join(out, 'notion'), 'utf-8').trim(),
    inject: injectExists ? readFileSync(join(out, 'inject'), 'utf-8').trim() : null,
    log: existsSync(join(home, '.notiskin', 'logs', 'inject.log')),
    macos,
  };
}

test('app wrapper gives ELECTRON_RUN_AS_NODE to the injector only, never to Notion', () => {
  const run = runWrapper(true);
  assert.equal(run.inject, '1 /cli/index.js inject');
  assert.equal(run.notion, 'unset --remote-debugging-port=9222 --flag');
  assert.ok(run.log);
});

test('CLI wrapper still starts Notion and the injector', () => {
  const run = runWrapper(false);
  assert.equal(run.inject, 'unset /cli/index.js inject');
  assert.equal(run.notion, 'unset --remote-debugging-port=9222 --flag');
});

test('Notion still starts when Notiskin was moved or deleted', () => {
  assert.equal(runWrapper(true, { injectExists: false }).notion, 'unset --remote-debugging-port=9222 --flag');
  assert.equal(runWrapper(false, { injectExists: false }).notion, 'unset --remote-debugging-port=9222 --flag');
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

    // CLI-style wrappers from earlier versions count too
    writeFileSync(notion, patcher.makeWrapperScript(program, cli));
    assert.equal(patcher.getNotionStatus(), 'installed');

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
