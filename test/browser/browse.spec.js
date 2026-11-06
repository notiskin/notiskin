const { test, expect } = require('./fixtures');

const items = ns => [
  ns.item({ id: 'theme-1', name: 'sunset', description: 'Warm evening colors', download_count: 7, tags: ['light', 'colorful'], link: 'https://github.com/someone/sunset' }),
  ns.item({ id: 'theme-2', name: 'midnight', description: 'Easy on the eyes', download_count: 1, tags: ['dark'], author_github: 'other' }),
];

const searches = async ns => (await ns.calls()).supabase.filter(c => c.path === '/rest/v1/themes' && c.method === 'GET');

async function openBrowse(page, ns, extra = {}) {
  await ns.reset({ supabase: { items: { themes: items(ns), plugins: [ns.item({ id: 'plugin-1', name: 'counter', description: 'Counts words' })] } }, ...extra });
  await page.goto('/');
  await page.locator('.tab-btn[data-tab=browse]').click();
}

test('Browse lists the marketplace with tags, downloads and a More info button for GitHub links', async ({ page, ns }) => {
  await openBrowse(page, ns);
  const cards = page.locator('#browse-themes-list .card');
  await expect(cards).toHaveCount(2);
  const sunset = cards.filter({ hasText: 'sunset' });
  await expect(sunset).toContainText('Warm evening colors');
  await expect(sunset).toContainText('by someone');
  await expect(sunset.locator('.ns-tag')).toHaveText(['light', 'colorful']);
  await expect(sunset.locator('.ns-downloads')).toHaveText('7 downloads');
  await expect(sunset.locator('.ns-more-info')).toHaveCount(1);
  await expect(cards.filter({ hasText: 'midnight' }).locator('.ns-downloads')).toHaveText('1 download');
  await expect(cards.filter({ hasText: 'midnight' }).locator('.ns-more-info')).toHaveCount(0);
});

test('More info opens the GitHub page in the browser', async ({ page, ns }) => {
  await openBrowse(page, ns);
  await page.locator('#browse-themes-list .card', { hasText: 'sunset' }).locator('.ns-more-info').click();
  await expect.poll(async () => (await ns.calls()).fakebin).toContain('open https://github.com/someone/sunset');
});

test('sorting and the search box change what is asked of the marketplace', async ({ page, ns }) => {
  await openBrowse(page, ns);
  await page.locator('#browse-controls select').selectOption('downloads');
  await expect.poll(async () => (await searches(ns)).some(c => c.query.includes('order=download_count.desc'))).toBe(true);
  await page.locator('#browse-controls select').selectOption('rating');
  await expect.poll(async () => (await searches(ns)).some(c => c.query.includes('order=avg_rating.desc'))).toBe(true);

  await page.locator('#browse-search-themes').fill('sunset');
  await expect.poll(async () => (await searches(ns)).some(c => decodeURIComponent(c.query).includes('name.ilike.%sunset%'))).toBe(true);
  // only what the marketplace says is approved is asked for
  expect((await searches(ns)).every(c => c.query.includes('status=eq.approved'))).toBe(true);
});

test('the Tags button opens a card of checkboxes, picking one filters, Clear undoes it', async ({ page, ns }) => {
  await openBrowse(page, ns);
  const button = page.locator('.ns-tag-filter-btn');
  const popover = page.locator('.ns-tag-popover');
  await expect(popover).toBeHidden();
  await button.click();
  await expect(popover).toBeVisible();
  await popover.getByLabel('dark').check();
  await expect(button).toHaveText('Tags · 1');
  await expect.poll(async () => (await searches(ns)).some(c => decodeURIComponent(c.query).includes('tags=cs.{dark}'))).toBe(true);
  await popover.getByRole('button', { name: 'Clear' }).click();
  await expect(button).toHaveText('Tags');
  // a click elsewhere closes it
  await page.locator('#browse-search-themes').click();
  await expect(popover).toBeHidden();
});

test('Install writes the theme to the folder and takes the card away, signed out nothing is counted', async ({ page, ns }) => {
  await openBrowse(page, ns);
  await page.locator('#browse-themes-list .card', { hasText: 'sunset' }).getByRole('button', { name: 'Install' }).click();
  await expect(page.locator('#browse-themes-list .card', { hasText: 'sunset' })).toHaveCount(0);
  const calls = await ns.calls();
  expect(calls.themeFiles).toEqual(['sunset.css']);
  // it is installed, not turned on
  expect(calls.config.activeTheme).toBeUndefined();
  expect(calls.supabase.filter(c => c.path.startsWith('/functions/v1/count-download'))).toEqual([]);
  await page.locator('.tab-btn[data-tab=installed]').click();
  await expect(page.locator('#themes-list .card', { hasText: 'sunset' })).toBeVisible();
});

test('a signed-in Install counts as a download, without waiting for it', async ({ page, ns }) => {
  await page.signIn('tester');
  await openBrowse(page, ns);
  await page.locator('#browse-themes-list .card', { hasText: 'midnight' }).getByRole('button', { name: 'Install' }).click();
  await expect.poll(async () => (await ns.calls()).themeFiles).toEqual(['midnight.css']);
  await expect.poll(async () => (await ns.calls()).supabase.filter(c => c.path === '/functions/v1/count-download' && c.auth === 'user').length).toBe(1);
});

test('a theme you already have is not offered again in Browse', async ({ page, ns }) => {
  await openBrowse(page, ns, { themes: { sunset: ':root { --ns-bg: red; }\n' } });
  await page.locator('.tab-btn[data-tab=installed]').click();
  await expect(page.locator('#themes-list .card', { hasText: 'sunset' })).toBeVisible();
  await page.locator('.tab-btn[data-tab=browse]').click();
  await expect(page.locator('#browse-themes-list .card', { hasText: 'sunset' })).toHaveCount(0);
  await expect(page.locator('#browse-themes-list .card', { hasText: 'midnight' })).toHaveCount(1);
});

test('Report asks you to sign in when you are signed out', async ({ page, ns }) => {
  await openBrowse(page, ns);
  await page.locator('#browse-themes-list .card', { hasText: 'sunset' }).getByRole('button', { name: 'Report' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Sign in to report');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
});

test('Report sends the reason and note for the item, and says thanks', async ({ page, ns }) => {
  await page.signIn('tester');
  await openBrowse(page, ns);
  await page.locator('#browse-themes-list .card', { hasText: 'sunset' }).getByRole('button', { name: 'Report' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Report sunset');
  // a reason is needed
  await dialog.getByRole('button', { name: 'Send report' }).click();
  expect((await ns.calls()).supabase.filter(c => c.path === '/functions/v1/report-item')).toEqual([]);
  await dialog.getByLabel('Doesn\'t work').check();
  await dialog.getByPlaceholder('Details (optional)').fill('crashes the sidebar');
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(page.locator('.notif')).toContainText('a reviewer will look at it');
  await expect(dialog).toHaveCount(0);
  const sent = (await ns.calls()).supabase.filter(c => c.path === '/functions/v1/report-item');
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0].body)).toEqual({ type: 'theme', id: 'theme-1', reason: 'broken', note: 'crashes the sidebar' });
  expect(sent[0].auth).toBe('user');
});

test('a refused report shows the reason in the dialog and can be tried again', async ({ page, ns }) => {
  page.expectErrors(/409/);
  await page.signIn('tester');
  await openBrowse(page, ns, { supabase: { functions: { 'report-item': { status: 409, json: { error: 'You already reported this theme.' } } }, items: { themes: items(ns), plugins: [] } } });
  await page.locator('#browse-themes-list .card', { hasText: 'sunset' }).getByRole('button', { name: 'Report' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Spam').check();
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(dialog.locator('.ns-report-error')).toHaveText('You already reported this theme.');
  await expect(dialog.getByRole('button', { name: 'Send report' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

test('Browse on the Plugins page installs a plugin and leaves it off', async ({ page, ns }) => {
  await ns.reset({ supabase: { items: { themes: [], plugins: [ns.item({ id: 'plugin-1', name: 'counter', description: 'Counts words' })] } } });
  await page.goto('/plugins.html');
  await page.locator('.tab-btn[data-tab=browse]').click();
  const card = page.locator('#tab-browse .card', { hasText: 'counter' });
  await expect(card).toContainText('Counts words');
  await card.getByRole('button', { name: 'Install' }).click();
  await expect.poll(async () => (await ns.calls()).pluginFiles).toEqual(['counter.js']);
  // installed but off: the config has no enabled plugin
  expect((await ns.calls()).config.enabledPlugins).toBeUndefined();
});

test('when the marketplace is down, Browse says so', async ({ page, ns }) => {
  page.expectErrors(/502|Failed to load resource/);
  await ns.reset({ supabase: { items: { themes: [], plugins: [] } } });
  await page.route('**/api/themes/search*', route => route.fulfill({ status: 502, json: { error: 'down' } }));
  await page.goto('/');
  await page.locator('.tab-btn[data-tab=browse]').click();
  await expect(page.locator('#browse-themes-list')).toContainText(/Couldn't load|No themes/);
});
