const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const createdIds = new Set();
const apiHeaders = process.env.EVIDENCE_API_TOKEN
  ? { Authorization: `Bearer ${process.env.EVIDENCE_API_TOKEN}` }
  : {};

test.beforeEach(async ({ page }) => {
  if (process.env.EVIDENCE_API_TOKEN) {
    await page.addInitScript(
      (token) => sessionStorage.setItem("evidencedesk-token", token),
      process.env.EVIDENCE_API_TOKEN,
    );
  }
});

test.afterEach(async ({ request }) => {
  for (const id of createdIds)
    await request.delete(`/api/documents/${id}`, { headers: apiHeaders });
  createdIds.clear();
});

async function openWorkspace(page, view = "workbench") {
  await page.goto(`/#${view}`);
  await expect(page.getByText(/Connected · (local|protected)/)).toBeVisible();
  await expect(page.locator("#global-error")).toBeHidden();
}

test("retrieves actual source passages and preserves an inspectable history record", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/documents", {
    headers: apiHeaders,
    data: {
      title: `Browser verification ${Date.now()}`,
      content:
        "Cobalt telescope warranty policy. Cobalt telescopes include a warranty of exactly seventeen months. A Cobalt telescope warranty claim requires the serial number and purchase receipt. This policy only covers Cobalt telescopes.",
    },
  });
  expect(response.ok()).toBeTruthy();
  const source = await response.json();
  createdIds.add(source.id);
  await openWorkspace(page);
  await page.getByLabel("Search method").selectOption("bm25");
  await page
    .getByLabel("What would you like to know?")
    .fill("What is the Cobalt telescope warranty?");
  await page.getByRole("button", { name: "Find evidence" }).click();
  await expect(page.locator("#answer-status")).toHaveText("Evidence found");
  await expect(page.locator("#answer-text")).toContainText("seventeen months");
  await expect(
    page.locator(".citation-card").filter({ hasText: source.title }).first(),
  ).toContainText("seventeen months");
  await expect(page.locator("#answer-method")).toContainText("BM25");
  await expect(page.locator("#answer-latency")).toContainText("ms");
  const answerAccessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(answerAccessibility.violations).toEqual([]);
  await page
    .getByRole("button", {
      name: `Read source document: ${source.title}`,
      exact: true,
    })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: source.title })).toBeVisible();
  await expect(page.locator(".document-content")).toContainText(
    "purchase receipt",
  );
  await page.getByRole("link", { name: /^Workbench/ }).click();
  await page
    .locator(".history-item")
    .filter({ hasText: "What is the Cobalt telescope warranty?" })
    .first()
    .click();
  await expect(page.locator("#answer-text")).toContainText("seventeen months");
});

test("abstains for unsupported questions instead of showing a fabricated answer", async ({
  page,
}) => {
  await openWorkspace(page);
  await page.getByLabel("Search method").selectOption("bm25");
  await page
    .getByLabel("What would you like to know?")
    .fill("What is the atmospheric composition of the exoplanet Kepler-9999z?");
  await page.getByRole("button", { name: "Find evidence" }).click();
  await expect(page.locator("#answer-status")).toHaveText("Abstained");
  await expect(page.locator("#answer-reason")).toBeVisible();
  await expect(page.locator("#citation-count")).toHaveText("0");
  await expect(page.locator(".no-citations")).toBeVisible();
});

test("creates, versions, filters and deletes a document without executing source markup", async ({
  page,
  request,
}) => {
  await openWorkspace(page, "knowledge");
  const title = `UI lifecycle ${Date.now()}`;
  const markup = '<img src=x onerror="window.sourceExecuted = true">';
  await page.getByRole("button", { name: "Add document", exact: true }).click();
  await page.getByLabel("Document title", { exact: true }).fill(title);
  await page
    .getByLabel("Source content")
    .fill(
      `Cobalt telescope service notes. ${markup} Replacement telescope mirrors ship after inspection.`,
    );
  await page.getByRole("button", { name: "Add to library" }).click();
  await expect(
    page.getByRole("dialog", { name: "Add a document" }),
  ).toBeHidden();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const documentResponse = await request.get("/api/documents", {
    headers: apiHeaders,
  });
  const source = (await documentResponse.json()).documents.find(
    (doc) => doc.title === title,
  );
  expect(source).toBeTruthy();
  createdIds.add(source.id);
  await expect(page.locator(".document-content")).toContainText(markup);
  await expect(page.locator("#document-inspector img")).toHaveCount(0);
  expect(await page.evaluate(() => window.sourceExecuted)).toBeUndefined();
  await page.getByRole("button", { name: "Edit source" }).click();
  const editAccessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(editAccessibility.violations).toEqual([]);
  await page
    .getByLabel("Edit source content")
    .fill(
      "Cobalt telescope service notes. Replacement telescope mirrors ship within nine working days after inspection.",
    );
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.locator("#document-inspector .tag")).toHaveText(
    "Version 2",
  );
  await expect(page.locator(".document-content")).toContainText(
    "nine working days",
  );
  await page.getByLabel("Filter documents").fill(title);
  await expect(page.locator(".document-item")).toHaveCount(1);
  await page.getByRole("button", { name: `Delete document: ${title}` }).click();
  await expect(
    page.getByRole("dialog", { name: "Delete this document?" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete document", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Delete this document?" }),
  ).toBeHidden();
  await expect(page.locator(".document-item")).toHaveCount(0);
  const remaining = await request.get("/api/documents", {
    headers: apiHeaders,
  });
  expect(
    (await remaining.json()).documents.some((doc) => doc.id === source.id),
  ).toBeFalsy();
  createdIds.delete(source.id);
});

test("keeps edits when an optimistic version conflict occurs", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/documents", {
    headers: apiHeaders,
    data: {
      title: `Version conflict ${Date.now()}`,
      content: "Cobalt warranty original service terms.",
    },
  });
  expect(response.ok()).toBeTruthy();
  const source = await response.json();
  createdIds.add(source.id);
  await openWorkspace(page, "knowledge");
  await page
    .locator(".document-item")
    .filter({ hasText: source.title })
    .click();
  await page.getByRole("button", { name: "Edit source" }).click();
  const inProgress =
    "Cobalt warranty changes being edited in this browser tab.";
  await page.getByLabel("Edit source content").fill(inProgress);
  const remote = await request.put(`/api/documents/${source.id}`, {
    headers: apiHeaders,
    data: {
      content: "Cobalt warranty changes saved from another session.",
      expected_version: 1,
    },
  });
  expect(remote.ok()).toBeTruthy();
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.locator("#document-inspector .form-error")).toContainText(
    "Your edits are still here",
  );
  await expect(page.getByLabel("Edit source content")).toHaveValue(inProgress);
});

test("renders recorded evaluation metrics from the API and discloses the synthetic scope", async ({
  page,
  request,
}) => {
  const response = await request.get("/api/evaluations", {
    headers: apiHeaders,
  });
  const report = await response.json();
  await openWorkspace(page, "quality");
  await expect(
    page.getByText("Retrieval evaluation. No generative-model claims.", {
      exact: true,
    }),
  ).toBeVisible();
  if (report.status === "complete" && report.modes?.length) {
    await expect(page.getByRole("table")).toBeVisible();
    for (const mode of report.modes) {
      const label =
        mode.mode === "bm25"
          ? "BM25 · keyword"
          : mode.mode === "dense"
            ? "MiniLM · semantic"
            : "Hybrid · MiniLM + BM25";
      const row = page.locator(".evaluation-table tbody tr").filter({
        has: page.getByRole("rowheader", { name: label, exact: true }),
      });
      await expect(row).toContainText(
        `${(mode.recall_at_3 * 100).toFixed(1)}%`,
      );
    }
    await expect(page.getByText(/synthetic holdout cases/)).toBeVisible();
  } else
    await expect(
      page.getByText("No completed evaluation report is available.", {
        exact: false,
      }),
    ).toBeVisible();
});

test("offers keyboard navigation, named dialogs and escape dismissal", async ({
  page,
}) => {
  await openWorkspace(page);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await page.getByRole("button", { name: "Connection", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Connection settings" }),
  ).toBeVisible();
  await expect(page.getByLabel("API token")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Connection settings" }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Connection", exact: true }),
  ).toBeFocused();
});

test("shows an actionable network failure and preserves the question for retry", async ({
  page,
}) => {
  await openWorkspace(page);
  await page.route("**/api/query", (route) => route.abort("connectionrefused"));
  const question = "Can I request a refund?";
  await page.getByLabel("What would you like to know?").fill(question);
  await page.getByRole("button", { name: "Find evidence" }).click();
  await expect(page.locator("#global-error")).toContainText(
    "Cannot reach the workspace",
  );
  await expect(page.getByLabel("What would you like to know?")).toHaveValue(
    question,
  );
  await expect(
    page.getByRole("button", { name: "Find evidence" }),
  ).toBeEnabled();
  await expect(page.locator("#answer-panel")).toBeHidden();
});

test("handles a simulated protected API and stores a token only in tab session storage", async ({
  page,
}) => {
  const sampleToken = "synthetic-browser-test-token-not-a-secret";
  let authorizedRequests = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          mode: "bm25",
          model: null,
          documents: 0,
          chunks: 0,
          auth_required: true,
          version: "1.0.0",
        },
      });
    if (route.request().headers().authorization !== `Bearer ${sampleToken}`)
      return route.fulfill({ status: 401, json: { detail: "Token required" } });
    authorizedRequests++;
    if (url.pathname === "/api/documents")
      return route.fulfill({ json: { documents: [] } });
    if (url.pathname === "/api/history")
      return route.fulfill({ json: { queries: [] } });
    return route.fulfill({ json: { status: "not_run" } });
  });
  await page.goto("/");
  await expect(
    page.getByRole("dialog", { name: "Connection settings" }),
  ).toBeVisible();
  await page.getByLabel("API token").fill(sampleToken);
  await page.getByRole("button", { name: "Save and connect" }).click();
  await expect(
    page.getByRole("dialog", { name: "Connection settings" }),
  ).toBeHidden();
  expect(
    await page.evaluate(() => sessionStorage.getItem("evidencedesk-token")),
  ).toBe(sampleToken);
  expect(
    await page.evaluate(() => localStorage.getItem("evidencedesk-token")),
  ).toBeNull();
  expect(authorizedRequests).toBeGreaterThanOrEqual(3);
  await page.reload();
  await expect(page.getByText("Connected · protected")).toBeVisible();
  await expect(page.locator("#global-error")).toBeHidden();
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 1050 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name} views have no automated WCAG A/AA violations or horizontal overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await openWorkspace(page);
    for (const view of ["workbench", "knowledge", "quality"]) {
      await page
        .getByRole("link", {
          name: new RegExp(`^${view[0].toUpperCase()}${view.slice(1)}`),
        })
        .click();
      await expect(page.locator(`#view-${view}`)).toBeVisible();
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(result.violations).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBeTruthy();
    }
    await page.getByRole("button", { name: "Connection", exact: true }).click();
    const dialogResult = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(dialogResult.violations).toEqual([]);
  });
}
