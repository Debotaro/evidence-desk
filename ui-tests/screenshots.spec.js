const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");

async function settle(page, view) {
  await expect(page.locator(`#view-${view}`)).toBeVisible();
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  await page.mouse.move(380, 15);
}

test("captures real desktop and mobile application states", async ({
  page,
  request,
}) => {
  test.skip(
    process.env.EVIDENCE_SCREENSHOTS !== "1",
    "Opt in against a disposable seeded workspace; capture resets query history.",
  );
  if (process.env.EVIDENCE_API_TOKEN)
    await page.addInitScript(
      (token) => sessionStorage.setItem("evidencedesk-token", token),
      process.env.EVIDENCE_API_TOKEN,
    );
  const directory = path.join(__dirname, "..", "docs", "screenshots");
  fs.mkdirSync(directory, { recursive: true });
  const headers = process.env.EVIDENCE_API_TOKEN
    ? { Authorization: `Bearer ${process.env.EVIDENCE_API_TOKEN}` }
    : {};
  // Explicitly opted-in only on our disposable, fictional development workspace.
  await request.delete("/api/history", { headers });
  await page.goto("/");
  await expect(page.getByText(/Connected · (local|protected)/)).toBeVisible();
  await page.getByLabel("Search method").selectOption("hybrid");
  await page
    .getByLabel("What would you like to know?")
    .fill("What is the atmospheric composition of the exoplanet Kepler-9999z?");
  await page.getByRole("button", { name: "Find evidence" }).click();
  await expect(page.locator("#answer-status")).toHaveText("Abstained");
  await page
    .getByLabel("What would you like to know?")
    .fill("How long do customers have to request a refund?");
  await page.getByRole("button", { name: "Find evidence" }).click();
  await expect(page.locator("#answer-status")).toHaveText("Evidence found");
  await expect(page.locator("#answer-panel")).toBeVisible();
  await expect(page.locator(".history-item")).toHaveCount(2);
  await settle(page, "workbench");
  await page.screenshot({
    path: path.join(directory, "workbench-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: /^Knowledge/ }).click();
  await page
    .locator(".document-item")
    .filter({ hasText: "Refund policy" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Refund policy", exact: true }),
  ).toBeVisible();
  await settle(page, "knowledge");
  await page.screenshot({
    path: path.join(directory, "knowledge-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: /^Quality/ }).click();
  await settle(page, "quality");
  await page.screenshot({
    path: path.join(directory, "quality-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: /^Workbench/ }).click();
  await settle(page, "workbench");
  await page.screenshot({
    path: path.join(directory, "workbench-mobile.png"),
    fullPage: true,
  });
});
