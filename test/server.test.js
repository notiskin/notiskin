require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app, sanitizeSearch, notionSetup, setupFailureReason, appManagementName, repairLegacyWrapper, ensureWatcher, marketplaceRemote, clearMarketplaceCache } = require('../dist/gui/server');

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
  assert.deepEqual(res.json, { updates: [], pulled: [] });
});

// installs marketplace files straight to disk and fakes Supabase's answers, restoring both afterwards
async function withFakeMarketplace(remote, fn) {
  const lib = require('../dist/core/library');
  const mp = require('../dist/core/marketplace');
  const saved = { ...marketplaceRemote };
  const calls = [];
  for (const key of ['statuses', 'approved', 'changes']) {
    marketplaceRemote[key] = async (type, ids) => {
      calls.push([key, type, ids.length]);
      return remote[key] ? remote[key](type, ids) : [];
    };
  }
  clearMarketplaceCache();
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const names = ['live', 'newer', 'hidden-one', 'rejected-one', 'removed-one'];
  names.forEach((name, i) => mp.installFromMarketplace('plugin', { id: id(i + 1), name, code: '1', version: 1 }));
  try {
    await fn(calls, id);
  } finally {
    Object.assign(marketplaceRemote, saved);
    clearMarketplaceCache();
    for (const name of names) lib.deleteItem('plugin', name);
  }
}

test('the update check finds updates and installed plugins that were pulled, in one call per type', async () => {
  await withFakeMarketplace({
    statuses: (_type, ids) => [
      { id: ids[0], status: 'approved', version: 1 },
      { id: ids[1], status: 'approved', version: 2 },
      { id: ids[2], status: 'hidden', version: 1 },
      { id: ids[3], status: 'rejected', version: 1 },
    ],
    changes: (_type, ids) => [{ item_id: ids[1], version: 2, changelog: 'faster' }],
  }, async (calls, id) => {
    const res = await request('GET', '/api/marketplace/updates', { headers: authed() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.updates.map(u => [u.name, u.latestVersion, u.changes[0].changelog]), [['newer', 2, 'faster']]);
    assert.deepEqual(res.json.pulled, [
      { type: 'plugin', name: 'hidden-one', id: id(3), reason: 'hidden' },
      { type: 'plugin', name: 'rejected-one', id: id(4), reason: 'rejected' },
      { type: 'plugin', name: 'removed-one', id: id(5), reason: 'removed' },
    ]);
    assert.deepEqual(calls, [['statuses', 'plugin', 5], ['changes', 'plugin', 5]]);
    // asked again within half an hour, the answer comes from the cache
    await request('GET', '/api/marketplace/updates', { headers: authed() });
    assert.equal(calls.length, 2);
  });
});

test('before item_statuses() is deployed the update check still works and calls nothing pulled', async () => {
  await withFakeMarketplace({
    statuses: () => null,
    approved: (_type, ids) => [{ id: ids[1], version: 3 }],
  }, async calls => {
    const res = await request('GET', '/api/marketplace/updates', { headers: authed() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.updates.map(u => [u.name, u.latestVersion]), [['newer', 3]]);
    assert.deepEqual(res.json.pulled, []);
    assert.deepEqual(calls.map(c => c[0]), ['statuses', 'changes', 'approved']);
  });
});

test('a Supabase error is a 502 and is not cached', async () => {
  let fail = true;
  await withFakeMarketplace({
    statuses: (_type, ids) => {
      if (fail) throw new Error('offline');
      return ids.map(id => ({ id, status: 'approved', version: 1 }));
    },
  }, async () => {
    const res = await request('GET', '/api/marketplace/updates', { headers: authed() });
    assert.equal(res.status, 502);
    fail = false;
    const again = await request('GET', '/api/marketplace/updates', { headers: authed() });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.pulled, []);
  });
});

test('browser sign-in: only a GitHub PKCE sign-in link on our Supabase project can be opened', () => {
  const { isSupabaseSignInUrl } = require('../dist/gui/server');
  const { SUPABASE_URL } = require('../dist/utils/constants');
  const good = `${SUPABASE_URL}/auth/v1/authorize?provider=github&redirect_to=x&code_challenge=abc&code_challenge_method=s256`;
  assert.equal(isSupabaseSignInUrl(good), true);
  for (const bad of [
    good.replace('https:', 'http:'),
    good.replace('provider=github', 'provider=google'),
    good.replace('&code_challenge=abc', ''),
    good.replace('/auth/v1/authorize', '/auth/v1/logout'),
    'https://evil.example/auth/v1/authorize?provider=github&code_challenge=abc&code_challenge_method=s256',
    'javascript:alert(1)',
    undefined,
  ]) {
    assert.equal(isSupabaseSignInUrl(bad), false, String(bad));
  }
});

test('browser sign-in: start opens the browser, the callback code is handed out once', async () => {
  const { authBrowser } = require('../dist/gui/server');
  const { SUPABASE_URL } = require('../dist/utils/constants');
  const opened = [];
  const realOpen = authBrowser.open;
  authBrowser.open = async url => { opened.push(url); };
  try {
    const url = `${SUPABASE_URL}/auth/v1/authorize?provider=github&code_challenge=abc&code_challenge_method=s256`;
    const refused = await request('POST', '/api/auth/start', { headers: authed(), body: { url: 'https://evil.example/' } });
    assert.equal(refused.status, 400);
    assert.deepEqual(opened, []);

    const start = await request('POST', '/api/auth/start', { headers: authed(), body: { url } });
    assert.equal(start.status, 200);
    assert.deepEqual(opened, [url]);
    assert.equal((await request('GET', '/api/auth/result', { headers: authed() })).json.state, 'waiting');

    const page = await request('GET', '/auth/callback?code=0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
    assert.equal(page.status, 200);
    assert.match(page.text, /signed in/);
    const done = await request('GET', '/api/auth/result', { headers: authed() });
    assert.deepEqual(done.json, { state: 'done', code: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' });
    assert.equal((await request('GET', '/api/auth/result', { headers: authed() })).json.state, 'idle');

    // a callback nobody is waiting for is ignored
    const late = await request('GET', '/auth/callback?code=0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
    assert.equal(late.status, 400);
    assert.equal((await request('GET', '/api/auth/result', { headers: authed() })).json.state, 'idle');
  } finally {
    authBrowser.open = realOpen;
  }
});

test('browser sign-in: a cancelled or broken callback is reported, and cancel clears it', async () => {
  const { authBrowser } = require('../dist/gui/server');
  const { SUPABASE_URL } = require('../dist/utils/constants');
  const realOpen = authBrowser.open;
  authBrowser.open = async () => {};
  try {
    const url = `${SUPABASE_URL}/auth/v1/authorize?provider=github&code_challenge=abc&code_challenge_method=s256`;
    await request('POST', '/api/auth/start', { headers: authed(), body: { url } });
    const page = await request('GET', '/auth/callback?error=access_denied&error_description=The+user+denied+access');
    assert.equal(page.status, 400);
    assert.deepEqual((await request('GET', '/api/auth/result', { headers: authed() })).json, { state: 'failed', error: 'The user denied access' });

    await request('POST', '/api/auth/start', { headers: authed(), body: { url } });
    const odd = await request('GET', '/auth/callback?code=<script>');
    assert.equal(odd.status, 400);
    assert.equal((await request('GET', '/api/auth/result', { headers: authed() })).json.state, 'failed');

    await request('POST', '/api/auth/start', { headers: authed(), body: { url } });
    await request('POST', '/api/auth/cancel', { headers: authed() });
    assert.equal((await request('GET', '/api/auth/result', { headers: authed() })).json.state, 'idle');
  } finally {
    authBrowser.open = realOpen;
  }
});

test('browser sign-in routes need the session token', async () => {
  assert.equal((await request('GET', '/api/auth/result')).status, 403);
  assert.equal((await request('POST', '/api/auth/start', { body: { url: 'x' } })).status, 403);
});

test('the theme editor script is served, and the Themes page loads it', async () => {
  const res = await request('GET', '/theme-editor.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.text, /nsThemeEditor/);
  assert.match((await request('GET', '/')).text, /<script src="\/theme-editor\.js"><\/script>/);
});

test('theme editor: save writes a theme file, reads it back, and never overwrites by accident', async () => {
  const { readFileSync } = require('fs');
  const lib = require('../dist/core/library');
  const css = ':root {\n  --ns-bg: #123456;\n}\n';

  assert.equal((await request('GET', '/api/theme-editor/Mine', { headers: authed() })).status, 404);

  const saved = await request('POST', '/api/theme-editor/save', { headers: authed(), body: { name: 'Mine', css } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  assert.equal(readFileSync(lib.itemPath('theme', 'Mine'), 'utf-8'), css);

  const read = await request('GET', '/api/theme-editor/Mine', { headers: authed() });
  assert.deepEqual(read.json, { name: 'Mine', css, fromMarketplace: false });

  // a second new theme with the same name asks first, a replace says so
  const again = await request('POST', '/api/theme-editor/save', { headers: authed(), body: { name: 'Mine', css: ':root { --ns-bg: red; }' } });
  assert.equal(again.status, 409);
  assert.equal(again.json.reason, 'exists');
  assert.equal(readFileSync(lib.itemPath('theme', 'Mine'), 'utf-8'), css);
  const replaced = await request('POST', '/api/theme-editor/save', { headers: authed(), body: { name: 'Mine', css: ':root { --ns-bg: red; }', replace: true } });
  assert.equal(replaced.status, 200);
  assert.match(readFileSync(lib.itemPath('theme', 'Mine'), 'utf-8'), /red/);
  lib.deleteItem('theme', 'Mine');
});

test('theme editor: bad names, empty CSS and files from the marketplace are refused', async () => {
  const lib = require('../dist/core/library');
  const { recordInstall } = require('../dist/core/installed');
  const post = body => request('POST', '/api/theme-editor/save', { headers: authed(), body });
  for (const name of ['', '../evil', '.hidden', 'a/b', 'x'.repeat(81), 42, undefined]) {
    assert.equal((await post({ name, css: ':root { --ns-bg: red; }' })).status, 400, JSON.stringify(name));
  }
  assert.equal((await post({ name: 'ok', css: '   ' })).status, 400);
  assert.equal((await post({ name: 'ok', css: 5 })).status, 400);
  assert.equal(lib.itemExists('theme', 'ok'), false);

  lib.writeItem('theme', 'from-store', ':root { --ns-bg: #fff; }');
  recordInstall('theme', 'from-store', { id: 'abc', version: 1 });
  const res = await post({ name: 'from-store', css: ':root { --ns-bg: red; }', replace: true });
  assert.equal(res.status, 409);
  assert.equal(res.json.reason, 'marketplace');
  assert.equal((await request('GET', '/api/theme-editor/from-store', { headers: authed() })).json.fromMarketplace, true);
  lib.deleteItem('theme', 'from-store');

  // the editor endpoints need the token like every other call, and path tricks never reach the disk
  assert.equal((await request('POST', '/api/theme-editor/save', { body: { name: 'a', css: 'x' } })).status, 403);
  assert.equal((await request('GET', '/api/theme-editor/..%2F..%2Fconfig', { headers: authed() })).status, 404);
});

test('theme editor: with no Notion running a preview says so and starts nothing', async () => {
  const res = await request('POST', '/api/theme-editor/preview', { headers: authed(), body: { css: ':root { --ns-bg: #fff; }' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, live: false });
  assert.equal((await request('POST', '/api/theme-editor/preview', { headers: authed(), body: { css: '' } })).status, 400);
  assert.equal((await request('POST', '/api/theme-editor/preview', { headers: authed(), body: {} })).status, 400);
  assert.equal((await request('POST', '/api/theme-editor/preview/end', { headers: authed() })).json.ok, true);
  assert.equal((await request('POST', '/api/theme-editor/preview', { body: { css: 'x' } })).status, 403);
});

test('theme editor: safe mode keeps the preview out of Notion', async () => {
  const { readConfig, writeConfig } = require('../dist/utils/config');
  writeConfig({ ...readConfig(), safeMode: true });
  try {
    const res = await request('POST', '/api/theme-editor/preview', { headers: authed(), body: { css: ':root { --ns-bg: #fff; }' } });
    assert.deepEqual(res.json, { ok: false, live: false, safeMode: true });
  } finally {
    writeConfig({ ...readConfig(), safeMode: false });
  }
});

const SETTINGS_PLUGIN = `/**
 * @notiskin-setting {"key":"size","type":"number","label":"Size","default":14,"min":8,"max":32}
 * @notiskin-setting {"key":"mode","type":"select","label":"Mode","default":"a","options":["a","b"]}
 * @notiskin-setting {"key":"broken","type":"nope","label":"Broken","default":1}
 */
console.log('never run by the server');
`;

test('plugin settings: only plugins that declare some get a Settings button, read without running them', async () => {
  const lib = require('../dist/core/library');
  lib.writeItem('plugin', 'with-settings', SETTINGS_PLUGIN);
  lib.writeItem('plugin', 'plain', 'console.log(1);');
  const list = await request('GET', '/api/plugins', { headers: authed() });
  assert.deepEqual(list.json.withSettings, ['with-settings']);

  const res = await request('GET', '/api/plugin-settings/with-settings', { headers: authed() });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.settings.map(s => s.key), ['size', 'mode']);
  assert.deepEqual(res.json.values, { size: 14, mode: 'a' });
  assert.equal(res.json.problems.length, 1, 'the broken line is reported, not fatal');
  assert.equal(res.json.enabled, false);
  assert.equal((await request('GET', '/api/plugin-settings/nope', { headers: authed() })).status, 404);
  assert.equal((await request('GET', '/api/plugin-settings/with-settings')).status, 403, 'needs the token');
});

test('plugin settings: saving checks every value against the declaration and keeps the rest', async () => {
  const { readConfig } = require('../dist/utils/config');
  const post = body => request('POST', '/api/plugin-settings/with-settings', { headers: authed(), body });

  const saved = await post({ values: { size: 20 } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.values, { size: 20, mode: 'a' });
  assert.deepEqual(readConfig().pluginSettings['with-settings'], { size: 20 });

  // a second save adds to it, it doesn't replace it
  assert.deepEqual((await post({ values: { mode: 'b' } })).json.values, { size: 20, mode: 'b' });
  assert.deepEqual(readConfig().pluginSettings['with-settings'], { size: 20, mode: 'b' });

  for (const values of [{ size: 99 }, { size: '20' }, { mode: 'z' }, { nope: 1 }, { broken: 1 }, { size: 20, mode: 'z' }]) {
    const res = await post({ values });
    assert.equal(res.status, 400, JSON.stringify(values));
    assert.ok(res.json.error);
  }
  for (const body of [{}, { values: 5 }, { values: [1] }, { values: null }]) assert.equal((await post(body)).status, 400);
  assert.deepEqual(readConfig().pluginSettings['with-settings'], { size: 20, mode: 'b' }, 'a refused save changes nothing');

  const reset = await post({ reset: true });
  assert.deepEqual(reset.json.values, { size: 14, mode: 'a' });
  assert.equal(readConfig().pluginSettings['with-settings'], undefined);
  assert.equal((await request('POST', '/api/plugin-settings/missing', { headers: authed(), body: { reset: true } })).status, 404);
  assert.equal((await request('POST', '/api/plugin-settings/with-settings', { body: { reset: true } })).status, 403);
});

test('plugin settings: deleting the plugin forgets its values', async () => {
  const lib = require('../dist/core/library');
  const { readConfig } = require('../dist/utils/config');
  await request('POST', '/api/plugin-settings/with-settings', { headers: authed(), body: { values: { size: 12 } } });
  assert.ok(readConfig().pluginSettings['with-settings']);
  await request('DELETE', '/api/plugins/with-settings', { headers: authed() });
  assert.equal(readConfig().pluginSettings['with-settings'], undefined);
  lib.deleteItem('plugin', 'plain');
});

test('developer mode: needs a real folder to turn on, and is saved with its folder', async () => {
  const { mkdtempSync, writeFileSync, rmSync, realpathSync } = require('fs');
  const { join } = require('path');
  const { tmpdir } = require('os');
  const { readConfig, writeConfig } = require('../dist/utils/config');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'notiskin-dev-srv-')));
  writeFileSync(join(dir, 'one.js'), `/**\n * @notiskin-setting {"key":"n","type":"number","label":"N","default":3}\n */\nconsole.log(1);`);
  writeFileSync(join(dir, 'two.js'), 'console.log(2);');
  const post = body => request('POST', '/api/developer', { headers: authed(), body });

  const start = await request('GET', '/api/developer', { headers: authed() });
  assert.deepEqual(start.json, { enabled: false, folder: '', error: null, skipped: [], plugins: [] });
  assert.equal((await request('GET', '/api/developer')).status, 403, 'needs the token');

  // refused: no folder, a relative one, one that is not there, a file, wrong types
  for (const body of [{ enabled: true }, { enabled: true, folder: 'relative' }, { enabled: true, folder: join(dir, 'nope') }, { enabled: true, folder: join(dir, 'one.js') }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  for (const body of [{ enabled: 'yes' }, { folder: 5 }]) assert.equal((await post(body)).status, 400);
  assert.equal(readConfig().developerMode, false);

  const on = await post({ enabled: true, folder: dir });
  assert.equal(on.status, 200);
  assert.deepEqual(on.json.plugins.map(p => [p.name, p.file, p.hasSettings]), [['dev/one', 'one.js', true], ['dev/two', 'two.js', false]]);
  assert.equal(readConfig().developerMode, true);
  assert.equal(readConfig().developerFolder, dir);

  // the Plugins page gets the same, and the installed list does not include them
  const list = await request('GET', '/api/plugins', { headers: authed() });
  assert.equal(list.json.dev.enabled, true);
  assert.equal(list.json.plugins.some(n => n.startsWith('dev/')), false);
  assert.equal(list.json.withSettings.some(n => n.startsWith('dev/')), false);

  // a developer plugin's settings work through the same routes, with the slash escaped
  const settings = await request('GET', '/api/plugin-settings/dev%2Fone', { headers: authed() });
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.json.values, { n: 3 });
  assert.equal(settings.json.enabled, true);
  const saved = await request('POST', '/api/plugin-settings/dev%2Fone', { headers: authed(), body: { values: { n: 7 } } });
  assert.deepEqual(saved.json.values, { n: 7 });
  assert.deepEqual(readConfig().pluginSettings['dev/one'], { n: 7 });
  assert.equal((await request('GET', '/api/plugin-settings/dev%2Fmissing', { headers: authed() })).status, 404);

  // off keeps the folder, and its plugins no longer have settings routes
  const off = await post({ enabled: false });
  assert.equal(off.json.enabled, false);
  assert.equal(readConfig().developerFolder, dir);
  assert.equal((await request('GET', '/api/plugin-settings/dev%2Fone', { headers: authed() })).status, 404);

  // a folder can be remembered while it is off, an empty one forgets it
  assert.equal((await post({ folder: '' })).json.folder, '');
  writeConfig({ ...readConfig(), pluginSettings: {}, developerMode: false, developerFolder: '' });
  rmSync(dir, { recursive: true });
});

test('developer mode: the folder picker is only offered inside the desktop app', async () => {
  const { folderPicker } = require('../dist/gui/server');
  const original = folderPicker.choose;
  try {
    assert.deepEqual((await request('POST', '/api/developer/choose-folder', { headers: authed() })).json, { ok: false, unsupported: true });
    folderPicker.choose = async () => '/Users/me/plugins';
    assert.deepEqual((await request('POST', '/api/developer/choose-folder', { headers: authed() })).json, { ok: true, folder: '/Users/me/plugins' });
    folderPicker.choose = async () => null;
    assert.deepEqual((await request('POST', '/api/developer/choose-folder', { headers: authed() })).json, { ok: true, folder: null });
    assert.equal((await request('POST', '/api/developer/choose-folder')).status, 403);
  } finally {
    folderPicker.choose = original;
  }
});
