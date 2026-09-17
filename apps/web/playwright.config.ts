import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: true,
  forbidOnly: true,
  // GitHub's ubuntu-24.04 runners get 4 vCPU. Playwright's default is
  // `cpus/2`, which is 2 here, but `fullyParallel` already lets every one of the
  // 35 tests start at once and the first browser launch on a cold container is
  // slow: on the pinned 1.62.1 image, firefox-1280's `Fixture "page"` exceeded
  // the 30s test timeout while it was still launching browsers (the setup is
  // charged to the test). Two workers cap that burst and remove the only
  // failure in the lane. Do not raise this without re-timing a cold container.
  workers: process.env.CI ? 2 : undefined,
  reporter: [["line"], ["json", { outputFile: "test-results/playwright-results.json" }]],
  use: { baseURL: "http://127.0.0.1:4312", trace: "retain-on-failure" },
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:4312",
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "firefox-1280", use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 720 } } },
    { name: "webkit-1024", use: { ...devices["Desktop Safari"], viewport: { width: 1024, height: 768 } } },
    { name: "chromium-narrow", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
    { name: "chromium-wide", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } }
  ],
});
