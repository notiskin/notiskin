// drives the long-running injector against a fake Notion (an Electron app), never the real one
const { dataDir } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { mkdtempSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const net = require('net');
const CDP = require('chrome-remote-interface');
const lib = require('../../dist/core/library');
const { readConfig, writeConfig } = require('../../dist/utils/config');
const { startInjectorDaemon } = require('../../dist/injector/daemon');

let electronPath = null;
try { electronPath = require('electron'); } catch {}

const skip = !electronPath && 'Electron binary not installed';

function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

let cdpPort;
let pagePort;
let fake;
let daemon;
let userData;
const logs = [];

async function pages() {
  const targets = await CDP.List({ port: cdpPort });
  return targets.filter(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${pagePort}`));
}

async function evalIn(target, expression) {
  const client = await CDP({ target: target.id, port: cdpPort, local: true });
  try {
    const { result } = await client.send('Runtime.evaluate', { expression, returnByValue: true });
    return result.value;
  } finally {
    await client.close();
  }
}

const pageState = target =>
  evalIn(
    target,
    `({
      theme: document.getElementById('notiskin-styles')?.textContent ?? null,
      core: !!document.getElementById('notiskin-core-styles'),
      api: typeof window.notiskin,
      runs: window.__pluginRuns ?? 0,
      marker: window.__beforeReload ?? null,
      styledAtStart: window.__styledAtStart,
    })`
  );

before(async () => {
  if (skip) return;
  cdpPort = await freePort();
  pagePort = await freePort();
  userData = mkdtempSync(join(tmpdir(), 'notiskin-fake-notion-'));

  lib.writeItem('theme', 'Test', ':root { --ns-bg: #123456; }');
  lib.writeItem('plugin', 'counter', 'window.__pluginRuns = (window.__pluginRuns || 0) + 1;');
  writeConfig({ activeTheme: 'Test', enabledPlugins: ['counter'], acknowledgedPlugins: ['counter'] });

  fake = spawn(electronPath, [join(__dirname, '..', 'fixtures', 'fake-notion', 'main.js')], {
    env: { ...process.env, CDP_PORT: String(cdpPort), PAGE_PORT: String(pagePort), USER_DATA: userData },
    stdio: 'ignore',
  });

  daemon = await startInjectorDaemon({
    port: cdpPort,
    isTargetUrl: url => url.startsWith(`http://127.0.0.1:${pagePort}`),
    loadPayload: () => {
      const config = readConfig();
      return { css: lib.activeThemeCss(config), plugins: lib.loadEnabledPlugins(config) };
    },
    watchPaths: [dataDir, join(dataDir, 'themes'), join(dataDir, 'plugins')],
    log: msg => logs.push(msg),
  });
});

after(async () => {
  if (skip) return;
  await daemon?.stop();
  fake?.kill();
  rmSync(userData, { recursive: true, force: true });
});

test('themes the page and runs plugins once', { skip }, async () => {
  const [page] = await waitFor(async () => (await pages()).length === 1 && pages(), 'first page');
  const state = await waitFor(async () => {
    const s = await pageState(page);
    return s.theme && s.runs === 1 && s;
  }, 'first injection');
  assert.match(state.theme, /#123456/);
  assert.equal(state.core, true);
  assert.equal(state.api, 'object');
});

test('re-applying does not run plugins twice', { skip }, async () => {
  await daemon.reapplyAll();
  const [page] = await pages();
  assert.equal((await pageState(page)).runs, 1);
});

test('survives a page reload', { skip }, async () => {
  const [page] = await pages();
  await evalIn(page, 'window.__beforeReload = true; location.reload()');
  const state = await waitFor(async () => {
    const s = await pageState(page);
    return s.marker === null && s.theme && s.runs === 1 && s;
  }, 'injection after reload');
  assert.match(state.theme, /#123456/);
  assert.equal(state.styledAtStart, true, 'theme should be in place before the page runs, no unthemed flash');
});

test('themes new windows and tabs', { skip }, async () => {
  const [first] = await pages();
  await evalIn(first, `void window.open(location.href)`);
  const all = await waitFor(async () => {
    const list = await pages();
    return list.length === 2 && list;
  }, 'second page');
  for (const page of all) {
    await waitFor(async () => {
      const s = await pageState(page);
      return s.theme && s.runs === 1;
    }, `injection into ${page.id}`);
  }
  assert.equal(daemon.attachedTargets().length, 2);
});

test('editing the theme file updates every tab live', { skip }, async () => {
  lib.writeItem('theme', 'Test', ':root { --ns-bg: #abcdef; }');
  for (const page of await pages()) {
    await waitFor(async () => /#abcdef/.test((await pageState(page)).theme ?? ''), `live update in ${page.id}`);
  }
});

test('clearing the theme restores stock styling', { skip }, async () => {
  writeConfig({ ...readConfig(), activeTheme: '' });
  for (const page of await pages()) {
    await waitFor(async () => {
      const s = await pageState(page);
      return s.theme === null && s.core === false;
    }, `styles removed in ${page.id}`);
  }
});

test('exits when Notion quits', { skip }, async () => {
  fake.kill();
  await waitFor(
    () => Promise.race([daemon.done.then(() => true), new Promise(r => setTimeout(() => r(false), 500))]),
    'daemon exit'
  );
});
