const { test, expect } = require('@playwright/test');

test('registrace a přihlášení', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('text=Vítejte v Rodině')).toBeVisible()
});
