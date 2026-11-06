const { test, expect } = require('./fixtures');

const card = page => page.locator('.tour-card');

// the tour ignores a click while it is moving between steps, so click the button until the step changes
// (only while the step is still the old one, so it can never go two steps)
async function go(page, button, from, to) {
  await expect(async () => {
    if ((await card(page).locator('.tour-title').innerText()) === from) await card(page).getByRole('button', { name: button }).click({ timeout: 1000 });
    await expect(card(page).locator('.tour-title')).toHaveText(to, { timeout: 800 });
  }).toPass({ timeout: 10_000 });
}

test('a new person with no Notion set up gets the welcome tour on its own', async ({ page, ns }) => {
  await ns.reset({ config: { setupDone: false }, notion: { status: 'not-installed' } });
  await page.goto('/');
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('.tour-title')).toHaveText('Welcome to Notiskin');
  await expect(card(page).locator('.tour-count')).toContainText('1 of');
});

test('someone whose Notion is already set up is not interrupted', async ({ page, ns }) => {
  await ns.reset({ config: { setupDone: false }, notion: { status: 'installed' } });
  await page.goto('/');
  await expect(page.locator('#theme-list, #themes-list')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test('someone who finished the tour before is not shown it again', async ({ page, ns }) => {
  await ns.reset({ config: { setupDone: true }, notion: { status: 'not-installed' } });
  await page.goto('/');
  await expect(page.locator('#themes-list')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test('Close ends the tour for good', async ({ page, ns }) => {
  await ns.reset({ config: { setupDone: false }, notion: { status: 'not-installed' } });
  await page.goto('/');
  await expect(card(page)).toBeVisible();
  await card(page).locator('.tour-close').click();
  await expect(card(page)).toHaveCount(0);
  await expect.poll(async () => (await ns.calls()).config.setupDone).toBe(true);
  await page.reload();
  await expect(page.locator('#themes-list')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test('Next and Back move through the steps, across pages, and the last one is Install into Notion', async ({ page, ns }) => {
  await ns.reset({ config: { setupDone: false }, notion: { status: 'not-installed' } });
  await page.goto('/');
  await expect(card(page).locator('.tour-title')).toHaveText('Welcome to Notiskin');
  await go(page, 'Show me around', 'Welcome to Notiskin', 'Your themes');
  await expect(card(page).locator('.tour-count')).toContainText('2 of');
  await go(page, 'Back', 'Your themes', 'Welcome to Notiskin');
  await go(page, 'Show me around', 'Welcome to Notiskin', 'Your themes');

  const count = card(page).locator('.tour-count');
  const total = Number((await count.innerText()).match(/of (\d+)/)[1]);
  const seen = new Set();
  for (let i = 2; i <= total; i++) {
    await expect(count).toHaveText(new RegExp(`^${i} of ${total}$`));
    seen.add(page.url().replace(/^.*localhost:3845/, '') || '/');
    if (i === total) break;
    // the tour ignores a click while it is moving, so click until it has moved, never twice
    await expect(async () => {
      if ((await count.innerText()).startsWith(`${i} `)) await card(page).locator('.tour-next').click({ timeout: 1000 });
      await expect(count).toHaveText(new RegExp(`^${i + 1} of`), { timeout: 800 });
    }).toPass({ timeout: 10_000 });
  }
  // it went through every page
  expect([...seen].sort()).toEqual(['/', '/plugins.html', '/settings.html']);
  await expect(card(page).locator('.tour-title')).toContainText('Install into Notion');
  await expect(async () => {
    if (await card(page).count()) await card(page).locator('.tour-next').click({ timeout: 1000 });
    await expect(card(page)).toHaveCount(0, { timeout: 800 });
  }).toPass({ timeout: 10_000 });
  await expect.poll(async () => (await ns.calls()).config.setupDone).toBe(true);
});

test('Settings can replay the tour', async ({ page, ns }) => {
  await ns.reset({ config: { setupDone: true } });
  await page.goto('/settings.html');
  await page.getByRole('button', { name: /tour/i }).click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('.tour-title')).toHaveText('Welcome to Notiskin');
});
