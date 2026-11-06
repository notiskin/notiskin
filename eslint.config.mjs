import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'release/', 'node_modules/', 'supabase/', 'src/gui/*.html', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `import X = require()` is how chrome-remote-interface's CommonJS export is typed
      '@typescript-eslint/no-require-imports': ['error', { allowAsImport: true }],
    },
  },
  {
    // plain browser scripts served next to the GUI pages
    files: ['src/gui/**/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    // everything common.js declares at the top is what the other scripts call
    files: ['src/gui/common.js'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    // the page scripts (themes.js, plugins.js, settings.js, review.js) share one global scope with
    // common.js, marketplace.js and theme-editor.js, which are loaded before them. Declared here so
    // a typo or a missing script is caught. Unused arguments are fine: an action is called with the
    // markup's arguments and then the event, and takes only the ones it needs
    files: ['src/gui/themes.js', 'src/gui/plugins.js', 'src/gui/settings.js', 'src/gui/review.js'],
    languageOptions: {
      globals: {
        ...Object.fromEntries(
          [
            'SUPABASE_URL', 'SUPABASE_KEY', 'DOCS_URL', 'db', 'esc', 'githubUsername', 'hideReviewLink',
            'showNotif', 'openExternal', 'openDocs', 'openReleasesPage', 'checkUpdateBanner', 'nsActions', 'nsAct',
            'nsVersions', 'nsBrowse', 'nsTheme', 'nsThemeEditor',
          ].map(name => [name, 'readonly'])
        ),
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    // plugins run inside Notion's page, where `notiskin` is provided by the injector
    files: ['starter/plugins/*.js'],
    languageOptions: { globals: { ...globals.browser, notiskin: 'readonly' }, sourceType: 'script' },
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.js', 'publish.js', 'playwright.config.js', '*.mjs'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // the browser tests hand small functions to page.evaluate, which run in the page
    files: ['test/browser/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
);
