const { test, expect } = require('./fixtures');

const notionRow = page => ({
  badge: page.locator('#notion-badge'),
  button: page.locator('#notion-btn'),
  sub: page.locator('#notion-sub'),
  error: page.locator('#notion-error'),
});

// ---- signing in ----

test('signed out, Settings offers GitHub sign-in and hides the Review link', async ({ page }) => {
  await page.goto('/settings.html');
  await expect(page.locator('#account-label')).toHaveText('Not signed in');
  await expect(page.locator('#account-btn')).toHaveText('Sign in with GitHub');
  await expect(page.locator('#nav-review')).toBeHidden();
});

test('sign-in opens the default browser, picks up the code from the callback, and signs in', async ({ page, ns }) => {
  // the reviewer check treats the 403 for someone who isn't one as its answer
  page.expectErrors(/403/);
  await ns.reset({ supabase: { functions: { 'review-pending': { status: 403, json: { error: 'Not a reviewer' } } } } });
  await page.goto('/settings.html');
  await page.locator('#account-btn').click();
  await expect(page.locator('#account-label')).toHaveText('Finish signing in in your browser');
  await expect(page.locator('#account-btn')).toHaveText('Cancel');
  // the app opened Supabase's GitHub sign-in with PKCE, in the browser and not in its own window
  const { authOpen } = await ns.calls();
  expect(authOpen).toHaveLength(1);
  const url = new URL(authOpen[0]);
  expect(url.pathname).toBe('/auth/v1/authorize');
  expect(url.searchParams.get('provider')).toBe('github');
  expect(url.searchParams.get('code_challenge_method')).toBe('s256');
  expect(url.searchParams.get('redirect_to')).toBe('http://localhost:3845/auth/callback');
  expect(url.searchParams.get('prompt') ?? url.searchParams.get('queryParams')).not.toBeNull();

  // the browser lands on the callback with a one-time code; the account being signed in is the fake's
  await ns.signInAs('tester');
  const callback = await page.request.get('/auth/callback?code=abcdef1234567890');
  expect(callback.status()).toBe(200);
  await expect(page.locator('#account-label')).toHaveText('Signed in as tester', { timeout: 10_000 });
  await expect(page.locator('#account-btn')).toHaveText('Sign out');
  // not a reviewer: no badge, no Review link
  await expect(page.locator('.account-badge')).toHaveCount(0);
  await expect(page.locator('#nav-review')).toBeHidden();
});

test('a second click while waiting cancels the sign-in', async ({ page, ns }) => {
  await page.goto('/settings.html');
  await page.locator('#account-btn').click();
  await expect(page.locator('#account-btn')).toHaveText('Cancel');
  await page.locator('#account-btn').click();
  await expect(page.locator('#account-label')).toHaveText('Not signed in');
  await expect(page.locator('#account-btn')).toHaveText('Sign in with GitHub');
  // the code of a sign-in nobody is waiting for is ignored
  const late = await page.request.get('/auth/callback?code=abcdef1234567890');
  expect(late.status()).toBe(400);
  expect((await ns.calls()).authOpen).toHaveLength(1);
});

test('a sign-in the person cancels in GitHub says so', async ({ page }) => {
  await page.goto('/settings.html');
  await page.locator('#account-btn').click();
  await expect(page.locator('#account-btn')).toHaveText('Cancel');
  const callback = await page.request.get('/auth/callback?error=access_denied&error_description=Access%20denied');
  expect(callback.status()).toBe(400);
  await expect(page.locator('.notif')).toContainText('Access denied', { timeout: 10_000 });
  await expect(page.locator('#account-label')).toHaveText('Not signed in');
});

test('a stored session shows who is signed in, and Sign out ends it', async ({ page, ns }) => {
  page.expectErrors(/403/);
  await ns.reset({ supabase: { functions: { 'review-pending': { status: 403, json: { error: 'no' } } } } });
  await page.signIn('tester');
  await page.goto('/settings.html');
  await expect(page.locator('#account-label')).toHaveText('Signed in as tester');
  await page.locator('#account-btn').click();
  await expect(page.locator('#account-label')).toHaveText('Not signed in');
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.includes('auth-token')))).toEqual([]);
});

test('a reviewer gets a badge, and the Review link shows on every page', async ({ page, ns }) => {
  await ns.reset({ supabase: { functions: { 'review-pending': { status: 200, json: { themes: [], plugins: [] } } } } });
  await page.signIn('boss');
  await page.goto('/settings.html');
  await expect(page.locator('.account-badge')).toHaveText('Reviewer');
  await expect(page.locator('#nav-review')).toBeVisible();
  await page.goto('/');
  await expect(page.locator('#nav-review')).toBeVisible();
  await page.goto('/plugins.html');
  await expect(page.locator('#nav-review')).toBeVisible();
});

// ---- Install into Notion ----

test('Install into Notion runs the install and then offers Uninstall', async ({ page, ns }) => {
  await ns.reset({ notion: { status: 'not-installed' } });
  await page.goto('/settings.html');
  const row = notionRow(page);
  await expect(row.badge).toHaveText('Not installed');
  await expect(row.button).toHaveText('Install');
  await row.button.click();
  await expect(row.badge).toHaveText('Installed');
  await expect(row.button).toHaveText('Uninstall');
  expect((await ns.calls()).notionRun).toEqual(['patch']);
  await row.button.click();
  await expect(row.badge).toHaveText('Not installed');
  expect((await ns.calls()).notionRun).toEqual(['patch', 'unpatch']);
});

test('after a Notion update the row says Needs repair, and Repair with Notion open offers a restart', async ({ page, ns }) => {
  await ns.reset({ notion: { status: 'needs-repair', running: true } });
  await page.goto('/settings.html');
  const row = notionRow(page);
  await expect(row.badge).toHaveText('Needs repair');
  await expect(row.sub).toContainText('A Notion update or moving Notiskin switched this off');
  await expect(row.button).toHaveText('Repair');
  await row.button.click();
  await expect(row.badge).toHaveText('Installed');
  await expect(page.locator('#notion-restart-row')).toBeVisible();
  await page.locator('#notion-restart-btn').click();
  await expect.poll(async () => (await ns.calls()).notionOther).toContain('restart');
});

test('Repair with Notion closed has nothing to restart', async ({ page, ns }) => {
  await ns.reset({ notion: { status: 'needs-repair', running: false } });
  await page.goto('/settings.html');
  await notionRow(page).button.click();
  await expect(notionRow(page).badge).toHaveText('Installed');
  await expect(page.locator('#notion-restart-row')).toBeHidden();
});

test('when macOS blocks the install, the page explains App Management and opens its settings', async ({ page, ns }) => {
  await ns.reset({ notion: { status: 'not-installed', runResult: 'app-management' } });
  await page.goto('/settings.html');
  await notionRow(page).button.click();
  await expect(notionRow(page).error).toContainText('App Management');
  await expect(notionRow(page).badge).toHaveText('Not installed');
  await page.locator('#notion-settings-btn').click();
  await expect.poll(async () => (await ns.calls()).notionOther).toContain('openAppManagement');
});

test('any other failure shows the reason and where the log is', async ({ page, ns }) => {
  await ns.reset({ notion: { status: 'not-installed', runResult: 'error', runError: 'Disk is full.' } });
  await page.goto('/settings.html');
  await notionRow(page).button.click();
  await expect(notionRow(page).error).toContainText("Couldn't install into Notion: Disk is full.");
  await expect(notionRow(page).error).toContainText('~/.notiskin/logs/inject.log');
});

test('a Notion Notiskin cannot theme, or none at all, has no button', async ({ page, ns }) => {
  await ns.reset({ notion: { status: 'unsupported' } });
  await page.goto('/settings.html');
  await expect(notionRow(page).badge).toHaveText('Not supported yet');
  await expect(notionRow(page).button).toBeHidden();
  await ns.reset({ notion: { status: 'notion-missing' } });
  await page.reload();
  await expect(notionRow(page).badge).toHaveText('Notion not found');
  await expect(notionRow(page).button).toBeHidden();
});

test('"Hold back a Notion Notiskin can\'t theme" turns off and on', async ({ page, ns }) => {
  await ns.reset({ notion: { status: 'installed' } });
  await page.goto('/settings.html');
  await expect(page.locator('#native-badge')).toHaveText('On');
  await page.locator('#native-btn').click();
  await expect(page.locator('#native-badge')).toHaveText('Off');
  await expect.poll(async () => (await ns.calls()).config.blockNativeNotion).toBe(false);
  await page.locator('#native-btn').click();
  await expect(page.locator('#native-badge')).toHaveText('On');
});

// ---- safe mode ----

test('safe mode pauses everything, shows a notice on Themes and Plugins, and Turn off there ends it', async ({ page, ns }) => {
  await ns.reset({ themes: { alpha: ':root {}\n' }, config: { activeTheme: 'alpha' } });
  await page.goto('/settings.html');
  await expect(page.locator('#safe-badge')).toHaveText('Off');
  await page.locator('#safe-btn').click();
  await expect(page.locator('#safe-badge')).toHaveText('On');
  await expect(page.locator('.notif')).toContainText('Safe mode on');
  const calls = await ns.calls();
  expect(calls.config.safeMode).toBe(true);
  // the active theme is kept, only paused
  expect(calls.config.activeTheme).toBe('alpha');
  expect(calls.applyConfig).toContainEqual({ reload: true });

  for (const path of ['/', '/plugins.html']) {
    await page.goto(path);
    await expect(page.locator('#safe-mode-notice')).toBeVisible();
  }
  await page.locator('#safe-mode-notice').getByRole('button', { name: 'Turn off' }).click();
  await expect(page.locator('#safe-mode-notice')).toBeHidden();
  await expect.poll(async () => (await ns.calls()).config.safeMode).toBe(false);
});

test('safe mode stays on after the page is reopened', async ({ page, ns }) => {
  await ns.reset({ config: { safeMode: true } });
  await page.goto('/settings.html');
  await expect(page.locator('#safe-badge')).toHaveText('On');
  await expect(page.locator('#safe-btn')).toHaveText('Turn off');
});

// ---- developer mode ----

test('developer mode needs a folder first', async ({ page, ns }) => {
  await page.goto('/settings.html');
  await expect(page.locator('#dev-badge')).toHaveText('Off');
  await page.locator('#dev-btn').click();
  await expect(page.locator('.notif')).toContainText('Choose the plugins folder first');
  await expect(page.locator('#dev-folder')).toBeFocused();
  expect((await ns.calls()).config.developerMode).toBeUndefined();
});

// ---- updates, help ----

test('the update section says a new version is out, with a Download link and no promise to install it', async ({ page }) => {
  await page.route('**/api/update-status', route => route.fulfill({ json: { state: 'available', version: '9.9.9' } }));
  await page.goto('/settings.html');
  await expect(page.locator('#banner-text')).toHaveText('Notiskin 9.9.9 is out');
  await expect(page.locator('#update-badge')).toHaveText('Update available');
  await expect(page.locator('#install-version-label')).toHaveText('Notiskin 9.9.9 is out');
  await expect(page.locator('#install-row')).toContainText('Download');
  await expect(page.locator('#install-row')).not.toContainText(/Install|Restart|Ready/);
});

test('the docs button opens the docs in the browser', async ({ page, ns }) => {
  await page.goto('/settings.html');
  await page.locator('#docs-btn').click();
  await expect.poll(async () => (await ns.calls()).fakebin).toContain('open https://notiskin.github.io/');
});

test('Clear themes empties the folder', async ({ page, ns }) => {
  await ns.reset({ themes: { alpha: ':root {}\n', beta: ':root {}\n' } });
  await page.goto('/settings.html');
  await page.locator('[data-click="clearCache"][data-click-args=\'["themes"]\']').click();
  await expect(page.locator('.notif')).toContainText('Themes cache cleared');
  await expect.poll(async () => (await ns.calls()).themeFiles).toEqual([]);
});
