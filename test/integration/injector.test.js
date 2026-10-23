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
    canPreview: () => !readConfig().safeMode,
    // what `notiskin inject` passes: developer mode's folder, never in safe mode
    devFolder: () => {
      const c = readConfig();
      return c.developerMode && !c.safeMode && c.developerFolder ? c.developerFolder : null;
    },
    // short so the test can watch a preview run out
    previewTtlMs: 1500,
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

const COLORS = `(() => {
  const c = id => getComputedStyle(document.getElementById(id)).color;
  const bg = id => getComputedStyle(document.getElementById(id)).backgroundColor;
  return { plain: c('plain'), red: c('red-text'), highlight: c('highlight'), highlightBg: bg('highlight'),
    blueChild: c('blue-child'), redBg: bg('red-bg') };
})()`;

test('plain text takes the theme color, text Notion colored keeps its own', { skip }, async () => {
  lib.writeItem('theme', 'Test', ':root { --ns-text: rgb(9, 9, 9); }');
  await everyPage(s => /rgb\(9, 9, 9\)/.test(s.theme ?? ''), 'the text color theme');
  for (const w of await evalAll(COLORS)) {
    assert.equal(w.value.plain, 'rgb(9, 9, 9)');
    assert.equal(w.value.red, 'rgb(200, 0, 0)');
    assert.equal(w.value.highlight, 'rgb(200, 0, 0)');
    assert.equal(w.value.blueChild, 'rgb(0, 0, 200)', 'text inside a colored block');
    assert.equal(w.value.redBg, 'rgb(250, 200, 200)', 'a block Notion colored');
  }
});

test('a theme can set the colored text palette', { skip }, async () => {
  lib.writeItem('theme', 'Test', `:root {
    --ns-text: rgb(9, 9, 9);
    --ns-color-red: rgb(0, 128, 0);
    --ns-color-red-bg: rgb(1, 2, 3);
    --ns-color-blue: rgb(5, 5, 5);
    --ns-color-yellow-bg: rgb(7, 7, 7);
  }`);
  await everyPage(s => /--ns-color-red/.test(s.theme ?? ''), 'the palette theme');
  for (const w of await evalAll(COLORS)) {
    assert.equal(w.value.plain, 'rgb(9, 9, 9)');
    assert.equal(w.value.red, 'rgb(0, 128, 0)');
    assert.equal(w.value.highlight, 'rgb(0, 128, 0)');
    assert.equal(w.value.highlightBg, 'rgb(7, 7, 7)');
    assert.equal(w.value.blueChild, 'rgb(5, 5, 5)', 'inside a block the theme recolored');
    assert.equal(w.value.redBg, 'rgb(1, 2, 3)');
  }
  lib.writeItem('theme', 'Test', ':root { --ns-bg: #abcdef; }');
  await everyPage(s => /#abcdef/.test(s.theme ?? '') && s.theme.length < 100, 'the theme back');
});

const LOOK = `(() => {
  const st = id => getComputedStyle(document.getElementById(id));
  return {
    headerBg: st('th').backgroundColor, headerImage: st('th').backgroundImage,
    cellBorder: st('tc').borderBottomColor,
    cardBg: st('card').backgroundColor, cardImage: st('card').backgroundImage, cardRadius: st('card').borderTopLeftRadius,
    calloutBorder: st('callout').borderTopColor, calloutRadius: st('callout').borderTopLeftRadius,
    rootFont: getComputedStyle(document.querySelector('.notion-app-inner')).fontFamily,
    titleFont: st('title-block').fontFamily, codeFont: st('code').fontFamily,
    dark: matchMedia('(prefers-color-scheme: dark)').matches, plain: st('plain').color,
  };
})()`;

const setTheme = async (css, expect) => {
  lib.writeItem('theme', 'Test', css);
  await everyPage(s => (s.theme ?? '').includes(expect), `the theme with ${expect}`);
};

test('a theme that sets none of the new variables changes nothing about databases, borders or fonts', { skip }, async () => {
  await setTheme(':root { --ns-bg: #abcdef; }', '#abcdef');
  for (const w of await evalAll(LOOK)) {
    const v = w.value;
    assert.equal(v.headerBg, 'rgb(10, 10, 10)');
    assert.match(v.headerImage, /linear-gradient\(rgba\(0, 0, 0, 0\), rgba\(0, 0, 0, 0\)\)/, 'a transparent layer, no visible change');
    assert.equal(v.cellBorder, 'rgb(20, 20, 20)');
    assert.equal(v.cardBg, 'rgb(40, 40, 40)');
    assert.equal(v.cardRadius, '10px');
    assert.equal(v.calloutBorder, 'rgb(30, 30, 30)');
    assert.equal(v.calloutRadius, '10px');
    assert.match(v.titleFont, /^ui-sans-serif/);
    assert.match(v.codeFont, /SFMono-Regular/);
  }
});

test('border color, radius and database colors', { skip }, async () => {
  await setTheme(`:root {
    --ns-border-color: rgb(1, 2, 3);
    --ns-radius: 3px;
    --ns-table-header-bg: rgb(4, 5, 6);
    --ns-board-card-bg: rgb(7, 8, 9);
  }`, '--ns-board-card-bg');
  for (const w of await evalAll(LOOK)) {
    const v = w.value;
    assert.equal(v.cellBorder, 'rgb(1, 2, 3)');
    assert.equal(v.calloutBorder, 'rgb(1, 2, 3)');
    assert.equal(v.calloutRadius, '3px');
    assert.equal(v.cardRadius, '3px');
    assert.match(v.headerImage, /rgb\(4, 5, 6\)/);
    assert.equal(v.headerBg, 'rgb(10, 10, 10)', "Notion's own background is still underneath");
    assert.match(v.cardImage, /rgb\(7, 8, 9\)/);
    assert.equal(v.cardBg, 'rgb(40, 40, 40)');
  }
});

test('fonts: quoted names reach the page, and only the font variables a theme sets are overridden', { skip }, async () => {
  await setTheme(':root { --ns-font: "Inter Display", Georgia, serif; }', 'Inter Display');
  for (const w of await evalAll(LOOK)) {
    assert.match(w.value.rootFont, /Inter Display/);
    assert.match(w.value.titleFont, /Inter Display/, 'titles follow the body font unless --ns-font-title is set');
    assert.match(w.value.codeFont, /SFMono-Regular/, 'code keeps its own font unless --ns-font-code is set');
  }
  await setTheme(':root { --ns-font-title: Georgia, serif; --ns-font-code: "Fira Code", monospace; }', 'Fira Code');
  for (const w of await evalAll(LOOK)) {
    assert.match(w.value.rootFont, /^ui-sans-serif/, 'body untouched');
    assert.match(w.value.titleFont, /^Georgia/);
    assert.match(w.value.codeFont, /Fira Code/);
  }
});

test('a prefers-color-scheme block in a theme follows the scheme the page is in', { skip }, async () => {
  await setTheme(`:root { --ns-text: rgb(1, 1, 1); }
@media (prefers-color-scheme: dark) { :root { --ns-text: rgb(2, 2, 2); } }
@media (prefers-color-scheme: light) { :root { --ns-text: rgb(3, 3, 3); } }`, 'prefers-color-scheme');
  for (const w of await evalAll(LOOK)) assert.equal(w.value.plain, w.value.dark ? 'rgb(2, 2, 2)' : 'rgb(3, 3, 3)');
  lib.writeItem('theme', 'Test', ':root { --ns-bg: #abcdef; }');
  await everyPage(s => /#abcdef/.test(s.theme ?? '') && s.theme.length < 100, 'the theme back');
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

test('the editor preview shows in every tab without touching the config, and ends when it is not repeated', { skip }, async () => {
  const before = JSON.stringify(readConfig());
  const css = ':root { --ns-bg: #13579b; }';
  const reply = await askInjector({ cmd: 'preview', css });
  assert.equal(reply.ok, true);
  assert.equal(reply.previewing, true);
  await everyPage(s => /#13579b/.test(s.theme ?? ''), 'the preview in every tab');
  assert.equal(JSON.stringify(readConfig()), before, 'the config is untouched');
  assert.match(lib.activeThemeCss(readConfig()), /#abcdef/, 'the theme file is untouched');
  assert.equal((await askInjector({ cmd: 'status' })).previewing, true);

  // the same request again is the editor's heartbeat, it keeps the preview alive past the 1.5 s limit
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, 700));
    assert.equal((await askInjector({ cmd: 'preview', css })).ok, true);
  }
  assert.ok((await states()).every(s => /#13579b/.test(s.theme ?? '')), 'still showing after 2 s of heartbeats');

  // nobody repeats it (the editor closed, the app quit): the theme comes back by itself
  await everyPage(s => /#abcdef/.test(s.theme ?? ''), 'the theme back after the preview ran out');
  assert.equal((await askInjector({ cmd: 'status' })).previewing, false);
});

test('ending the preview puts the theme back at once, a preview over a reload stays, and nothing restarts Notion', { skip }, async () => {
  const pid = fake.pid;
  await askInjector({ cmd: 'preview', css: ':root { --ns-bg: #24680a; }' });
  await everyPage(s => /#24680a/.test(s.theme ?? ''), 'the preview');
  await evalAll('location.reload()');
  const [state] = await everyPage(s => /#24680a/.test(s.theme ?? '') && s.styledAtStart, 'the preview after a reload, in place before the page ran');
  assert.match(state.styleAtStart, /#24680a/);

  const ended = await askInjector({ cmd: 'preview-end' });
  assert.equal(ended.ok, true);
  assert.equal(ended.previewing, false);
  await everyPage(s => /#abcdef/.test(s.theme ?? ''), 'the theme back');
  // ending twice, or with nothing running, is fine
  assert.equal((await askInjector({ cmd: 'preview-end' })).ok, true);
  assert.equal(fake.pid, pid);
  assert.ok(alive(pid), 'Notion kept running');
});

test('a preview is refused for empty CSS and in safe mode, and safe mode drops one that is showing', { skip }, async () => {
  assert.equal((await askInjector({ cmd: 'preview', css: '   ' })).ok, false);
  assert.equal((await askInjector({ cmd: 'preview' })).ok, false);

  await askInjector({ cmd: 'preview', css: ':root { --ns-bg: #35790c; }' });
  await everyPage(s => /#35790c/.test(s.theme ?? ''), 'the preview');
  writeConfig({ ...readConfig(), safeMode: true });
  assert.equal(await lib.applyConfig({ reload: true }), true);
  for (const s of await states()) assert.equal(s.theme, null, 'safe mode shows no theme and no preview');
  const refused = await askInjector({ cmd: 'preview', css: ':root { --ns-bg: #35790c; }' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Safe mode/);
  for (const s of await states()) assert.equal(s.theme, null);

  writeConfig({ ...readConfig(), safeMode: false });
  await askInjector({ cmd: 'preview-end' });
  await everyPage(s => /#abcdef/.test(s.theme ?? ''), 'the theme back');
});

const SETTINGS_PLUGIN = `/**
 * @notiskin-setting {"key":"size","type":"number","label":"Size","default":14,"min":8,"max":32}
 * @notiskin-setting {"key":"on","type":"toggle","label":"On","default":true}
 */
window.__demo = { runs: (window.__demo ? window.__demo.runs : 0) + 1, log: [], first: notiskin.settings.get('size'),
  all: notiskin.settings.getAll(), own: notiskin !== window.notiskin, version: notiskin.version, pageChange: typeof notiskin.onPageChange };
window.__demoOff = notiskin.settings.onChange((key, value, all) => { window.__demo.log.push([key, value, all.size, notiskin.settings.get('size')]); });
// a callback that runs later still reads this plugin's values
setTimeout(() => { window.__demo.later = notiskin.settings.get('on'); }, 0);
window.__demoGet = () => notiskin.settings.get('size');
`;

const demo = async () => (await evalAll('JSON.stringify(window.__demo || null)')).map(w => JSON.parse(w.value));

test('plugin settings: values reach the page with the plugin, and a change reaches it without a reload', { skip }, async () => {
  lib.writeItem('plugin', 'settings-demo', SETTINGS_PLUGIN);
  writeConfig({ ...readConfig(), enabledPlugins: ['counter', 'settings-demo'], pluginSettings: { 'settings-demo': { size: 20 } } });
  assert.equal(await lib.applyConfig(), true);
  await waitFor(async () => (await demo()).every(d => d && d.runs === 1), 'the plugin to run in every tab');
  for (const d of await demo()) {
    assert.equal(d.first, 20, 'the saved value, not the default');
    assert.deepEqual(d.all, { size: 20, on: true }, 'the default for what was never saved');
    assert.equal(d.own, true, 'it got its own notiskin');
    assert.equal(d.version, '1.1.0');
    assert.equal(d.pageChange, 'function', 'every existing method is still there');
    assert.equal(d.later, true, 'a callback later on reads the same plugin\'s values');
  }
  assert.ok((await states()).every(s => s.runs === 1), 'the plugin without settings ran once, as before');

  // a change made in the app: no reload, the plugin hears about the key that changed, and get() already has it
  await evalAll('window.__beforeReload = true');
  writeConfig({ ...readConfig(), pluginSettings: { 'settings-demo': { size: 24 } } });
  assert.equal(await lib.applyConfig(), true);
  await waitFor(async () => (await demo()).every(d => d.log.length === 1), 'onChange to fire');
  for (const d of await demo()) {
    assert.deepEqual(d.log, [['size', 24, 24, 24]]);
    assert.equal(d.runs, 1, 'the plugin did not run again');
  }
  assert.ok((await states()).every(s => s.marker === true), 'no reload');

  // the same values again change nothing and tell nobody
  assert.equal(await lib.applyConfig(), true);
  assert.ok((await demo()).every(d => d.log.length === 1));

  // stop listening: the next change only updates the value
  await evalAll('window.__demoOff()');
  writeConfig({ ...readConfig(), pluginSettings: { 'settings-demo': { size: 9 } } });
  assert.equal(await lib.applyConfig(), true);
  await waitFor(async () => (await evalAll('window.__demoGet()')).every(w => w.value === 9), 'the new value');
  assert.ok((await demo()).every(d => d.log.length === 1), 'nobody was told, nobody was listening');

  // safe mode pauses it with everything else, turning it off brings it back with the values
  writeConfig({ ...readConfig(), enabledPlugins: ['counter'] });
  lib.deleteItem('plugin', 'settings-demo');
  assert.equal(await lib.applyConfig({ reload: true }), true);
  assert.ok((await demo()).every(d => d === null), 'gone after a reload');
  assert.equal(readConfig().pluginSettings['settings-demo'], undefined);
});

test('a plugin that does not declare settings still runs in the global scope, with the real notiskin', { skip }, async () => {
  lib.writeItem('plugin', 'plain-global', 'var leaked = "global"; window.__plainSame = (notiskin === window.notiskin);');
  writeConfig({ ...readConfig(), enabledPlugins: ['counter', 'plain-global'] });
  assert.equal(await lib.applyConfig(), true);
  await waitFor(async () => (await evalAll('window.__plainSame')).every(w => w.value === true), 'the plain plugin');
  assert.ok((await evalAll('window.leaked')).every(w => w.value === 'global'), 'a top-level var is still a global');
  writeConfig({ ...readConfig(), enabledPlugins: ['counter'] });
  lib.deleteItem('plugin', 'plain-global');
  await lib.applyConfig();
});

test('developer mode: plugins run from the folder, a saved file reloads every tab, and turning it off lets go of the folder', { skip }, async () => {
  const { writeFileSync, mkdtempSync, rmSync } = require('fs');
  const dir = mkdtempSync(join(tmpdir(), 'notiskin-dev-int-'));
  const write = (file, text) => writeFileSync(join(dir, file), text);
  const version = async () => (await evalAll('window.__devVersion ?? null')).map(w => w.value);
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const marked = async () => (await states()).every(s => s.marker === true);

  write('hello.js', 'window.__devVersion = 1; window.__devRuns = (window.__devRuns || 0) + 1;');
  writeConfig({ ...readConfig(), developerMode: true, developerFolder: dir });
  assert.equal(await lib.applyConfig({ reload: true }), true);
  await waitFor(async () => (await version()).every(v => v === 1), 'the folder\'s plugin to run in every tab');
  assert.ok((await evalAll('window.__devRuns')).every(w => w.value === 1), 'once per page load');

  // saving the file: every tab reloads (the marker we set is gone) and runs the new code
  await evalAll('window.__beforeReload = true');
  write('hello.js', 'window.__devVersion = 2;');
  await waitFor(async () => (await version()).every(v => v === 2), 'the saved file to run');
  assert.ok((await states()).every(s => s.marker === null), 'the tabs reloaded');

  // files that aren't plugins don't reload anything: notes, editor backups, swap files
  await evalAll('window.__beforeReload = true');
  write('notes.txt', 'x');
  write('hello.js~', 'x');
  write('.hello.js.swp', 'x');
  await settle(1500);
  assert.equal(await marked(), true, 'no reload for a file that is not a .js plugin');

  // a new file in the folder is a new plugin
  write('second.js', 'window.__devSecond = true;');
  await waitFor(async () => (await evalAll('window.__devSecond === true')).every(w => w.value === true), 'the new file to run');
  assert.ok((await version()).every(v => v === 2));

  // safe mode pauses it and stops watching: saving does nothing
  writeConfig({ ...readConfig(), safeMode: true });
  assert.equal(await lib.applyConfig({ reload: true }), true);
  assert.ok((await version()).every(v => v === null), 'nothing from the folder runs in safe mode');
  await evalAll('window.__beforeReload = true');
  write('hello.js', 'window.__devVersion = 3;');
  await settle(1500);
  assert.equal(await marked(), true, 'no reload in safe mode');
  writeConfig({ ...readConfig(), safeMode: false });
  assert.equal(await lib.applyConfig({ reload: true }), true);
  await waitFor(async () => (await version()).every(v => v === 3), 'the folder back after safe mode');

  // turning it off reloads the tabs without the plugins, and the folder is no longer watched
  writeConfig({ ...readConfig(), developerMode: false });
  assert.equal(await lib.applyConfig({ reload: true }), true);
  assert.ok((await version()).every(v => v === null), 'gone');
  await evalAll('window.__beforeReload = true');
  write('hello.js', 'window.__devVersion = 4;');
  await settle(1500);
  assert.equal(await marked(), true, 'no reload once developer mode is off');
  assert.ok((await version()).every(v => v === null));

  writeConfig({ ...readConfig(), developerFolder: '' });
  rmSync(dir, { recursive: true });
  await lib.applyConfig();
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
