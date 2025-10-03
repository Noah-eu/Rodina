const { test, expect } = require('@playwright/test')

// Happy path minimal: just confirms landing page text appears.
// Real flows (register/login/message/call) require media permissions and backend running with storage.
// This keeps CI green and verifies the app loads.

test('app loads and shows welcome', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Vítejte v Rodině')).toBeVisible()
})
