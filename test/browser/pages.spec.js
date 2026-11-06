const { test, expect } = require('./fixtures');

const PAGES = [
  ['/', 'Themes'],
  ['/plugins.html', 'Plugins'],
  ['/review.html', 'Review'],
  ['/settings.html', 'Settings'],
];

for (const [path, name] of PAGES) {
  test(`${name} loads with no console errors, and no script the policy would refuse`, async ({ page }) => {
    const violations = [];
    await page.exposeFunction('reportViolation', text => violations.push(text));
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => window.reportViolation(`${e.violatedDirective}: ${e.blockedURI}`)));
    await page.goto(path);
    await expect(page.locator(`.sidebar-link.active`)).toHaveText(name);
    // the extra check the fixture does is on console errors, a policy violation is also reported here by name
    await page.waitForLoadState('networkidle');
    expect(violations).toEqual([]);
  });

  test(`${name} follows the color scheme`, async ({ page }, testInfo) => {
    await page.goto(path);
    const [r, g, b] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number));
    const light = (r + g + b) / 3 > 128;
    expect(light, `page background rgb(${r}, ${g}, ${b}) in ${testInfo.project.name}`).toBe(testInfo.project.name === 'light');
  });
}

test('every page can reach the others from the sidebar', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Plugins' }).click();
  await expect(page).toHaveURL(/\/plugins\.html$/);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings\.html$/);
  await page.getByRole('link', { name: 'Themes' }).click();
  await expect(page).toHaveURL(/localhost:3845\/$/);
});

test('inline script and inline handlers are refused by the policy', async ({ page }) => {
  // the console says so, which is the point of this test
  page.expectErrors(/Content Security Policy/);
  await page.goto('/settings.html');
  const outcome = await page.evaluate(() => new Promise(resolve => {
    let blocked = 0;
    document.addEventListener('securitypolicyviolation', () => { blocked += 1; });
    const script = document.createElement('script');
    script.textContent = 'window.inlineRan = true';
    document.head.appendChild(script);
    const button = document.createElement('button');
    button.setAttribute('onclick', 'window.handlerRan = true');
    document.body.appendChild(button);
    button.click();
    setTimeout(() => resolve({ blocked, inlineRan: !!window.inlineRan, handlerRan: !!window.handlerRan }), 100);
  }));
  expect(outcome).toEqual({ blocked: 2, inlineRan: false, handlerRan: false });
});
