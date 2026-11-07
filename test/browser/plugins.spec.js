const { test, expect } = require('./fixtures');

const SETTINGS_HEADER = '/* @notiskin-setting {"key":"height","type":"number","label":"Bar thickness","default":3,"min":1,"max":20} */\n';
const PLUGINS = {
  gamma: '// a plain plugin\nnotiskin.ready(() => {});\n',
  'with-settings': `${SETTINGS_HEADER}notiskin.ready(() => {});\n`,
};

const card = (page, name) => page.locator('.card', { hasText: name });

test('Installed lists the plugins, with the enabled ones switched on', async ({ page, ns }) => {
  await ns.reset({ plugins: PLUGINS, config: { enabledPlugins: ['gamma'], acknowledgedPlugins: ['gamma'] } });
  await page.goto('/plugins.html');
  await expect(card(page, 'gamma')).toBeVisible();
  await expect(card(page, 'with settings')).toBeVisible();
  await expect(card(page, 'gamma').locator('input[type=checkbox]')).toBeChecked();
  await expect(card(page, 'with settings').locator('input[type=checkbox]')).not.toBeChecked();
});

test('turning a plugin on the first time asks first, and Cancel leaves it off', async ({ page, ns }) => {
  await ns.reset({ plugins: PLUGINS });
  await page.goto('/plugins.html');
  await card(page, 'gamma').locator('.toggle').click();
  const dialog = page.locator('#warning-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('full access');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, 'gamma').locator('input[type=checkbox]')).not.toBeChecked();
  expect((await ns.calls()).config.enabledPlugins).toBeUndefined();
});

test('Enable plugin in the warning turns it on and remembers the answer', async ({ page, ns }) => {
  await ns.reset({ plugins: PLUGINS });
  await page.goto('/plugins.html');
  await card(page, 'gamma').locator('.toggle').click();
  await page.locator('#warning-dialog').getByRole('button', { name: 'Enable plugin' }).click();
  await expect(card(page, 'gamma').locator('input[type=checkbox]')).toBeChecked();
  const { config, applyConfig } = await ns.calls();
  expect(config.enabledPlugins).toEqual(['gamma']);
  expect(config.acknowledgedPlugins).toEqual(['gamma']);
  expect(applyConfig.length).toBeGreaterThan(0);

  // off again: no second warning, and it is off in the config
  await card(page, 'gamma').locator('.toggle').click();
  await expect(card(page, 'gamma').locator('input[type=checkbox]')).not.toBeChecked();
  await expect.poll(async () => (await ns.calls()).config.enabledPlugins).toEqual([]);
});

test('a plugin that declares settings has a Settings button, and the form saves a change', async ({ page, ns }) => {
  await ns.reset({ plugins: PLUGINS });
  await page.goto('/plugins.html');
  await expect(card(page, 'gamma').locator('.btn-settings')).toHaveCount(0);
  const mine = card(page, 'with settings');
  await mine.locator('.btn-settings').click();
  const field = mine.locator('.ps-panel input[data-key=height]');
  await expect(field).toHaveValue('3');
  await field.fill('9');
  await field.blur();
  await expect.poll(async () => (await ns.calls()).config.pluginSettings).toEqual({ 'with-settings': { height: 9 } });
  await mine.locator('.ps-reset').click();
  await expect(field).toHaveValue('3');
  await expect.poll(async () => (await ns.calls()).config.pluginSettings).toEqual({});
  await mine.locator('.btn-settings').click();
  await expect(mine.locator('.ps-panel')).toBeHidden();
});

test('deleting a plugin removes its file', async ({ page, ns }) => {
  await ns.reset({ plugins: PLUGINS });
  await page.goto('/plugins.html');
  await card(page, 'gamma').locator('.btn-delete').click();
  await expect.poll(async () => (await ns.calls()).pluginFiles).toEqual(['with-settings.js']);
});

test('the guide link on Publish opens the docs in the browser, not in the app', async ({ page, ns }) => {
  await ns.reset({ plugins: PLUGINS });
  await page.goto('/plugins.html');
  await page.locator('.tab-btn[data-tab=publish]').click();
  await page.getByRole('link', { name: 'Guide to making plugins' }).click();
  await expect.poll(async () => (await ns.calls()).fakebin).toContain('open https://notiskin.github.io/plugins.html');
  expect(new URL(page.url()).pathname).toBe('/plugins.html');
});
