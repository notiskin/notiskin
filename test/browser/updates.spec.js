const { test, expect } = require('./fixtures');

const OLD_CSS = ':root { --ns-bg: #ffffff; }\n';
const NEW_CSS = ':root { --ns-bg: #fff3e0; }\n';
// installed items are remembered by marketplace id, which has to be a UUID
const THEME_ID = 'a0000000-0000-4000-8000-000000000001';
const PLUGIN_ID = 'b0000000-0000-4000-8000-000000000002';
const GONE_ID = 'c0000000-0000-4000-8000-000000000003';
const card = (page, name) => page.locator('.card', { hasText: name });

function world(ns, overrides = {}) {
  return {
    themes: { sunset: OLD_CSS },
    plugins: { counter: '// v1\n' },
    installed: { 'theme:sunset': { id: THEME_ID, version: 1 }, 'plugin:counter': { id: PLUGIN_ID, version: 1 } },
    supabase: {
      items: {
        themes: [ns.item({ id: THEME_ID, name: 'sunset', version: 2, css: NEW_CSS })],
        plugins: [ns.item({ id: PLUGIN_ID, name: 'counter', version: 2, js: '// v2\n' })],
      },
      statuses: { theme: { [THEME_ID]: { status: 'approved', version: 2 } }, plugin: { [PLUGIN_ID]: { status: 'approved', version: 2 } } },
      itemVersions: [
        { item_id: THEME_ID, version: 2, changelog: 'Better contrast' },
        { item_id: PLUGIN_ID, version: 2, changelog: 'Counts headings too' },
      ],
    },
    ...overrides,
  };
}

test('an installed theme with a newer version shows what changed, and Update installs it', async ({ page, ns }) => {
  await ns.reset(world(ns));
  await page.goto('/');
  const sunset = card(page, 'sunset');
  await expect(sunset.locator('.ns-update-badge')).toHaveText('Version 2 is out');
  await expect(sunset.locator('.ns-update-change')).toHaveText('Better contrast');
  await sunset.getByRole('button', { name: 'Update' }).click();
  await expect(page.locator('.notif')).toContainText('sunset updated to version 2');
  await expect(sunset.locator('.ns-update')).toHaveCount(0);
  expect((await ns.calls()).contents['themes/sunset.css']).toBe(NEW_CSS);
  // clicking Update must not have picked the theme (the card is a label)
  expect((await ns.calls()).config.activeTheme).toBeUndefined();
});

test('updating the theme you are using applies it again', async ({ page, ns }) => {
  await ns.reset(world(ns, { config: { activeTheme: 'sunset' } }));
  await page.goto('/');
  await card(page, 'sunset').getByRole('button', { name: 'Update' }).click();
  await expect(page.locator('.notif')).toContainText('updated to version 2');
  expect((await ns.calls()).applyConfig).toContainEqual({});
});

test('an installed theme that is up to date has no Update row', async ({ page, ns }) => {
  await ns.reset(world(ns, { supabase: { ...world(ns).supabase, statuses: { theme: { [THEME_ID]: { status: 'approved', version: 1 } }, plugin: {} } } }));
  await page.goto('/');
  await expect(card(page, 'sunset')).toBeVisible();
  await expect(page.locator('.ns-update')).toHaveCount(0);
});

test('a plugin update asks first, with the changes, and Cancel leaves the old version', async ({ page, ns }) => {
  await ns.reset(world(ns));
  await page.goto('/plugins.html');
  await card(page, 'counter').getByRole('button', { name: 'Update' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Update counter to version 2?');
  await expect(dialog).toContainText('full access to your Notion page');
  await expect(dialog).toContainText('Counts headings too');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card(page, 'counter').locator('.ns-update')).toBeVisible();
  expect((await ns.calls()).supabase.filter(c => c.path === '/rest/v1/plugins' && c.query.includes(`id=eq.${PLUGIN_ID}`))).toEqual([]);
});

test('Update plugin installs the new code, and a plugin that is on reloads Notion', async ({ page, ns }) => {
  await ns.reset(world(ns, { config: { enabledPlugins: ['counter'], acknowledgedPlugins: ['counter'] } }));
  await page.goto('/plugins.html');
  await card(page, 'counter').getByRole('button', { name: 'Update' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Update plugin' }).click();
  await expect(page.locator('.notif')).toContainText('counter updated to version 2');
  await expect(card(page, 'counter').locator('.ns-update')).toHaveCount(0);
  expect((await ns.calls()).applyConfig).toContainEqual({ reload: true });
  expect((await ns.calls()).contents['plugins/counter.js']).toBe('// v2\n');
});

test('an item pulled from the marketplace gets a warning, and nothing is switched off by itself', async ({ page, ns }) => {
  await ns.reset(world(ns, {
    themes: { sunset: OLD_CSS, gone: OLD_CSS },
    plugins: { counter: '// v1\n' },
    config: { enabledPlugins: ['counter'], acknowledgedPlugins: ['counter'] },
    installed: { 'theme:sunset': { id: THEME_ID, version: 1 }, 'theme:gone': { id: GONE_ID, version: 1 }, 'plugin:counter': { id: PLUGIN_ID, version: 1 } },
    supabase: {
      items: { themes: [], plugins: [] },
      statuses: { theme: { [THEME_ID]: { status: 'hidden', version: 1 } }, plugin: { [PLUGIN_ID]: { status: 'rejected', version: 1 } } },
    },
  }));
  await page.goto('/');
  await expect(card(page, 'sunset').locator('.ns-pulled-text')).toHaveText("This theme was pulled from the marketplace while it's reviewed.");
  // not in the answer at all: removed
  await expect(card(page, 'gone').locator('.ns-pulled-text')).toHaveText('This theme is no longer in the marketplace.');
  await expect(page.getByRole('button', { name: 'Update' })).toHaveCount(0);

  await page.goto('/plugins.html');
  const counter = card(page, 'counter');
  await expect(counter.locator('.ns-pulled-text')).toHaveText('A reviewer removed this plugin from the marketplace. Consider turning it off.');
  await expect(counter.locator('input[type=checkbox]')).toBeChecked();
  expect((await ns.calls()).config.enabledPlugins).toEqual(['counter']);

  // Turn off is the person's choice: it switches the plugin off, the file stays
  await counter.getByRole('button', { name: 'Turn off' }).click();
  await expect.poll(async () => (await ns.calls()).config.enabledPlugins).toEqual([]);
  expect((await ns.calls()).pluginFiles).toEqual(['counter.js']);
});

test('an installed plugin that is off has the warning without a Turn off button', async ({ page, ns }) => {
  await ns.reset(world(ns, {
    supabase: { items: { themes: [], plugins: [] }, statuses: { theme: {}, plugin: { [PLUGIN_ID]: { status: 'hidden', version: 1 } } } },
  }));
  await page.goto('/plugins.html');
  await expect(card(page, 'counter').locator('.ns-pulled-text')).toContainText('pulled from the marketplace');
  await expect(card(page, 'counter').getByRole('button', { name: 'Turn off' })).toHaveCount(0);
});

test('when the marketplace cannot be reached the installed list still works, with no rows', async ({ page, ns }) => {
  page.expectErrors(/502|Failed to load resource/);
  await ns.reset(world(ns));
  await page.route('**/api/marketplace/updates', route => route.fulfill({ status: 502, json: { error: 'down' } }));
  await page.goto('/');
  await expect(card(page, 'sunset')).toBeVisible();
  await expect(page.locator('.ns-update')).toHaveCount(0);
});
