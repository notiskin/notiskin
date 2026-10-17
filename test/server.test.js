require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app, sanitizeSearch } = require('../dist/gui/server');

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
  assert.deepEqual(res.json, { activeTheme: null, themes: [], plugins: [] });
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
