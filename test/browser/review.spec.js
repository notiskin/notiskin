const { test, expect } = require('./fixtures');

const QUEUE = {
  themes: [{ id: 't1', name: 'fancy theme', author_github: 'maker', description: 'Pretty colors', css: ':root { --ns-bg: #fdf6e3; }', rejection_reason: null }],
  plugins: [{ id: 'p1', name: 'counter', author_github: 'maker', description: 'Counts', js: 'notiskin.ready(() => {});' }],
  rejectedThemes: [], rejectedPlugins: [],
  versions: [{ id: 'v1', item_id: 'p1', item_type: 'plugin', name: 'counter', version: 2, author_github: 'maker', changelog: 'Counts headings', previous_code: 'a\nb', code: 'a\nc' }],
  reports: [
    { id: 'r1', item_id: 'live-1', item_type: 'theme', item_status: 'approved', name: 'sunset', reason: 'harmful', note: 'steals data', reporter_github: 'someone', created_at: '2026-11-01T00:00:00Z', counts_for_hiding: true },
  ],
  actions: [{ created_at: '2026-11-02T00:00:00Z', actor_github: 'boss', action: 'approve', item_type: 'theme', item_id: 'x', name: 'old theme' }],
};

const reviewer = (ns, queue = QUEUE) => ns.reset({ supabase: { functions: { 'review-pending': { status: 200, json: queue } } } });
const decisions = async ns => (await ns.calls()).supabase.filter(c => c.path === '/functions/v1/review-decide').map(c => JSON.parse(c.body));
const queueLoads = async ns => (await ns.calls()).supabase.filter(c => c.path === '/functions/v1/review-pending').length;

test('signed out, Review sends you to Settings', async ({ page }) => {
  await page.goto('/review.html');
  await expect(page.locator('#login-section')).toContainText('Sign in with GitHub in Settings');
  await expect(page.locator('#queue')).toBeHidden();
});

test('someone who is not a reviewer sees that, and no queue', async ({ page, ns }) => {
  page.expectErrors(/403/);
  await ns.reset({ supabase: { functions: { 'review-pending': { status: 403, json: { error: 'no' } } } } });
  await page.signIn('tester');
  await page.goto('/review.html');
  await expect(page.locator('#unauthorized')).toContainText("doesn't have reviewer access");
  await expect(page.locator('#review-tabs-area')).toBeHidden();
});

test('a reviewer sees what waits for a decision, counted on the tabs', async ({ page, ns }) => {
  await reviewer(ns);
  await page.signIn('boss');
  await page.goto('/review.html');
  await expect(page.locator('#username-display')).toHaveText('boss');
  const themes = page.locator('#themes-list .card');
  await expect(themes).toHaveCount(1);
  await expect(themes).toContainText('fancy theme');
  await expect(themes).toContainText('by maker');
  await expect(themes).toContainText('--ns-bg: #fdf6e3');
  // a theme tab count: the pending theme and the reported live one
  await expect(page.locator('#count-theme')).toHaveText('2');
  // the plugin tab: the pending plugin and its new version
  await expect(page.locator('#count-plugin')).toHaveText('2');
  await expect(page.locator('#log-list')).toContainText('old theme');
});

test('the Plugins tab shows pending plugins and versions with a line diff', async ({ page, ns }) => {
  await reviewer(ns);
  await page.signIn('boss');
  await page.goto('/review.html');
  await expect(page.locator('#pane-plugin')).toBeHidden();
  await page.locator('#review-tabs [data-tab=plugin]').click();
  await expect(page.locator('#pane-plugin')).toBeVisible();
  await expect(page.locator('#pane-theme')).toBeHidden();
  await expect(page.locator('#plugins-list .card')).toContainText('counter');
  const version = page.locator('#versions-list-plugin .card');
  await expect(version).toContainText('counter, version 2 (plugin)');
  await expect(version).toContainText('Counts headings');
  await expect(version.locator('.diff')).toContainText('c');
});

test('Approve sends the decision for that item and loads the queue again', async ({ page, ns }) => {
  await reviewer(ns);
  await page.signIn('boss');
  await page.goto('/review.html');
  const before = await queueLoads(ns);
  await page.locator('#themes-list .card').getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => decisions(ns)).toEqual([{ type: 'theme', id: 't1', status: 'approved', reason: null }]);
  await expect.poll(() => queueLoads(ns)).toBeGreaterThan(before);
});

test('Reject needs a reason, and Cancel puts the buttons back', async ({ page, ns }) => {
  await reviewer(ns);
  await page.signIn('boss');
  await page.goto('/review.html');
  const card = page.locator('#themes-list .card');
  await card.getByRole('button', { name: 'Reject', exact: true }).click();
  const confirm = card.getByRole('button', { name: 'Reject submission' });
  await expect(confirm).toBeDisabled();
  await card.getByPlaceholder('Reason for rejecting this').fill('Loads an image from the web');
  await expect(confirm).toBeEnabled();
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible();
  expect(await decisions(ns)).toEqual([]);

  await card.getByRole('button', { name: 'Reject', exact: true }).click();
  await card.getByPlaceholder('Reason for rejecting this').fill('Loads an image from the web');
  await card.getByRole('button', { name: 'Reject submission' }).click();
  await expect.poll(() => decisions(ns)).toEqual([{ type: 'theme', id: 't1', status: 'rejected', reason: 'Loads an image from the web' }]);
});

test('a version is decided with its own id', async ({ page, ns }) => {
  await reviewer(ns);
  await page.signIn('boss');
  await page.goto('/review.html');
  await page.locator('#review-tabs [data-tab=plugin]').click();
  await page.locator('#versions-list-plugin .card').getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => decisions(ns)).toEqual([{ type: 'plugin', version_id: 'v1', status: 'approved', reason: null }]);
});

test('a reported live theme can be hidden, and a report dismissed', async ({ page, ns }) => {
  await reviewer(ns);
  await page.signIn('boss');
  await page.goto('/review.html');
  const reported = page.locator('#reports-list-theme .card');
  await expect(reported).toContainText('sunset (theme)');
  await expect(reported).toContainText('1 report, 1 harmful');
  await expect(reported).toContainText('steals data');
  await reported.getByRole('button', { name: 'Hide' }).click();
  await expect.poll(() => decisions(ns)).toEqual([{ action: 'hide', type: 'theme', id: 'live-1', reason: 'Reported (1 report, 1 harmful)' }]);
  await reported.getByRole('button', { name: 'Dismiss' }).click();
  await expect.poll(async () => (await decisions(ns)).at(-1)).toEqual({ action: 'dismiss_report', report_id: 'r1' });
});

test('a refused decision shows the reason and keeps the buttons usable', async ({ page, ns }) => {
  page.expectErrors(/403|500/);
  await ns.reset({ supabase: { functions: { 'review-pending': { status: 200, json: QUEUE }, 'review-decide': { status: 500, json: { error: 'The decision saved but the log did not' } } } } });
  await page.signIn('boss');
  await page.goto('/review.html');
  page.once('dialog', dialog => { expect(dialog.message()).toBe('The decision saved but the log did not'); dialog.accept(); });
  await page.locator('#themes-list .card').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('#themes-list .card').getByRole('button', { name: 'Approve' })).toBeEnabled();
});
