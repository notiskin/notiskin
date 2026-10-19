// patches a copy of the fake Notion in a temp folder, launches it through the wrapper, then unpatches it
// never touches /Applications or the real Notion
require('../helpers');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const net = require('net');
const http = require('http');

// unpatch looks for a LaunchAgent in the home folder, keep it away from the real one
const home = mkdtempSync(join(tmpdir(), 'notiskin-home-'));
process.env.HOME = home;
const root = mkdtempSync(join(tmpdir(), 'notiskin-patch-'));
const notionApp = join(root, 'Notion.app');
process.env.NOTISKIN_NOTION_APP = notionApp;

const patcher = require('../../dist/patcher/index');

let electronPath = null;
try { electronPath = require('electron'); } catch {}

// the wrapper always uses port 9222, so a running real Notion would answer instead of the fake one
const WRAPPER_PORT = 9222;

function portInUse(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(false)));
  });
}

function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
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

let fake;

after(() => {
  fake?.kill();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('install, launch through the wrapper, and uninstall a fake Notion', async t => {
  if (process.platform !== 'darwin') return t.skip('needs macOS');
  if (!electronPath) return t.skip('Electron binary not installed');
  if (await portInUse(WRAPPER_PORT)) return t.skip(`port ${WRAPPER_PORT} is in use (is the real Notion running?)`);

  // Notion.app/Contents/MacOS/Notion starts the fake Notion, it plays the part of the real binary
  const macos = join(notionApp, 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  const notion = join(macos, 'Notion');
  const fakeMain = join(__dirname, '..', 'fixtures', 'fake-notion', 'main.js');
  const original = `#!/bin/sh\nexec '${electronPath}' '${fakeMain}' "$@"\n`;
  writeFileSync(notion, original);
  chmodSync(notion, 0o755);

  // stands in for the CLI's inject command, proves the wrapper ran it without starting a real injector
  const tools = join(root, 'Notiskin tools');
  mkdirSync(tools);
  const marker = join(root, 'inject-ran');
  const stubCli = join(tools, 'inject.js');
  writeFileSync(
    stubCli,
    `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + ' ' + process.env.ELECTRON_RUN_AS_NODE)\n`
  );

  assert.equal(patcher.getNotionStatus(), 'not-installed');
  patcher.patchNotion(process.execPath, stubCli, { appMode: true });
  assert.equal(patcher.getNotionStatus(), 'installed');

  // if ELECTRON_RUN_AS_NODE leaked into Notion.real, the fake would start as plain Node and never open the port
  fake = spawn(notion, [], {
    env: {
      ...process.env,
      CDP_PORT: String(WRAPPER_PORT),
      PAGE_PORT: String(await freePort()),
      USER_DATA: mkdtempSync(join(root, 'userdata-')),
    },
    stdio: 'ignore',
  });
  await patcher.waitForCDP(WRAPPER_PORT);
  // the debug port opens before the fake Notion's page has loaded, so wait for its title to show up
  await waitFor(
    async () => (await getJson(`http://127.0.0.1:${WRAPPER_PORT}/json/list`)).some(t => t.title === 'fake notion'),
    'the fake Notion page on the debug port'
  );
  await waitFor(() => existsSync(marker), 'the inject line');
  assert.equal(readFileSync(marker, 'utf-8'), 'inject 1');
  assert.ok(existsSync(join(home, '.notiskin', 'logs')), 'logs go to the home folder the wrapper was given');

  fake.kill();
  await waitFor(async () => !(await portInUse(WRAPPER_PORT)), 'the fake Notion to quit', 15_000);
  fake = null;

  patcher.unpatchNotion();
  assert.equal(patcher.getNotionStatus(), 'not-installed');
  assert.ok(readFileSync(notion).equals(Buffer.from(original)), 'the original binary is back byte-for-byte');
  assert.ok(!existsSync(`${notion}.real`));
});
