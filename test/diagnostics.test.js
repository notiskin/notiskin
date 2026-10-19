// the bug-report text: what it hides, and that it only reads the end of the log
const { dataDir } = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const { redact, tailFile, diagnosticsReport } = require('../dist/core/diagnostics');

test('Notion links and IDs are hidden', () => {
  assert.equal(
    redact('Found: https://app.notion.com/p/Tasks-31e1183666438091bc80dedc4ea424fa?notionRestoreUserId=31ed872b-594c-818f-8e27-0002683d04e6&x=0', '/Users/me', []),
    'Found: <notion page>'
  );
  assert.equal(redact('page https://www.notion.so/abc and done', '/Users/me', []), 'page <notion page> and done');
  assert.equal(redact('user 31ed872b-594c-818f-8e27-0002683d04e6 block 31e1183666438091bc80dedc4ea424fa', '/Users/me', []), 'user <id> block <id>');
});

test('the home folder and user name are hidden', () => {
  assert.equal(
    redact('saved to /Users/remi/.notiskin/backup and /Users/someone/x', '/Users/remi', ['remi']),
    'saved to ~/.notiskin/backup and /Users/<you>/x'
  );
  assert.equal(redact('chown remi:staff failed for Remi', '/nowhere', ['remi']), 'chown <you>:staff failed for <you>');
  // short names would wipe out ordinary words
  assert.equal(redact('an ox', '/nowhere', ['ox']), 'an ox');
});

test('harmless text is left alone', () => {
  const text = 'Debug port 9222: answering\n[injector] CSS injected successfully.\nhttps://github.com/notiskin/notiskin';
  assert.equal(redact(text, '/Users/me', ['me']), text);
});

test('tailFile reads only the last lines of a big log', () => {
  const path = join(dataDir, 'big.log');
  const lines = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
  writeFileSync(path, lines.join('\n') + '\n');
  assert.deepEqual(tailFile(path, 3), ['line 49997', 'line 49998', 'line 49999']);
  assert.equal(tailFile(path, 100_000, 1024).every(l => /^line \d+$/.test(l)), true, 'no cut-off first line');
  assert.deepEqual(tailFile(join(dataDir, 'missing.log')), []);
});

test('the report covers the basics and hides what is in the log', async () => {
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  writeFileSync(
    join(dataDir, 'logs', 'inject.log'),
    '[injector] Found: https://app.notion.com/p/Inbox-31e118366643800c91ecf409496b4875\n'
  );
  const report = await diagnosticsReport(new Date('2026-10-19T00:00:00Z'));
  assert.match(report, /^Notiskin diagnostics, 2026-10-19T00:00:00.000Z/);
  for (const label of ['Notiskin:', 'System:', 'Installed:', 'Injector:', 'Safe mode:', 'Theme:', 'Plugins on:']) {
    assert.ok(report.includes(label), label);
  }
  assert.match(report, /\[injector\] Found: <notion page>/);
  assert.ok(!report.includes('31e118366643800c91ecf409496b4875'));
});
