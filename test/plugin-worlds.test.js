const { test } = require('node:test');
const assert = require('node:assert/strict');
const { injectEverything, pluginWorldName } = require('../dist/injector/index');

// a stand-in for one Notion tab's CDP session: records every call, answers what injectEverything asks
function fakeTab() {
  const calls = [];
  let nextContext = 10;
  const worlds = new Map();
  return {
    calls,
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
      if (method === 'Page.createIsolatedWorld') {
        if (!worlds.has(params.worldName)) worlds.set(params.worldName, nextContext++);
        return { executionContextId: worlds.get(params.worldName) };
      }
      return { result: { value: false } };
    },
  };
}

const quiet = fn => async () => {
  const { log, error } = console;
  console.log = console.error = () => {};
  try { await fn(); } finally { Object.assign(console, { log, error }); }
};

test('an isolated plugin is evaluated only in its own world, a page-scripts plugin only in the page', quiet(async () => {
  const tab = fakeTab();
  await injectEverything('', [
    { name: 'apart', content: 'APART_CODE', isolated: true, settings: { a: 1 } },
    { name: 'page', content: 'PAGE_CODE', isolated: false },
  ], tab);

  const worlds = tab.calls.filter(c => c.method === 'Page.createIsolatedWorld').map(c => c.params);
  assert.deepEqual(worlds, [{ frameId: 'main-frame', worldName: pluginWorldName('apart'), grantUniveralAccess: false }]);

  const evals = tab.calls.filter(c => c.method === 'Runtime.evaluate').map(c => c.params);
  const apart = evals.filter(p => p.expression.includes('APART_CODE'));
  assert.equal(apart.length, 1);
  assert.equal(apart[0].contextId, 10, 'in its own world');
  const page = evals.filter(p => p.expression.includes('PAGE_CODE'));
  assert.equal(page.length, 1);
  assert.equal(page[0].contextId, undefined, 'in the page');

  // its world gets its own notiskin and its settings before the plugin runs
  const inWorld = evals.filter(p => p.contextId === 10).map(p => p.expression);
  const core = inWorld.findIndex(e => e.includes('if (!window.notiskin)'));
  const settings = inWorld.findIndex(e => e.includes('__updateSettings("apart"'));
  const code = inWorld.findIndex(e => e.includes('APART_CODE'));
  assert.ok(core >= 0 && core < settings && settings < code, 'core API, then settings, then the plugin');
  assert.ok(!evals.some(p => p.contextId === undefined && p.expression.includes('__updateSettings("apart"')), 'its settings never go to the page');
}));

test('with only isolated plugins the page itself gets no notiskin', quiet(async () => {
  const tab = fakeTab();
  await injectEverything('', [{ name: 'a', content: 'A', isolated: true }, { name: 'b', content: 'B', isolated: true }], tab);
  const pageCore = tab.calls.filter(c => c.method === 'Runtime.evaluate' && c.params.contextId === undefined && c.params.expression.includes('if (!window.notiskin)'));
  assert.equal(pageCore.length, 0);
  assert.equal(tab.calls.filter(c => c.method === 'Page.getFrameTree').length, 1, 'the frame is looked up once per pass');
  const contexts = new Set(tab.calls.filter(c => c.params.contextId !== undefined).map(c => c.params.contextId));
  assert.deepEqual([...contexts], [10, 11], 'one world each');
}));
