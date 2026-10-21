require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app, sanitizeSearch, notionSetup, setupFailureReason, appManagementName, repairLegacyWrapper, ensureWatcher } = require('../dist/gui/server');

let server;
let port;
let token;

// fetch can't override Host, and the Host header is exactly what we need to test
function request(method, path, { host = 'localhost:3845', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          Host: host,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          let json;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const authed = (extra = {}) => ({ 'X-Notiskin-Token': token, ...extra });

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  port = server.address().port;
  const page = await request('GET', '/');
  token = page.text.match(/const token = "([0-9a-f]+)"/)[1];
});

after(() => server.close());

test('pages get the session token and anti-framing headers', async () => {
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(token.length, 64);
});

test('requests with a foreign Host are refused (DNS rebinding)', async () => {
  const res = await request('GET', '/', { host: 'evil.test:3845' });
  assert.equal(res.status, 403);
});

test('API calls without the session token are refused', async () => {
  const res = await request('GET', '/api/state');
  assert.equal(res.status, 403);
  const wrong = await request('GET', '/api/state', { headers: { 'X-Notiskin-Token': 'f'.repeat(64) } });
  assert.equal(wrong.status, 403);
});

test('API calls from another website are refused even with a token', async () => {
  const res = await request('POST', '/api/plugin/acknowledge/x', {
    headers: authed({ Origin: 'https://evil.test' }),
  });
  assert.equal(res.status, 403);
});

test('API calls with the token from the app origin work', async () => {
  const res = await request('GET', '/api/state', { headers: authed({ Origin: 'http://localhost:3845' }) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { activeTheme: null, safeMode: false, themes: [], plugins: [] });
});

test('path traversal names are rejected', async () => {
  const res = await request('POST', `/api/theme/${encodeURIComponent('../../evil')}`, { headers: authed() });
  assert.equal(res.json.ok, false);
  const ack = await request('POST', `/api/plugin/acknowledge/${encodeURIComponent('../x')}`, { headers: authed() });
  assert.equal(ack.json.ok, false);
});

test('marketplace install validates its input before touching the network', async () => {
  const badType = await request('POST', '/api/marketplace/install', { headers: authed(), body: { type: 'exe', id: '1' } });
  assert.equal(badType.status, 400);
  const badId = await request('POST', '/api/marketplace/install', { headers: authed(), body: { type: 'theme', id: '1;drop' } });
  assert.equal(badId.status, 400);
});

test('open-external only allows GitHub https links', async () => {
  for (const url of ['file:///etc/passwd', 'http://github.com', 'https://evil.test', 'not a url']) {
    const res = await request('POST', '/api/open-external', { headers: authed(), body: { url } });
    assert.equal(res.status, 400, url);
  }
});

test('the old install-from-any-url endpoint is gone', async () => {
  const res = await request('POST', '/api/install', { headers: authed(), body: { type: 'plugin', name: 'x', url: 'http://evil.test' } });
  assert.equal(res.status, 404);
});

test('sanitizeSearch strips PostgREST filter syntax', () => {
  assert.equal(sanitizeSearch('dark),status.eq.pending'), 'dark  status.eq.pending');
  assert.equal(sanitizeSearch('100%_'), '100');
  assert.equal(sanitizeSearch(undefined), '');
  assert.equal(sanitizeSearch('x'.repeat(500)).length, 100);
});

// the real check, before any test mocks it
const realPackaged = notionSetup.packaged;

// the Install into Notion endpoints, with the platform and the CLI run mocked
function mockNotionSetup({
  platform = 'darwin',
  status = 'not-installed',
  legacy = false,
  packaged = false,
  otherCopy = false,
  watcherIsOurs = false,
  installWatcher,
  run,
  restart,
} = {}) {
  const calls = [];
  notionSetup.platform = () => platform;
  notionSetup.status = () => status;
  notionSetup.legacy = () => legacy;
  notionSetup.packaged = () => packaged;
  notionSetup.otherCopy = () => otherCopy;
  notionSetup.watcherIsOurs = () => watcherIsOurs;
  notionSetup.installWatcher = () => {
    calls.push('watcher');
    installWatcher?.();
  };
  notionSetup.removeWatcher = () => {
    calls.push('remove-watcher');
  };
  notionSetup.run = async action => {
    calls.push(action);
    return run ? run(action) : { status: 'ok', output: '' };
  };
  notionSetup.restart = async () => {
    calls.push('restart');
    if (restart) await restart();
  };
  notionSetup.openAppManagement = async () => {
    calls.push('app-management');
  };
  return calls;
}

const NOTION_ROUTES = [
  ['GET', '/api/notion/status'],
  ['POST', '/api/notion/install'],
  ['POST', '/api/notion/uninstall'],
  ['POST', '/api/notion/restart'],
  ['POST', '/api/notion/app-management'],
  ['POST', '/api/notion/block-native'],
  ['POST', '/api/notion/auto-repair'],
];

test('Notion setup endpoints need the session token', async () => {
  const calls = mockNotionSetup();
  for (const [method, path] of NOTION_ROUTES) {
    const res = await request(method, path);
    assert.equal(res.status, 403, path);
    const foreign = await request(method, path, { headers: authed({ Origin: 'https://evil.test' }) });
    assert.equal(foreign.status, 403, path);
  }
  assert.deepEqual(calls, []);
});

test('Notion setup endpoints only work on macOS', async () => {
  const calls = mockNotionSetup({ platform: 'linux' });
  for (const [method, path] of NOTION_ROUTES) {
    const res = await request(method, path, { headers: authed() });
    assert.equal(res.status, 400, path);
    assert.match(res.json.error, /macOS/);
  }
  assert.deepEqual(calls, []);
});

test('status, install, and uninstall report back in plain terms', async () => {
  const calls = mockNotionSetup({ status: 'installed' });
  const status = await request('GET', '/api/notion/status', { headers: authed() });
  assert.equal(status.json.status, 'installed');

  // a request body is ignored, the command only comes from the server's own paths
  const install = await request('POST', '/api/notion/install', { headers: authed(), body: { action: 'rm -rf /' } });
  assert.deepEqual(install.json, { ok: true, status: 'installed' });
  const uninstall = await request('POST', '/api/notion/uninstall', { headers: authed() });
  assert.equal(uninstall.json.ok, true);
  const restart = await request('POST', '/api/notion/restart', { headers: authed() });
  assert.equal(restart.json.ok, true);
  const settings = await request('POST', '/api/notion/app-management', { headers: authed() });
  assert.equal(settings.json.ok, true);
  assert.deepEqual(calls, ['patch', 'unpatch', 'restart', 'app-management']);
});

test('install errors come back as a message with the reason', async () => {
  mockNotionSetup({ run: () => ({ status: 'error', message: 'Could not find Notion.app.', output: 'x' }) });
  const res = await request('POST', '/api/notion/install', { headers: authed() });
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error, 'Could not find Notion.app.');
  assert.equal(res.json.reason, null);

  const eperm = "Error: EPERM: operation not permitted, rename '/Applications/Notion.app/Contents/MacOS/Notion'";
  mockNotionSetup({ run: () => ({ status: 'error', message: 'EPERM', output: eperm }) });
  const blocked = await request('POST', '/api/notion/install', { headers: authed() });
  assert.equal(blocked.json.reason, 'app-management');
  assert.equal(typeof blocked.json.appName, 'string');

  mockNotionSetup({ run: () => { throw new Error('boom'); } });
  const thrown = await request('POST', '/api/notion/install', { headers: authed() });
  assert.deepEqual(thrown.json, { ok: false, error: 'boom' });
});

test('only one install or uninstall runs at a time', async () => {
  let finish;
  const calls = mockNotionSetup({ run: () => new Promise(r => { finish = r; }) });
  const first = request('POST', '/api/notion/install', { headers: authed() });
  while (!finish) await new Promise(r => setTimeout(r, 5));

  const second = await request('POST', '/api/notion/install', { headers: authed() });
  assert.equal(second.status, 409);
  const other = await request('POST', '/api/notion/uninstall', { headers: authed() });
  assert.equal(other.status, 409);

  finish({ status: 'ok', output: '' });
  assert.equal((await first).json.ok, true);
  assert.deepEqual(calls, ['patch']);

  // the lock is released afterwards, also after a failure
  mockNotionSetup({ run: () => ({ status: 'error', message: 'x', output: '' }) });
  assert.equal((await request('POST', '/api/notion/install', { headers: authed() })).json.ok, false);
  mockNotionSetup();
  assert.equal((await request('POST', '/api/notion/install', { headers: authed() })).json.ok, true);
});

test('the app repairs an old port wrapper on start, and leaves everything else alone', async () => {
  let calls = mockNotionSetup({ legacy: true, status: 'needs-repair' });
  assert.equal(await repairLegacyWrapper(), true);
  assert.deepEqual(calls, ['patch'], 'repairs, never restarts Notion');

  // a failed repair leaves Settings' Repair button to the user
  calls = mockNotionSetup({ legacy: true, status: 'needs-repair', run: () => ({ status: 'error', message: 'EPERM', output: 'EPERM' }) });
  assert.equal(await repairLegacyWrapper(), false);
  assert.deepEqual(calls, ['patch']);
  calls = mockNotionSetup({ legacy: true, run: () => { throw new Error('boom'); } });
  assert.equal(await repairLegacyWrapper(), false);

  for (const setup of [{ legacy: false, status: 'installed' }, { legacy: false, status: 'needs-repair' }, { legacy: true, platform: 'linux' }]) {
    calls = mockNotionSetup(setup);
    assert.equal(await repairLegacyWrapper(), false);
    assert.deepEqual(calls, [], JSON.stringify(setup));
  }
  mockNotionSetup();
});

test('a Notion installed from another copy of Notiskin is offered as a Repair, never repaired on its own', async () => {
  let calls = mockNotionSetup({ status: 'installed', packaged: true, otherCopy: true });
  let res = await request('GET', '/api/notion/status', { headers: authed() });
  assert.equal(res.json.status, 'needs-repair');
  assert.equal(res.json.otherCopy, true);
  assert.equal(await repairLegacyWrapper(), false);
  assert.equal(ensureWatcher(), false, "the watcher isn't taken over either");
  assert.deepEqual(calls, []);

  // a copy run from source leaves it alone
  mockNotionSetup({ status: 'installed', packaged: false, otherCopy: true });
  res = await request('GET', '/api/notion/status', { headers: authed() });
  assert.equal(res.json.status, 'installed');
  assert.equal(res.json.otherCopy, false);

  // only an installed Notion can be running another copy, the other statuses keep their own meaning
  for (const status of ['installed', 'not-installed', 'needs-repair', 'unsupported']) {
    mockNotionSetup({ status, packaged: true, otherCopy: status !== 'installed' });
    res = await request('GET', '/api/notion/status', { headers: authed() });
    assert.equal(res.json.status, status);
    assert.equal(res.json.otherCopy, false);
  }
  mockNotionSetup();
});

test("copies run from source never call another copy's wrapper broken", () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require('fs');
  const { join } = require('path');
  const { tmpdir } = require('os');
  const { makeWrapperScript, wrapperRunsOtherCopy } = require('../dist/patcher/index');
  const { CLI_SCRIPT } = require('../dist/core/library');
  // a temp Notion.app whose wrapper runs some other installed copy
  const notionApp = join(mkdtempSync(join(tmpdir(), 'notiskin-notion-')), 'Notion.app');
  mkdirSync(join(notionApp, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(notionApp, 'Contents', 'Frameworks', 'Electron Framework.framework'), { recursive: true });
  writeFileSync(
    join(notionApp, 'Contents', 'MacOS', 'Notion'),
    makeWrapperScript('/Applications/notiskin.app/Contents/MacOS/notiskin', '/Applications/notiskin.app/Contents/Resources/app.asar/dist/cli/index.js', { appMode: true })
  );
  const before = process.env.NOTISKIN_NOTION_APP;
  process.env.NOTISKIN_NOTION_APP = notionApp;
  try {
    assert.equal(wrapperRunsOtherCopy(process.execPath, CLI_SCRIPT), true);
    // these tests run dist/ from the checkout, not app.asar, so the server doesn't flag it
    assert.equal(realPackaged(), false);
  } finally {
    if (before === undefined) delete process.env.NOTISKIN_NOTION_APP;
    else process.env.NOTISKIN_NOTION_APP = before;
  }
});

// the switch in Settings, off unless turned on
function setAutoRepair(on) {
  const { readConfig, writeConfig } = require('../dist/utils/config');
  writeConfig({ ...readConfig(), autoRepair: on });
}

test('with repairing automatically on, the app keeps the watcher pointed at itself once Notion runs it', async () => {
  setAutoRepair(true);
  const ready = { status: 'installed', packaged: true };
  let calls = mockNotionSetup(ready);
  assert.equal(ensureWatcher(), true);
  assert.deepEqual(calls, ['watcher']);

  // Install and Repair set it up right after patching
  calls = mockNotionSetup(ready);
  assert.equal((await request('POST', '/api/notion/install', { headers: authed() })).json.ok, true);
  assert.deepEqual(calls, ['patch', 'watcher']);
  calls = mockNotionSetup(ready);
  await request('POST', '/api/notion/uninstall', { headers: authed() });
  assert.deepEqual(calls, ['unpatch'], 'uninstall removes it, never sets it up');
  calls = mockNotionSetup({ ...ready, run: () => ({ status: 'error', message: 'EPERM', output: 'EPERM' }) });
  await request('POST', '/api/notion/install', { headers: authed() });
  assert.deepEqual(calls, ['patch'], 'not after a failed install');

  // nothing to do, or not this copy's call
  for (const setup of [
    { ...ready, watcherIsOurs: true },
    { ...ready, packaged: false },
    { ...ready, otherCopy: true },
    { ...ready, status: 'not-installed' },
    { ...ready, status: 'needs-repair' },
    { ...ready, platform: 'linux' },
  ]) {
    calls = mockNotionSetup(setup);
    assert.equal(ensureWatcher(), false, JSON.stringify(setup));
    assert.deepEqual(calls, [], JSON.stringify(setup));
  }

  // a failure is only logged
  mockNotionSetup({ ...ready, installWatcher: () => { throw new Error('launchctl failed'); } });
  assert.equal(ensureWatcher(), false);
  setAutoRepair(false);
  mockNotionSetup();
});

test('with repairing automatically off (the default), nothing runs in the background', async () => {
  setAutoRepair(false);
  const ready = { status: 'installed', packaged: true };
  let calls = mockNotionSetup(ready);
  assert.equal(ensureWatcher(), false);
  calls = mockNotionSetup(ready);
  await request('POST', '/api/notion/install', { headers: authed() });
  assert.deepEqual(calls, ['patch'], 'Install leaves it off');

  // the watcher 0.7.0 set up for everyone is removed on start, but only this app's own
  calls = mockNotionSetup({ ...ready, watcherIsOurs: true });
  assert.equal(ensureWatcher(), true);
  assert.deepEqual(calls, ['remove-watcher']);
  for (const setup of [{ ...ready, watcherIsOurs: true, packaged: false }, { ...ready, watcherIsOurs: true, platform: 'linux' }]) {
    calls = mockNotionSetup(setup);
    assert.equal(ensureWatcher(), false, JSON.stringify(setup));
    assert.deepEqual(calls, [], JSON.stringify(setup));
  }
  mockNotionSetup();
});

test('the repair switch is saved and sets up or removes the watcher right away', async () => {
  const { readConfig } = require('../dist/utils/config');
  setAutoRepair(false);
  let calls = mockNotionSetup({ status: 'installed', packaged: true });
  assert.equal((await request('POST', '/api/notion/auto-repair', { headers: authed(), body: { on: 'yes' } })).status, 400);
  let res = await request('POST', '/api/notion/auto-repair', { headers: authed(), body: { on: true } });
  assert.equal(res.json.ok, true);
  assert.equal(res.json.autoRepair, true);
  assert.equal(readConfig().autoRepair, true);
  assert.deepEqual(calls, ['watcher']);

  calls = mockNotionSetup({ status: 'installed', packaged: true, watcherIsOurs: true });
  res = await request('POST', '/api/notion/auto-repair', { headers: authed(), body: { on: false } });
  assert.equal(res.json.autoRepair, false);
  assert.equal(readConfig().autoRepair, false);
  assert.deepEqual(calls, ['remove-watcher']);

  // Notion not installed yet: saved, the watcher starts at Install
  calls = mockNotionSetup({ status: 'not-installed', packaged: true });
  res = await request('POST', '/api/notion/auto-repair', { headers: authed(), body: { on: true } });
  assert.deepEqual(res.json, { ok: true, autoRepair: true, running: false });
  assert.deepEqual(calls, []);

  // Settings shows the switch only in the packaged app
  mockNotionSetup({ status: 'installed', packaged: true });
  res = await request('GET', '/api/notion/status', { headers: authed() });
  assert.equal(res.json.autoRepair, true);
  assert.equal(res.json.autoRepairAvailable, true);
  mockNotionSetup({ status: 'installed' });
  res = await request('GET', '/api/notion/status', { headers: authed() });
  assert.equal(res.json.autoRepairAvailable, false);
  setAutoRepair(false);
  mockNotionSetup();
});

test('the hold-back switch is saved, and re-signs Notion only when it is installed', async () => {
  const { readConfig } = require('../dist/utils/config');
  let calls = mockNotionSetup({ status: 'not-installed' });
  assert.equal((await request('POST', '/api/notion/block-native', { headers: authed(), body: { on: 'yes' } })).status, 400);
  let res = await request('POST', '/api/notion/block-native', { headers: authed(), body: { on: false } });
  assert.deepEqual(res.json, { ok: true, blockNative: false, applied: false });
  assert.equal(readConfig().blockNativeNotion, false);
  assert.deepEqual(calls, [], 'nothing to re-sign yet, Install picks the setting up');

  calls = mockNotionSetup({ status: 'installed' });
  res = await request('POST', '/api/notion/block-native', { headers: authed(), body: { on: true } });
  assert.deepEqual(res.json, { ok: true, blockNative: true, applied: true });
  assert.deepEqual(calls, ['patch']);
  const status = await request('GET', '/api/notion/status', { headers: authed() });
  assert.equal(status.json.blockNative, true);

  // saved even when macOS blocks the re-sign, Settings explains and the app retries on its next start
  mockNotionSetup({ status: 'installed', run: () => ({ status: 'error', message: 'EPERM', output: 'Error: EPERM: operation not permitted' }) });
  res = await request('POST', '/api/notion/block-native', { headers: authed(), body: { on: false } });
  assert.equal(res.json.ok, false);
  assert.equal(res.json.reason, 'app-management');
  assert.equal(readConfig().blockNativeNotion, false);
  mockNotionSetup();
});

test('the Supabase script is served wherever Notiskin lives, dot folders included', async () => {
  const res = await request('GET', '/vendor/supabase.js', { headers: authed() });
  assert.equal(res.status, 200);
});

test('failure reasons are read from the CLI output', () => {
  assert.equal(setupFailureReason("Error: EPERM: operation not permitted, rename 'a' -> 'b'"), 'app-management');
  assert.equal(setupFailureReason('Error: Failed to write wrapper, original restored. EPERM: operation not permitted'), 'app-management');
  assert.equal(setupFailureReason('Error: Permission denied.\nRun: sudo npm run patch'), 'not-owner');
  assert.equal(setupFailureReason('Error: Could not find Notion.app.'), null);
});

test('the App Management hint names the app macOS checks', () => {
  assert.equal(appManagementName('/Applications/notiskin.app/Contents/MacOS/notiskin', true), 'Notiskin');
  assert.equal(appManagementName('/Users/me/notiskin/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', true), 'Electron');
  assert.equal(appManagementName('/usr/local/bin/node', false), 'Terminal');
});

test('safe mode can be switched from the app, and only with a real true or false', async () => {
  const { readConfig } = require('../dist/utils/config');
  for (const body of [{}, { on: 'yes' }, { on: 1 }]) {
    const res = await request('POST', '/api/safe-mode', { headers: authed(), body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await request('POST', '/api/safe-mode', { body: { on: true } })).status, 403);

  // no Notion runs in tests, so nothing gets applied, but the setting is saved
  const on = await request('POST', '/api/safe-mode', { headers: authed(), body: { on: true } });
  assert.equal(on.json.ok, true);
  assert.equal(on.json.safeMode, true);
  assert.equal(readConfig().safeMode, true);
  assert.equal((await request('GET', '/api/status', { headers: authed() })).json.safeMode, true);

  const off = await request('POST', '/api/safe-mode', { headers: authed(), body: { on: false } });
  assert.equal(off.json.safeMode, false);
  assert.equal(readConfig().safeMode, false);
});

test('the shared stylesheet and its fonts are served, and nothing else from the folder', async () => {
  const css = await request('GET', '/brand.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /css/);
  assert.match(css.text, /--accent/);
  for (const font of ['/fonts/fraunces.woff2', '/fonts/inter.woff2']) {
    const res = await request('GET', font);
    assert.equal(res.status, 200, font);
    assert.equal(res.headers['content-type'], 'font/woff2');
  }
  assert.equal((await request('GET', '/fonts/LICENSE-inter.txt')).status, 404);
  assert.equal((await request('GET', '/server.ts')).status, 404);
  for (const page of ['/', '/plugins.html', '/settings.html', '/review.html']) {
    assert.match((await request('GET', page)).text, /<link rel="stylesheet" href="\/brand\.css">/, page);
  }
});

test('the tour script is served to the pages that load it', async () => {
  const res = await request('GET', '/tour.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.text, /notiskinTour/);
  for (const page of ['/', '/plugins.html', '/settings.html']) {
    assert.match((await request('GET', page)).text, /<script src="\/tour\.js"><\/script>/, page);
  }
});

test('the welcome tour starts on its own only for new users', async () => {
  const { readConfig, writeConfig } = require('../dist/utils/config');
  const showTour = async () => (await request('GET', '/api/setup', { headers: authed() })).json.showTour;
  assert.equal((await request('GET', '/api/setup')).status, 403);
  writeConfig({ ...readConfig(), setupDone: false });

  mockNotionSetup({ status: 'not-installed' });
  assert.equal(await showTour(), true);
  mockNotionSetup({ status: 'needs-repair' });
  assert.equal(await showTour(), true);
  // set up before the tour existed
  mockNotionSetup({ status: 'installed' });
  assert.equal(await showTour(), false);
  // the status check failing shouldn't hide the tour
  mockNotionSetup();
  notionSetup.status = () => { throw new Error('boom'); };
  assert.equal(await showTour(), true);
  mockNotionSetup({ platform: 'linux', status: 'installed' });
  assert.equal(await showTour(), true);

  mockNotionSetup({ status: 'not-installed' });
  assert.equal((await request('POST', '/api/setup-done')).status, 403);
  const done = await request('POST', '/api/setup-done', { headers: authed() });
  assert.equal(done.json.ok, true);
  assert.equal(readConfig().setupDone, true);
  assert.equal(await showTour(), false);
});

test('diagnostics need the token and come back as a report', async () => {
  assert.equal((await request('GET', '/api/diagnostics')).status, 403);
  const res = await request('GET', '/api/diagnostics', { headers: authed() });
  assert.equal(res.status, 200);
  assert.match(res.json.report, /^Notiskin diagnostics/);
  assert.match(res.json.report, /Safe mode:\s+off/);
});

test('update checks need the token, and only the desktop app checks', async () => {
  for (const [method, path] of [['GET', '/api/update-status'], ['POST', '/api/update/check'], ['POST', '/api/update/install']]) {
    assert.equal((await request(method, path)).status, 403, path);
  }
  // these tests run on Node, which has no updater: nothing to check, nothing to install
  assert.deepEqual((await request('GET', '/api/update-status', { headers: authed() })).json, { state: 'up-to-date' });
  const check = await request('POST', '/api/update/check', { headers: authed() });
  assert.equal(check.status, 400);
  assert.match(check.json.error, /desktop app/);
});

test('every page says a new version is out and links to the download, never promising an install', () => {
  const { readFileSync } = require('fs');
  const { join } = require('path');
  for (const page of ['themes', 'plugins', 'review', 'settings']) {
    const html = readFileSync(join(__dirname, '..', 'src', 'gui', `${page}.html`), 'utf-8');
    assert.match(html, /is out`/, page);
    assert.match(html, /onclick="openReleasesPage\(\)"[^>]*>Download<\/button>/, page);
    assert.doesNotMatch(html, /Ready to install`|ready`;|>Install<\/a>/, page);
  }
});

test('marketplace update refuses bad input, unconfirmed plugins and files not from the marketplace', async () => {
  const lib = require('../dist/core/library');
  const bad = await request('POST', '/api/marketplace/update', { headers: authed(), body: { type: 'exe', name: 'x' } });
  assert.equal(bad.status, 400);
  const badName = await request('POST', '/api/marketplace/update', { headers: authed(), body: { type: 'theme', name: '../x' } });
  assert.equal(badName.status, 400);
  const unconfirmed = await request('POST', '/api/marketplace/update', { headers: authed(), body: { type: 'plugin', name: 'x' } });
  assert.equal(unconfirmed.status, 400);
  lib.writeItem('theme', 'handmade', 'mine');
  const notOurs = await request('POST', '/api/marketplace/update', { headers: authed(), body: { type: 'theme', name: 'handmade' } });
  assert.equal(notOurs.status, 404);
});

test('the update check with nothing installed from the marketplace asks nobody', async () => {
  const res = await request('GET', '/api/marketplace/updates', { headers: authed() });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { updates: [] });
});
