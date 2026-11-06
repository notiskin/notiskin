// Starts the real GUI server (dist/gui/server.js) on port 3845 for the browser tests, in a throwaway
// data folder, with everything that could touch the outside world replaced:
//   - Supabase: the server's and the page's requests to the marketplace go to the fake below
//   - Notion: notionSetup, applyConfig, previewTheme, isNotionRunning, quitNotion are fakes, and fake
//     `pkill`, `pgrep`, `open`, `osascript` ... come first on PATH, so even a call nobody thought of
//     can't close Notion or open a browser. They only write to fakebin.log
//   - the default browser (authBrowser, folderPicker) and the network (anything but 127.0.0.1 is refused)
// A second tiny server on port 3846 is how the tests seed state (POST /reset) and read what was called
// (GET /calls). Run by Playwright (playwright.config.js), `npm run test:browser`
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notiskin-browser-'));
process.env.NOTISKIN_DIR = dir;
process.env.NOTISKIN_NOTION_APP = path.join(dir, 'no-notion', 'Notion.app');

// ---- fake commands first on PATH ----
const bin = path.join(dir, 'fakebin');
const binLog = path.join(dir, 'fakebin.log');
fs.mkdirSync(bin, { recursive: true });
for (const [name, code] of [['pkill', 1], ['pgrep', 1], ['killall', 1], ['open', 0], ['osascript', 1], ['launchctl', 1], ['codesign', 1], ['xattr', 0], ['security', 1]]) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${binLog}"\nexit ${code}\n`, { mode: 0o755 });
}
process.env.PATH = `${bin}:${process.env.PATH}`;

const { SUPABASE_URL } = require(path.join(root, 'dist', 'utils', 'constants'));
const SUPABASE_ORIGIN = new URL(SUPABASE_URL).origin;

// ---- state the tests set up ----
let calls;
let sb;
let notion;

function freshState() {
  calls = { applyConfig: [], notionRun: [], notionOther: [], authOpen: [], supabase: [], open: [], unhandled: [] };
  sb = {
    // approved marketplace items by table, and what item_statuses() answers (id -> {status, version})
    items: { themes: [], plugins: [] },
    statuses: { theme: {}, plugin: {} },
    itemVersions: [],
    // the signed-in user, null = signed out. submissions: the user's own rows
    user: null,
    submissions: { themes: [], plugins: [] },
    // edge function answers by name: { status, json }
    functions: {},
  };
  notion = { status: 'not-installed', running: false, packaged: false, otherCopy: false, runResult: 'ok', runError: 'Something failed' };
}
freshState();

// ---- fake Supabase ----
function respond(status, json) {
  return { status, json };
}

function fakeSupabase({ method, url: rawUrl, headers = {}, body }) {
  const url = new URL(rawUrl);
  const p = url.pathname;
  const params = url.searchParams;
  const auth = headers.authorization || headers.Authorization || '';
  const wantsObject = String(headers.accept || headers.Accept || '').includes('pgrst.object');
  calls.supabase.push({ method, path: p, query: url.search, body: body || null, // supabase-js always sends the publishable key as a bearer token, a signed-in request carries the user's
    auth: auth === 'Bearer fake-access-token' ? 'user' : auth ? 'anon' : '' });

  const table = p.match(/^\/rest\/v1\/(themes|plugins)$/)?.[1];
  if (table) {
    if (method === 'DELETE') {
      const id = (params.get('id') || '').replace(/^eq\./, '');
      sb.submissions[table] = sb.submissions[table].filter(s => String(s.id) !== id);
      return respond(200, [{ id }]);
    }
    let rows = params.get('author_github') ? sb.submissions[table] : sb.items[table];
    const idFilter = params.get('id');
    if (idFilter?.startsWith('eq.')) rows = rows.filter(r => String(r.id) === idFilter.slice(3));
    if (idFilter?.startsWith('in.')) {
      const ids = idFilter.slice(4, -1).split(',').map(s => s.replace(/"/g, ''));
      rows = rows.filter(r => ids.includes(String(r.id)));
    }
    if (wantsObject) return rows[0] ? respond(200, rows[0]) : respond(406, { code: 'PGRST116', message: 'no rows' });
    return respond(200, rows);
  }
  if (p === '/rest/v1/rpc/item_statuses') {
    const input = JSON.parse(body || '{}');
    const known = sb.statuses[input.p_item_type] || {};
    return respond(200, (input.p_ids || []).filter(id => known[id]).map(id => ({ id, status: known[id].status, version: known[id].version })));
  }
  if (p === '/rest/v1/item_versions') return respond(200, sb.itemVersions);
  if (p === '/auth/v1/user') return sb.user ? respond(200, sb.user) : respond(401, { message: 'not signed in' });
  if (p === '/auth/v1/token') {
    // the code exchange at the end of sign-in
    return sb.user ? respond(200, sessionFor(sb.user)) : respond(400, { error: 'no user' });
  }
  if (p === '/auth/v1/logout') return respond(204, null);
  const fn = p.match(/^\/functions\/v1\/([a-z-]+)$/)?.[1];
  if (fn) return sb.functions[fn] ? respond(sb.functions[fn].status, sb.functions[fn].json) : respond(200, { ok: true, success: true });
  calls.unhandled.push(`${method} ${p}`);
  return respond(404, { message: `the browser-test fake does not handle ${method} ${p}` });
}

function sessionFor(user) {
  return { access_token: 'fake-access-token', refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user };
}

// the server's own requests (search, install, submissions, edge functions) go through fetch
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, 'http://127.0.0.1/');
  if (url.origin === SUPABASE_ORIGIN) {
    const headers = {};
    new Headers(init.headers || (typeof input === 'object' && input.headers) || {}).forEach((v, k) => { headers[k] = v; });
    const reply = fakeSupabase({ method: (init.method || 'GET').toUpperCase(), url: url.href, headers, body: typeof init.body === 'string' ? init.body : null });
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.json), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  throw new Error(`browser tests refuse a request to ${url.origin}`);
};

// ---- Notion and the machine, faked before the server is loaded ----
const lib = require(path.join(root, 'dist', 'core', 'library'));
lib.applyConfig = async opts => { calls.applyConfig.push(opts || {}); return true; };
lib.previewTheme = async () => ({ ok: true, live: false });
lib.endThemePreview = async () => ({ ok: true, live: false });
lib.isNotionRunning = () => notion.running;
lib.quitNotion = async () => { throw new Error('browser tests must never quit Notion'); };

const server = require(path.join(root, 'dist', 'gui', 'server'));
// the server limits how often one address may submit or report (5 in 15 minutes). Every test says it comes from
// its own address (X-Forwarded-For), so the limit is not what makes a long run fail
server.app.set('trust proxy', true);
server.notionSetup.platform = () => 'darwin';
server.notionSetup.status = () => notion.status;
server.notionSetup.legacy = () => false;
server.notionSetup.packaged = () => notion.packaged;
server.notionSetup.otherCopy = () => notion.otherCopy;
server.notionSetup.watcherIsOurs = () => false;
server.notionSetup.installWatcher = () => { calls.notionOther.push('installWatcher'); };
server.notionSetup.removeWatcher = () => { calls.notionOther.push('removeWatcher'); };
server.notionSetup.run = async action => {
  calls.notionRun.push(action);
  if (notion.runResult !== 'ok') return { status: 'error', message: notion.runError, output: notion.runResult === 'app-management' ? 'Operation not permitted (EPERM)' : notion.runError };
  notion.status = action === 'patch' ? 'installed' : 'not-installed';
  return { status: 'ok', output: '' };
};
server.notionSetup.restart = async () => { calls.notionOther.push('restart'); };
server.notionSetup.openAppManagement = async () => { calls.notionOther.push('openAppManagement'); };
server.authBrowser.open = async url => { calls.authOpen.push(url); };

// ---- the control server for the tests ----
function seedFiles(spec) {
  for (const sub of ['themes', 'plugins']) {
    fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  for (const f of ['notiskin.config.json', 'installed.json', 'debug.log']) fs.rmSync(path.join(dir, f), { force: true });
  for (const [name, css] of Object.entries(spec.themes || {})) fs.writeFileSync(path.join(dir, 'themes', `${name}.css`), css);
  for (const [name, code] of Object.entries(spec.plugins || {})) fs.writeFileSync(path.join(dir, 'plugins', `${name}.js`), code);
  // the tour starts on its own for a config that never finished it, tests that don't want it say setupDone
  fs.writeFileSync(path.join(dir, 'notiskin.config.json'), JSON.stringify({ setupDone: true, ...(spec.config || {}) }));
  if (spec.installed) fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify(spec.installed));
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => resolve(data));
  });
}

const control = http.createServer(async (req, res) => {
  const send = (status, json) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  };
  try {
    if (req.url === '/health') return send(200, { ok: true });
    if (req.url === '/calls') {
      let fakebin = [];
      try { fakebin = fs.readFileSync(binLog, 'utf-8').split('\n').filter(Boolean); } catch {}
      let config = null;
      try { config = JSON.parse(fs.readFileSync(path.join(dir, 'notiskin.config.json'), 'utf-8')); } catch {}
      return send(200, { ...calls, fakebin, config, themeFiles: fs.readdirSync(path.join(dir, 'themes')), pluginFiles: fs.readdirSync(path.join(dir, 'plugins')),
        // what the files say, by file name
        contents: Object.fromEntries(['themes', 'plugins'].flatMap(sub => fs.readdirSync(path.join(dir, sub)).map(f => [`${sub}/${f}`, fs.readFileSync(path.join(dir, sub, f), 'utf-8')]))) });
    }
    const body = JSON.parse((await readBody(req)) || '{}');
    if (req.url === '/reset') {
      freshState();
      fs.rmSync(binLog, { force: true });
      Object.assign(sb, body.supabase || {});
      Object.assign(notion, body.notion || {});
      seedFiles(body);
      server.clearMarketplaceCache();
      return send(200, { ok: true });
    }
    if (req.url === '/set-user') {
      sb.user = body;
      return send(200, { ok: true });
    }
    if (req.url === '/supabase') {
      const reply = fakeSupabase(body);
      return send(200, reply);
    }
    send(404, { error: 'unknown' });
  } catch (err) {
    send(500, { error: String(err && err.message) });
  }
});

control.listen(3846, '127.0.0.1', () => {
  server.startServer(false).then(
    () => console.log(`browser-test harness ready, data in ${dir}`),
    err => { console.error(err.message); process.exit(1); }
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); });
