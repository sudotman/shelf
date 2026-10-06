import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.browser.spec.js",
  outputDir: "test-results",
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4329",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/build.js && node scripts/serve.js",
    url: "http://127.0.0.1:4329/catalog.json",
    env: { PORT: "4329" },
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-mobile", use: { ...devices["iPhone 13"] } },
  ],
});
