// @ts-check
// Real-browser tier: loads the unpacked extension into the system Google Chrome and drives
// keypresses against the fixture pages served at github.com URLs (see test/e2e/).
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "test/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Each test launches its own persistent browser context (required to load an extension),
  // so keep it serial and simple.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
