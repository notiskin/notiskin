// drives the long-running injector against a fake Notion (an Electron app) over the DevTools pipe, never the real one
const { dataDir } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('child_process');
const { mkdtempSync, mkdirSync, rmSync, renameSync, openSync, closeSync, existsSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const net = require('net');
const http = require('http');
const lib = require('../../dist/core/library');
const { readConfig, writeConfig } = require('../../dist/utils/config');
const { startInjectorDaemon } = require('../../dist/injector/daemon');
const { askInjector } = require('../../dist/injector/control');
const { findNotionRun } = require('../../dist/injector/pipe');
const { diagnosticsReport } = require('../../dist/core/diagnostics');
const { RUN_DIR, CONTROL_SOCKET, INJECTOR_PID_PATH } = require('../../dist/utils/constants');
const { pidLockHolder } = require('../../dist/utils/pidlock');

let electronPath = null;
try { electronPath = require('electron'); } catch {}

const skip = (!electronPath && 'Electron binary not installed') || (process.platform === 'win32' && 'needs FIFOs');

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

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let pagePort;
let fake;
let run;
let daemon;
let userData;
const children = [];
const logs = [];

// what the wrapper does: FIFOs in a 0700 folder named after Notion's pid, opened read+write as fds 3 and 4
function launchFakeNotion() {
  mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(RUN_DIR, 'launch-'));
  execFileSync('mkfifo', ['-m', '600', join(dir, 'in'), join(dir, 'out')]);
  const inFd = openSync(join(dir, 'in'), 'r+');
  const outFd = openSync(join(dir, 'out'), 'r+');
  const child = spawn(electronPath, [join(__dirname, '..', 'fixtures', 'fake-notion', 'main.js'), '--remote-debugging-pipe'], {
    env: { ...process.env, PAGE_PORT: String(pagePort), USER_DATA: userData },
    stdio: ['ignore', 'ignore', 'ignore', inFd, outFd],
  });
  closeSync(inFd);
  closeSync(outFd);
  const runDir = join(RUN_DIR, String(child.pid));
  renameSync(dir, runDir);
  return { child, run: { dir: runDir, pid: child.pid } };
}

function startChildInjector() {
  const child = spawn(
    process.execPath,
    [join(__dirname, '..', 'fixtures', 'run-injector.js'), run.dir, `http://127.0.0.1:${pagePort}/`],
    { stdio: 'ignore' }
  );
  children.push(child);
  return child;
}

const isFakePage = url => url.startsWith(`http://127.0.0.1:${pagePort}/`);

// JS in every fake Notion window, through the fake's own test endpoint, not the pipe
function evalAll(expression) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: pagePort, path: '/__eval', method: 'POST' }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).filter(w => isFakePage(w.url)));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end(expression);
  });
}

const STATE = `({
  theme: document.getElementById('notiskin-styles')?.textContent ?? null,
  core: !!document.getElementById('notiskin-core-styles'),
  api: typeof window.notiskin,
  runs: window.__pluginRuns ?? 0,
  marker: window.__beforeReload ?? null,
  styledAtStart: window.__styledAtStart,
  styleAtStart: window.__styleAtStart,
})`;

const states = async () => (await evalAll(STATE)).map(w => w.value);

async function everyPage(check, what) {
  return waitFor(async () => {
    const all = await states();
    return all.length > 0 && all.every(s => s && check(s)) && all;
  }, what);
}

before(async () => {
  if (skip) return;
  pagePort = await freePort();
  userData = mkdtempSync(join(tmpdir(), 'notiskin-fake-notion-'));

  lib.writeItem('theme', 'Test', ':root { --ns-bg: #123456; }');
  lib.writeItem('plugin', 'counter', 'window.__pluginRuns = (window.__pluginRuns || 0) + 1;');
  writeConfig({ activeTheme: 'Test', enabledPlugins: ['counter'], acknowledgedPlugins: ['counter'] });

  ({ child: fake, run } = launchFakeNotion());

  daemon = await startInjectorDaemon({
    run,
    isTargetUrl: isFakePage,
    // the same payload function the real `notiskin inject` uses, so safe mode is covered too
    loadPayload: () => lib.currentPayload(readConfig()),
    watchPaths: [dataDir, join(dataDir, 'themes'), join(dataDir, 'plugins')],
    controlSocket: true,
    log: msg => logs.push(msg),
  });
});

after(async () => {
  if (skip) return;
  await daemon?.stop().catch(() => {});
  for (const c of children) c.kill('SIGKILL');
  fake?.kill('SIGKILL');
  rmSync(userData, { recursive: true, force: true });
});

test('no TCP debug port is open, only the fake page server', { skip }, async () => {
  await waitFor(async () => (await states()).length === 1, 'the fake page');
  let out = '';
  try {
    out = execFileSync('lsof', ['-a', '-p', String(fake.pid), '-iTCP', '-sTCP:LISTEN', '-nP'], { encoding: 'utf-8' });
  } catch {}
  const ports = out.split('\n').slice(1).filter(Boolean).map(line => line.match(/:(\d+) \(LISTEN\)/)?.[1]);
  assert.deepEqual(ports, [String(pagePort)]);
});

test('themes the page and runs plugins once', { skip }, async () => {
  const [state] = await everyPage(s => s.theme && s.runs === 1, 'first injection');
  assert.match(state.theme, /#123456/);
  assert.equal(state.core, true);
  assert.equal(state.api, 'object');
});

test('re-applying does not run plugins twice', { skip }, async () => {
  await daemon.reapplyAll();
  assert.equal((await states())[0].runs, 1);
});

test('survives a page reload', { skip }, async () => {
  await evalAll('window.__beforeReload = true; location.reload()');
  const [state] = await everyPage(s => s.marker === null && s.theme && s.runs === 1, 'injection after reload');
  assert.match(state.theme, /#123456/);
  assert.equal(state.styledAtStart, true, 'theme should be in place before the page runs, no unthemed flash');
});

test('themes new windows and tabs', { skip }, async () => {
  await evalAll('void window.open(location.href)');
  await waitFor(async () => (await states()).length === 2, 'second page');
  await everyPage(s => s.theme && s.runs === 1, 'injection into both pages');
  assert.equal(daemon.attachedTargets().length, 2);
});

test('editing the theme file updates every tab live', { skip }, async () => {
  lib.writeItem('theme', 'Test', ':root { --ns-bg: #abcdef; }');
  await everyPage(s => /#abcdef/.test(s.theme ?? ''), 'live update');
});

test('big themes and replies far bigger than the pipe buffer go through', { skip }, async () => {
  const big = ':root { --ns-bg: #fedcba; }\n/* ' + 'x'.repeat(300_000) + ' */';
  lib.writeItem('theme', 'Test', big);
  await everyPage(s => (s.theme ?? '').length === big.length, 'the big theme');

  // several replies at once, each many times the 8 KB a macOS FIFO holds
  const { targetInfos } = await daemon.cdp.send('Target.getTargets');
  const page = targetInfos.find(t => t.type === 'page' && isFakePage(t.url));
  const { sessionId } = await daemon.cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const sizes = [20_000, 100_000, 250_000, 50_000, 400_000];
  const replies = await Promise.all(
    sizes.map(n => daemon.cdp.send('Runtime.evaluate', { expression: `"y".repeat(${n})`, returnByValue: true }, sessionId))
  );
  assert.deepEqual(replies.map(r => r.result.value.length), sizes);
  await daemon.cdp.send('Target.detachFromTarget', { sessionId });

  lib.writeItem('theme', 'Test', ':root { --ns-bg: #abcdef; }');
  await everyPage(s => /#abcdef/.test(s.theme ?? '') && s.theme.length < 100, 'the small theme back');
});

test('the CLI and app apply through the injector, and a reload drops a disabled plugin', { skip }, async () => {
  assert.equal((await askInjector({ cmd: 'status' })).tabs, 2);
  assert.equal(await lib.applyConfig(), true);

  await evalAll('window.__beforeReload = true');
  writeConfig({ ...readConfig(), enabledPlugins: [] });
  assert.equal(await lib.applyConfig({ reload: true }), true);
  // applyConfig only returns once every tab has reloaded and been themed again
  for (const s of await states()) {
    assert.equal(s.marker, null, 'reloaded');
    assert.equal(s.runs, 0, 'plugin gone');
    assert.match(s.theme, /#abcdef/);
  }
  writeConfig({ ...readConfig(), enabledPlugins: ['counter'] });
  await lib.applyConfig();
  await everyPage(s => s.runs === 1, 'plugin back');
});

test('safe mode removes the theme from every tab, turning it off brings it back', { skip }, async () => {
  writeConfig({ ...readConfig(), safeMode: true });
  assert.equal(await lib.applyConfig({ reload: true }), true);
  for (const s of await states()) {
    assert.equal(s.theme, null);
    assert.equal(s.core, false);
    assert.equal(s.styledAtStart, false, 'no flash of the old theme while reloading into safe mode');
  }
  writeConfig({ ...readConfig(), safeMode: false });
  await everyPage(s => /#abcdef/.test(s.theme ?? ''), 'theme back');
});

test('clearing the theme restores stock styling', { skip }, async () => {
  writeConfig({ ...readConfig(), activeTheme: '' });
  await everyPage(s => s.theme === null && s.core === false, 'styles removed');
  writeConfig({ ...readConfig(), activeTheme: 'Test' });
  await everyPage(s => /#abcdef/.test(s.theme ?? ''), 'theme back');
});

test('stopping the injector leaves Notion as it was', { skip }, async () => {
  await daemon.stop();
  assert.ok(!existsSync(CONTROL_SOCKET));
  await evalAll('location.reload()');
  const all = await everyPage(s => s.styledAtStart === false, 'reload without Notiskin');
  assert.equal(all[0].theme, null);
  assert.ok(alive(fake.pid));
});

test('Notion keeps running when the injector is killed, and a new one takes over', { skip }, async () => {
  const first = startChildInjector();
  await everyPage(s => /#abcdef/.test(s.theme ?? ''), 'first child injector');
  first.kill('SIGKILL');
  await new Promise(r => first.once('exit', r));
  await new Promise(r => setTimeout(r, 1000));
  assert.ok(alive(fake.pid), 'the fake Notion is still running');
  assert.equal((await states()).length, 2, 'and still answering');

  // while nobody is connected, the dead injector's sessions keep its old theme registered for reloads
  lib.writeItem('theme', 'Test', ':root { --ns-bg: #0f0f0f; }');
  startChildInjector();
  await everyPage(s => /#0f0f0f/.test(s.theme ?? ''), 'second child injector');
  await evalAll('location.reload()');
  await everyPage(s => s.styledAtStart && s.theme, 'reload');
  for (const s of await states()) assert.match(s.styleAtStart, /#0f0f0f/, 'the killed injector left no old theme behind');
  // detaching the old sessions must not have cost the new injector its own
  lib.writeItem('theme', 'Test', ':root { --ns-bg: #0a0a0a; }');
  await everyPage(s => /#0a0a0a/.test(s.theme ?? ''), 'a theme change after the takeover');
  lib.writeItem('theme', 'Test', ':root { --ns-bg: #abcdef; }');
  await everyPage(s => /#abcdef/.test(s.theme ?? ''), 'the theme back');
});

test('applying with no injector running starts one', { skip }, async () => {
  for (const c of children) c.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 500));
  assert.equal(await askInjector({ cmd: 'status' }), null, 'a socket left by a killed injector is ignored');
  assert.deepEqual(findNotionRun(), run);
  // ensureInjector starts the real `notiskin inject`, it finds this Notion through ~/.notiskin/run
  assert.equal(await lib.applyConfig(), true);
  const status = await askInjector({ cmd: 'status' });
  assert.equal(status.pid, fake.pid);

  const report = await diagnosticsReport();
  assert.match(report, /DevTools pipe: {3}open/);
  assert.match(report, /Injector: {8}running \(pid \d+\), connected/);
});

test('a stopped injector keeps its lock until it has exited, then a theme switch starts a new one', { skip }, async () => {
  const pid = pidLockHolder(INJECTOR_PID_PATH);
  assert.ok(pid, 'the injector started by applyConfig holds the lock');
  // what `pkill -f "index.js inject"` does
  process.kill(pid, 'SIGTERM');
  // while that process is still alive, nobody else may take the lock and open the pipe
  await waitFor(() => {
    if (alive(pid)) assert.equal(pidLockHolder(INJECTOR_PID_PATH), pid);
    return !alive(pid);
  }, 'the injector to exit', 10_000);
  assert.equal(pidLockHolder(INJECTOR_PID_PATH), null);
  assert.ok(alive(fake.pid), 'Notion is still running');

  assert.equal(await lib.applyConfig(), true);
  const status = await askInjector({ cmd: 'status' });
  assert.equal(status.pid, fake.pid);
  assert.notEqual(pidLockHolder(INJECTOR_PID_PATH), pid);
});

test('the injector exits and cleans up when Notion quits', { skip }, async () => {
  fake.kill();
  await waitFor(async () => (await askInjector({ cmd: 'status' }, 1000)) === null, 'the injector to exit', 10_000);
  await waitFor(() => !existsSync(run.dir), 'the pipe folder to be removed', 10_000);
  assert.equal(findNotionRun(), null);
});
