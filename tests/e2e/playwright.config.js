const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.js',
  retries: 0,
  use: { headless: true, baseURL: 'http://localhost:5173' },
  webServer: [
    {
      command: 'npm run dev',
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 120000
    }
  ]
})
