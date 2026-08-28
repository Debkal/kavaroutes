import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/benchmark",
  workers: 1,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:4312", ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
  webServer: { command: "npm run preview", url: "http://127.0.0.1:4312", reuseExistingServer: false },
});
