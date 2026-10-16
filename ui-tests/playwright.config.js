const { defineConfig } = require("@playwright/test");
const path = require("node:path");

module.exports = defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: process.env.EVIDENCE_BASE_URL
    ? undefined
    : {
        command: `"${process.env.EVIDENCE_PYTHON || "python"}" -m evidencedesk --port 8011`,
        cwd: path.resolve(__dirname, ".."),
        url: "http://127.0.0.1:8011/api/health",
        reuseExistingServer: !process.env.CI,
        timeout: 60000,
        env: { EVIDENCE_MODE: "bm25", EVIDENCE_DB: "data/browser-tests.db" },
      },
  use: {
    baseURL: process.env.EVIDENCE_BASE_URL || "http://127.0.0.1:8011",
    browserName: "chromium",
    viewport: { width: 1440, height: 1050 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
