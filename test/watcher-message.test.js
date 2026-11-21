// the watcher's notifications go inside an AppleScript string (display notification "…"), a straight double quote or a
// backslash in one would break osascript and the user would get no notification at all
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'patcher', 'watcher.ts'), 'utf-8');

test('every watcher notification is safe inside an AppleScript string', () => {
  const messages = [...source.matchAll(/(?:REPAIRED_MESSAGE = |notify\()'([^']*)'/g)].map(m => m[1]);
  assert.ok(messages.length >= 2, 'found the repaired and the failed messages');
  for (const message of messages) {
    assert.ok(!message.includes('"'), `no straight double quote in: ${message}`);
    assert.ok(!message.includes('\\'), `no backslash in: ${message}`);
  }
});

test('after a repair the watcher tells the user about the Notion Safe Storage question', () => {
  assert.match(source, /Repatch complete\.'\);\s*(\/\/[^\n]*\n\s*)*notify\(REPAIRED_MESSAGE\)/);
  assert.match(source, /REPAIRED_MESSAGE = '[^']*Notion Safe Storage[^']*Always Allow/);
});
