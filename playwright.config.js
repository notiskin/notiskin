// Browser tests for the GUI pages: real Chromium against the real server, with Supabase, Notion and the
// default browser faked (test/browser/harness.js). Run with `npm run test:browser`. The tests run twice,
// in light and in dark, like the pages do when macOS changes.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'test/browser',
  testMatch: '*.spec.js',
  // one server with one data folder, so one test at a time
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3845',
    trace: 'retain-on-failure',
    // the pages are served on localhost, with no animation settling to wait for
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'light', use: { colorScheme: 'light' } },
    { name: 'dark', use: { colorScheme: 'dark' } },
  ],
  webServer: {
    command: 'node test/browser/harness.js',
    url: 'http://127.0.0.1:3846/health',
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
