const { dataDir } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const { acquirePidLock } = require('../dist/utils/pidlock');

test('only one holder at a time, released lock can be retaken', () => {
  const path = join(dataDir, 'a.pid');
  const release = acquirePidLock(path);
  assert.ok(release);
  // same process asking again counts as stale, so simulate another live holder with the parent pid
  writeFileSync(path, String(process.ppid));
  assert.equal(acquirePidLock(path), null);
  writeFileSync(path, String(process.pid));
  release();
  assert.ok(!existsSync(path));
  assert.ok(acquirePidLock(path));
});

test('a lock left by a dead process is taken over', () => {
  const path = join(dataDir, 'b.pid');
  writeFileSync(path, '999999');
  assert.ok(acquirePidLock(path));
});
