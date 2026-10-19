// stand-in for `notiskin inject` in its own process, so a test can kill it: the real daemon on a fake Notion's
// pipe, theming the fake's local page instead of notion.so. NOTISKIN_DIR comes from the test's environment
// usage: node run-injector.js <pipe folder> <page url prefix>
const { startInjectorDaemon } = require('../../dist/injector/daemon');
const { runPid } = require('../../dist/injector/pipe');
const { currentPayload } = require('../../dist/core/library');
const { readConfig } = require('../../dist/utils/config');
const { NOTISKIN_DIR, THEMES_DIR, PLUGINS_DIR } = require('../../dist/utils/constants');

const [dir, prefix] = process.argv.slice(2);

startInjectorDaemon({
  run: { dir, pid: runPid(dir) },
  isTargetUrl: url => url.startsWith(prefix),
  loadPayload: () => currentPayload(readConfig()),
  watchPaths: [NOTISKIN_DIR, THEMES_DIR, PLUGINS_DIR],
  controlSocket: true,
  cleanUpRun: true,
  log: msg => console.log(msg),
}).then(
  daemon => daemon.done.then(() => process.exit(0)),
  err => {
    console.error(err);
    process.exit(1);
  }
);
