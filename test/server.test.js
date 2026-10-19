require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app, sanitizeSearch, notionSetup, setupFailureReason, appManagementName } = require('../dist/gui/server');

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

// the Install into Notion endpoints, with the platform and the CLI run mocked
function mockNotionSetup({ platform = 'darwin', status = 'not-installed', run, restart } = {}) {
  const calls = [];
  notionSetup.platform = () => platform;
  notionSetup.status = () => status;
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
