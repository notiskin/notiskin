// patches a copy of the fake Notion in a temp folder, launches it through the wrapper, then unpatches it
// never touches /Applications or the real Notion
require('../helpers');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const net = require('net');

// unpatch looks for a LaunchAgent in the home folder, keep it away from the real one
const home = mkdtempSync(join(tmpdir(), 'notiskin-home-'));
process.env.HOME = home;
const root = mkdtempSync(join(tmpdir(), 'notiskin-patch-'));
const notionApp = join(root, 'Notion.app');
process.env.NOTISKIN_NOTION_APP = notionApp;

const patcher = require('../../dist/patcher/index');

let electronPath = null;
try { electronPath = require('electron'); } catch {}

function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const args = pid => execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf-8' });

function tcpListeners(pid) {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-nP'], { encoding: 'utf-8' });
    return out.split('\n').slice(1).filter(Boolean).map(line => line.match(/:(\d+) \(LISTEN\)/)?.[1]);
  } catch {
    return [];
  }
}

let fake;

after(() => {
  fake?.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function launch(pagePort) {
  return spawn(join(notionApp, 'Contents', 'MacOS', 'Notion'), [], {
    env: {
      ...process.env,
      PAGE_PORT: String(pagePort),
      USER_DATA: mkdtempSync(join(root, 'userdata-')),
    },
    stdio: 'ignore',
  });
}

test('install, launch through the wrapper, and uninstall a fake Notion', async t => {
  if (process.platform !== 'darwin') return t.skip('needs macOS');
  if (!electronPath) return t.skip('Electron binary not installed');

  // Notion.app/Contents/MacOS/Notion starts the fake Notion, it plays the part of the real binary
  const macos = join(notionApp, 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  const notion = join(macos, 'Notion');
  const fakeMain = join(__dirname, '..', 'fixtures', 'fake-notion', 'main.js');
  const original = `#!/bin/sh\nexec '${electronPath}' '${fakeMain}' "$@"\n`;
  writeFileSync(notion, original);
  chmodSync(notion, 0o755);

  // stands in for the CLI's inject command: talks to Notion over the pipe it was given, then exits
  const tools = join(root, 'Notiskin tools');
  mkdirSync(tools);
  const marker = join(root, 'inject-ran');
  const stubCli = join(tools, 'inject.js');
  writeFileSync(
    stubCli,
    `const { PipeConnection, runPid } = require(${JSON.stringify(join(__dirname, '..', '..', 'dist', 'injector', 'pipe'))});
const dir = process.argv[3];
PipeConnection.open({ dir, pid: runPid(dir) }).then(async cdp => {
  const { product } = await cdp.send('Browser.getVersion');
  require('fs').writeFileSync(${JSON.stringify(marker)}, [process.argv[2], dir, process.env.ELECTRON_RUN_AS_NODE, product].join('|'));
  await cdp.close();
});
`
  );

  assert.equal(patcher.getNotionStatus(), 'not-installed');
  patcher.patchNotion(process.execPath, stubCli, { appMode: true });
  assert.equal(patcher.getNotionStatus(), 'installed');

  // if ELECTRON_RUN_AS_NODE leaked into Notion.real, the fake would start as plain Node and never answer
  const pagePort = await freePort();
  fake = launch(pagePort);
  await waitFor(() => existsSync(marker), 'the injector to reach Notion over the pipe');
  const [command, runDir, runAsNode, product] = readFileSync(marker, 'utf-8').split('|');
  assert.equal(command, 'inject');
  assert.equal(runDir, join(home, '.notiskin', 'run', String(fake.pid)), 'the pipe folder is named after Notion');
  assert.equal(runAsNode, '1');
  assert.match(product, /^Chrome\//);
  assert.ok(existsSync(join(home, '.notiskin', 'logs')), 'logs go to the home folder the wrapper was given');
  assert.match(args(fake.pid), /--remote-debugging-pipe/);
  assert.doesNotMatch(args(fake.pid), /--remote-debugging-port/);

  // the injector has exited, Notion carries on, and the only port open is the fake page's own
  await new Promise(r => setTimeout(r, 1500));
  assert.ok(alive(fake.pid), 'Notion keeps running after the injector is gone');
  assert.deepEqual(tcpListeners(fake.pid), [String(pagePort)]);

  fake.kill();
  await waitFor(() => !alive(fake.pid), 'the fake Notion to quit', 15_000);

  // Notiskin deleted: Notion still starts, with no pipe and no debugging at all
  rmSync(tools, { recursive: true });
  assert.equal(patcher.getNotionStatus(), 'needs-repair');
  const port2 = await freePort();
  fake = launch(port2);
  await waitFor(() => tcpListeners(fake.pid).includes(String(port2)), 'the fake Notion to start without Notiskin');
  assert.doesNotMatch(args(fake.pid), /--remote-debugging/);
  assert.ok(!existsSync(join(home, '.notiskin', 'run', String(fake.pid))));
  fake.kill();
  await waitFor(() => !alive(fake.pid), 'the fake Notion to quit', 15_000);
  fake = null;

  patcher.unpatchNotion();
  assert.equal(patcher.getNotionStatus(), 'not-installed');
  assert.ok(readFileSync(notion).equals(Buffer.from(original)), 'the original binary is back byte-for-byte');
  assert.ok(!existsSync(`${notion}.real`));
});
