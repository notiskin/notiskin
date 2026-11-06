const { test, expect } = require('./fixtures');

const THEMES = {
  alpha: ':root {\n  --ns-bg: #fff8ee;\n}\n',
  beta: ':root {\n  --ns-bg: #101010;\n}\n',
};

test('Installed lists the themes in the folder, with the active one picked', async ({ page, ns }) => {
  await ns.reset({ themes: THEMES, config: { activeTheme: 'beta' } });
  await page.goto('/');
  await expect(page.locator('#theme-list .card, .card')).toContainText(['No theme', 'alpha', 'beta']);
  await expect(page.locator('input[name=theme][value=beta]')).toBeChecked();
  await expect(page.locator('input[name=theme][value=alpha]')).not.toBeChecked();
});

test('picking a theme saves it and applies it, and No theme clears it', async ({ page, ns }) => {
  await ns.reset({ themes: THEMES });
  await page.goto('/');
  await page.locator('label.card', { hasText: 'alpha' }).click();
  await expect(page.locator('input[name=theme][value=alpha]')).toBeChecked();
  await expect.poll(async () => (await ns.calls()).config.activeTheme).toBe('alpha');
  // the app is asked to apply it, and to restart Notion if it has to (the fake does neither)
  expect((await ns.calls()).applyConfig).toContainEqual({ restartIfNeeded: true });

  await page.locator('label.card', { hasText: 'No theme' }).click();
  await expect.poll(async () => (await ns.calls()).config.activeTheme).toBe('');
  expect((await ns.calls()).fakebin.filter(line => /^(pkill|killall)/.test(line))).toEqual([]);
});

test('the search box narrows the list', async ({ page, ns }) => {
  await ns.reset({ themes: THEMES });
  await page.goto('/');
  await page.locator('#installed-search-themes').fill('alp');
  await expect(page.locator('label.card:visible')).toHaveCount(1);
  await expect(page.locator('label.card:visible')).toContainText('alpha');
});

test('deleting a theme removes its file', async ({ page, ns }) => {
  await ns.reset({ themes: THEMES });
  await page.goto('/');
  await page.locator('label.card', { hasText: 'beta' }).locator('.btn-delete').click();
  await expect(page.locator('label.card', { hasText: 'beta' })).toBeHidden();
  await expect.poll(async () => (await ns.calls()).themeFiles).toEqual(['alpha.css']);
});

test('Edit opens the theme editor on the theme, and Back closes it', async ({ page, ns }) => {
  await ns.reset({ themes: THEMES });
  await page.goto('/');
  await page.locator('label.card', { hasText: 'alpha' }).locator('.btn-edit').click();
  const editor = page.locator('#theme-editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('alpha');
  page.once('dialog', dialog => dialog.accept());
  await editor.locator('#te-back').click();
  await expect(editor).toBeHidden();
  await expect(page.locator('label.card', { hasText: 'alpha' })).toBeVisible();
});

test('New theme saves a file with the chosen name', async ({ page, ns }) => {
  await ns.reset({ themes: THEMES });
  await page.goto('/');
  await page.locator('#new-theme-btn').click();
  await expect(page.locator('#theme-editor')).toBeVisible();
  await page.locator('#theme-editor input[type=text]').first().fill('my new one');
  await page.locator('#te-save').click();
  await expect.poll(async () => (await ns.calls()).themeFiles).toContain('my new one.css');
});

test('the Download link on the update banner opens the releases page in the browser', async ({ page, ns }) => {
  await ns.reset({ themes: THEMES });
  await page.route('**/api/update-status', route => route.fulfill({ json: { state: 'available', version: '9.9.9' } }));
  await page.goto('/');
  await expect(page.locator('#banner-text')).toHaveText('Notiskin 9.9.9 is out');
  await page.locator('#update-banner button', { hasText: 'Download' }).click();
  await expect.poll(async () => (await ns.calls()).fakebin).toContain('open https://github.com/notiskin/notiskin/releases/latest');
});
