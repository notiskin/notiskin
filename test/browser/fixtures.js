// What every browser test gets: `ns` to seed the fake world and read what it was asked to do, and a `page` that
// can only talk to the local server and the fake Supabase, and that fails the test on a console error
// (which is where a Content Security Policy violation shows up) or an uncaught exception
const base = require('@playwright/test');

const CONTROL = 'http://127.0.0.1:3846';
let testCount = 0;
const SESSION_KEY = 'sb-rdsoztlxtbfwdjcfqhmt-auth-token';

async function control(path, body) {
  const res = await fetch(CONTROL + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

function githubUser(name = 'tester') {
  return { id: `user-${name}`, aud: 'authenticated', role: 'authenticated', email: `${name}@example.com`, identities: [{ provider: 'github', identity_data: { user_name: name } }] };
}

function sessionFor(user) {
  return { access_token: 'fake-access-token', refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user };
}

// a marketplace row as Browse draws it
function item(overrides = {}) {
  return {
    id: 'item-1', name: 'sunset', description: 'Warm evening colors', author_github: 'someone', version: 1,
    css: ':root { --ns-bg: #fff3e0; }', js: '// plugin\nnotiskin.ready(() => {});\n',
    avg_rating: 4.5, rating_count: 2, download_count: 7, tags: ['light'], link: null, status: 'approved',
    created_at: '2026-10-01T00:00:00Z', ...overrides,
  };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, PATCH, OPTIONS',
};

exports.test = base.test.extend({
  ns: async ({}, use) => { // eslint-disable-line no-empty-pattern
    await use({
      // wipes everything and seeds: { themes: {name: css}, plugins: {name: code}, config, installed, supabase, notion }
      reset: spec => control('/reset', spec || {}),
      calls: () => control('/calls'),
      // the account the fake Supabase hands out when a sign-in finishes
      signInAs: name => control('/set-user', githubUser(name)),
      githubUser,
      item,
    });
  },

  page: async ({ page, context, ns }, use, testInfo) => {
    await ns.reset();
    // a fresh address for each test, see the harness (the server's rate limits count per address)
    testCount += 1;
    await context.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${Math.floor(testCount / 250) % 250}.${testCount % 250}.1` });
    await context.route(url => !/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url.href), async route => {
      const request = route.request();
      if (!request.url().includes('.supabase.co')) return route.abort('blockedbyclient');
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const reply = await control('/supabase', { method: request.method(), url: request.url(), headers: request.headers(), body: request.postData() });
      return route.fulfill({ status: reply.status, headers: { ...CORS, 'content-type': 'application/json' }, body: reply.json === null ? '' : JSON.stringify(reply.json) });
    });
    const problems = [];
    page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
    page.on('pageerror', error => problems.push(`uncaught: ${error.message}`));
    // each test says which errors it expects (a 404 it provokes on purpose, say)
    page.expectErrors = pattern => { page.allowed = [...(page.allowed || []), pattern]; };
    page.signIn = async (name = 'tester') => {
      const user = githubUser(name);
      await control('/set-user', user);
      await page.addInitScript(([key, session]) => localStorage.setItem(key, JSON.stringify(session)), [SESSION_KEY, sessionFor(user)]);
      return user;
    };
    await use(page);
    const unexpected = problems.filter(text => !/Transition was skipped/.test(text) && !(page.allowed || []).some(re => re.test(text)));
    base.expect(unexpected, `console errors on ${testInfo.title}`).toEqual([]);
    // the fake commands are a safety net: nothing a test does may try to close Notion or touch the system
    const { fakebin } = await ns.calls();
    base.expect(fakebin.filter(line => /^(pkill|killall|launchctl|osascript|codesign|security|xattr)\b/.test(line)), 'commands that must never run').toEqual([]);
  },
});

exports.expect = base.expect;
exports.githubUser = githubUser;
exports.item = item;
exports.control = control;
