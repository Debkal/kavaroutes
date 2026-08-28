import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: true,
  forbidOnly: true,
  reporter: "line",
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
