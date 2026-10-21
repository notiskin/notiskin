// the watcher's LaunchAgent, in a temp home folder with launchctl mocked, a real agent is never loaded
require('./helpers');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

// the plist goes in ~/Library/LaunchAgents, keep it away from the real one
process.env.HOME = mkdtempSync(join(tmpdir(), 'notiskin-home-'));
delete process.env.SUDO_USER;

const agent = require('../dist/patcher/agent');
const patcher = require('../dist/patcher/index');

const PLIST = join(process.env.HOME, 'Library', 'LaunchAgents', 'com.notiskin.watcher.plist');

let calls = [];
let failLoad = false;
beforeEach(() => {
  calls = [];
  failLoad = false;
  agent.launchctl.run = args => {
    calls.push(args);
    if (failLoad && args[0] === 'load') throw new Error('load failed');
  };
  rmSync(PLIST, { force: true });
});

const TRICKY = ['/usr/local/bin/node', '/Applications/My Apps/notiskin.app/Contents/MacOS/notiskin', 'a & b <c> "d" \'e\''];

test('the plist reads back the copy it runs, app or not', () => {
  for (const program of TRICKY) {
    for (const appMode of [false, true]) {
      const target = { program, script: `${program}/watcher.js`, appMode };
      const path = join(mkdtempSync(join(tmpdir(), 'notiskin-plist-')), 'watcher.plist');
      writeFileSync(path, agent.watcherPlist(target));
      assert.deepEqual(agent.readWatcherTarget(path), target);
      if (process.platform === 'darwin') execFileSync('plutil', ['-lint', path], { stdio: 'ignore' });
    }
  }
  // only the app's watcher runs its binary as Node
  assert.ok(agent.watcherPlist({ program: '/x', script: '/y', appMode: true }).includes('<key>ELECTRON_RUN_AS_NODE</key>'));
  assert.ok(!agent.watcherPlist({ program: '/x', script: '/y', appMode: false }).includes('ELECTRON_RUN_AS_NODE'));
});

test("a missing or unreadable plist isn't a watcher", () => {
  assert.equal(agent.readWatcherTarget(join(tmpdir(), 'no-such-notiskin.plist')), null);
  const path = join(mkdtempSync(join(tmpdir(), 'notiskin-plist-')), 'watcher.plist');
  writeFileSync(path, '<plist><dict><key>Label</key></dict></plist>');
  assert.equal(agent.readWatcherTarget(path), null);
});

test('install writes the plist and loads it, replacing one already there', () => {
  const ours = agent.thisCopyWatcher();
  agent.installWatcher();
  assert.deepEqual(agent.readWatcherTarget(PLIST), ours);
  assert.deepEqual(calls, [['load', PLIST]]);

  calls = [];
  agent.installWatcher();
  assert.deepEqual(calls, [['unload', PLIST], ['load', PLIST]]);

  failLoad = true;
  assert.throws(() => agent.installWatcher(), /Failed to load the LaunchAgent/);
});

test('install refuses a watcher script that is not there', () => {
  assert.throws(() => agent.installWatcher({ program: process.execPath, script: '/nonexistent/watcher.js', appMode: false }), /not found/);
  assert.ok(!existsSync(PLIST));
  assert.deepEqual(calls, []);
});

test('uninstall unloads and removes the plist, and says when there was none', () => {
  agent.installWatcher();
  calls = [];
  assert.equal(agent.uninstallWatcher(), true);
  assert.deepEqual(calls, [['unload', PLIST]]);
  assert.ok(!existsSync(PLIST));
  assert.equal(agent.uninstallWatcher(), false);
});

test('which copy the watcher runs', () => {
  assert.equal(patcher.watcherRunsThisCopy(), null);
  agent.installWatcher();
  assert.equal(patcher.watcherRunsThisCopy(), true);

  const ours = agent.thisCopyWatcher();
  const other = join(mkdtempSync(join(tmpdir(), 'notiskin-copy-')), 'watcher.js');
  writeFileSync(other, '');
  agent.installWatcher({ ...ours, script: other });
  assert.equal(patcher.watcherRunsThisCopy(), false);
  // the same files, but run the other way (the app's binary as Node, or plain Node)
  agent.installWatcher({ ...ours, appMode: !ours.appMode });
  assert.equal(patcher.watcherRunsThisCopy(), false);
  assert.match(readFileSync(PLIST, 'utf-8'), /com\.notiskin\.watcher/);
});
