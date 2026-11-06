const { test, expect } = require('./fixtures');

const mine = ns => [
  ns.item({ id: 'mine-1', name: 'sunset', status: 'approved', version: 2, tags: [], rejection_reason: null }),
  ns.item({ id: 'mine-2', name: 'half baked', status: 'pending', version: 1, tags: [], rejection_reason: null }),
  ns.item({ id: 'mine-3', name: 'too loud', status: 'rejected', version: 1, tags: [], rejection_reason: 'Hides the page text' }),
];

const publish = async page => {
  await page.locator('.tab-btn[data-tab=publish]').click();
};

test('signed out, Publish sends you to Settings to sign in', async ({ page }) => {
  await page.goto('/');
  await publish(page);
  await expect(page.locator('#publish-login-section')).toContainText('Sign in with GitHub in Settings');
  await expect(page.locator('#publish-form-section')).toBeHidden();
  await expect(page.getByRole('link', { name: /Sign in|GitHub|Settings/ }).first()).toHaveAttribute('href', '/settings.html');
});

test('signed in, Publish shows the form for the GitHub account', async ({ page }) => {
  await page.signIn('tester');
  await page.goto('/');
  await publish(page);
  await expect(page.locator('#publish-username-display')).toHaveText('tester');
  await expect(page.locator('#publish-form')).toBeVisible();
  await expect(page.locator('#publish-login-section')).toBeHidden();
});

test('at most three tags can be picked, and the others come back when one is unticked', async ({ page }) => {
  await page.signIn('tester');
  await page.goto('/');
  await publish(page);
  const boxes = page.locator('#f-tags input[type=checkbox]');
  await expect(boxes).toHaveCount(8);
  for (const tag of ['dark', 'minimal', 'fun']) await page.locator('#f-tags').getByLabel(tag, { exact: true }).check();
  await expect(page.locator('#f-tags input:not(:checked)').first()).toBeDisabled();
  await expect(page.locator('#f-tags input:disabled')).toHaveCount(5);
  await page.locator('#f-tags').getByLabel('minimal', { exact: true }).uncheck();
  await expect(page.locator('#f-tags input:disabled')).toHaveCount(0);
});

test('Submit sends the lowercased name, the code, the tags and the link, then clears the form', async ({ page, ns }) => {
  await ns.reset({ supabase: { functions: { 'submit-theme': { status: 200, json: { autoApproved: true } } } } });
  await page.signIn('tester');
  await page.goto('/');
  await publish(page);
  await page.locator('#f-name').fill('  Warm   Sand ');
  await page.locator('#f-description').fill('A warm one');
  await page.locator('#f-code').fill(':root { --ns-bg: #f5e9d3; }');
  await page.locator('#f-tags').getByLabel('light', { exact: true }).check();
  await page.locator('#f-tags').getByLabel('colorful', { exact: true }).check();
  await page.locator('#f-link').fill('https://github.com/tester/warm-sand');
  await page.locator('#publish-submit-btn').click();
  await expect(page.locator('#publish-msg')).toHaveText('Theme published.');
  await expect(page.locator('#f-name')).toHaveValue('');
  const sent = (await ns.calls()).supabase.filter(c => c.path === '/functions/v1/submit-theme');
  expect(sent).toHaveLength(1);
  expect(sent[0].auth).toBe('user');
  expect(JSON.parse(sent[0].body)).toEqual({
    name: 'warm sand', description: 'A warm one', css: ':root { --ns-bg: #f5e9d3; }',
    tags: ['light', 'colorful'], link: 'https://github.com/tester/warm-sand',
  });
});

test('a theme that needs a reviewer says so', async ({ page, ns }) => {
  await ns.reset({ supabase: { functions: { 'submit-theme': { status: 200, json: { autoApproved: false, reason: 'It uses url()' } } } } });
  await page.signIn('tester');
  await page.goto('/');
  await publish(page);
  await page.locator('#f-name').fill('fancy');
  await page.locator('#f-code').fill(':root { --ns-bg: url(x); }');
  await page.locator('#publish-submit-btn').click();
  await expect(page.locator('#publish-msg')).toHaveText('Theme submitted for review. It uses url().');
});

test('a link that is not GitHub is refused by the marketplace, and the page says why and lets you fix it', async ({ page, ns }) => {
  page.expectErrors(/400/);
  await ns.reset({ supabase: { functions: { 'submit-theme': { status: 400, json: { error: 'The link has to be a github.com address' } } } } });
  await page.signIn('tester');
  await page.goto('/');
  await publish(page);
  await page.locator('#f-name').fill('linked');
  await page.locator('#f-code').fill(':root { --ns-bg: #fff; }');
  await page.locator('#f-link').fill('https://example.com/x');
  await page.locator('#publish-submit-btn').click();
  await expect(page.locator('#publish-msg')).toHaveText('The link has to be a github.com address');
  await expect(page.locator('#publish-msg')).toHaveClass(/error/);
  await expect(page.locator('#publish-submit-btn')).toBeEnabled();
  // what was typed is still there
  await expect(page.locator('#f-link')).toHaveValue('https://example.com/x');
});

test('the character counters follow what is typed', async ({ page }) => {
  await page.signIn('tester');
  await page.goto('/');
  await publish(page);
  await page.locator('#f-name').fill('abcde');
  await expect(page.locator('#name-count')).toHaveText('5/50');
  await page.locator('#f-description').fill('abc');
  await expect(page.locator('#desc-count')).toHaveText('3/300');
});

test('Submissions lists your themes with their status, and only pending or rejected ones can be deleted', async ({ page, ns }) => {
  await ns.reset({ supabase: { submissions: { themes: mine(ns), plugins: [] } } });
  await page.signIn('tester');
  await page.goto('/');
  await page.locator('.tab-btn[data-tab=submissions]').click();
  const rows = page.locator('#submissions-list .card');
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'sunset' }).locator('.status-badge')).toHaveText('approved');
  await expect(rows.filter({ hasText: 'sunset' }).getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(rows.filter({ hasText: 'too loud' })).toContainText('Hides the page text');

  page.once('dialog', dialog => dialog.accept());
  await rows.filter({ hasText: 'half baked' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#submissions-list .card', { hasText: 'half baked' })).toHaveCount(0);
  const deletes = (await ns.calls()).supabase.filter(c => c.method === 'DELETE');
  expect(deletes.map(d => d.query)).toEqual(['?id=eq.mine-2&select=id']);
});

test('declining the delete prompt keeps the submission', async ({ page, ns }) => {
  await ns.reset({ supabase: { submissions: { themes: mine(ns), plugins: [] } } });
  await page.signIn('tester');
  await page.goto('/');
  await page.locator('.tab-btn[data-tab=submissions]').click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#submissions-list .card', { hasText: 'too loud' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#submissions-list .card')).toHaveCount(3);
  expect((await ns.calls()).supabase.filter(c => c.method === 'DELETE')).toEqual([]);
});

test('signed out, Submissions asks you to sign in', async ({ page }) => {
  await page.goto('/');
  await page.locator('.tab-btn[data-tab=submissions]').click();
  await expect(page.locator('#submissions-list')).toContainText('Sign in to see your submissions.');
});

test('Publish a new version offers the themes you own, by name and version', async ({ page, ns }) => {
  await ns.reset({ supabase: { submissions: { themes: mine(ns), plugins: [] } } });
  await page.signIn('tester');
  await page.goto('/');
  await publish(page);
  const select = page.locator('#v-item-theme');
  await expect(select).toBeVisible();
  await expect(select.locator('option')).toHaveText(['sunset (version 2)']);
});

test('the same Publish tab on Plugins takes JavaScript, and the guide link is there', async ({ page }) => {
  await page.signIn('tester');
  await page.goto('/plugins.html');
  await publish(page);
  await expect(page.locator('#publish-form')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Guide to making plugins' })).toBeVisible();
});
