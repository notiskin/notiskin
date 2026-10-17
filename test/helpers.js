// every test file gets its own throwaway data folder, real ~/.notiskin is never touched
const { mkdtempSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

process.env.NOTISKIN_DIR = mkdtempSync(join(tmpdir(), 'notiskin-test-'));

module.exports = { dataDir: process.env.NOTISKIN_DIR };
