import { expect, test, type APIResponse, type Page } from "@playwright/test";

const requiredUrl = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the dual web artifact acceptance suite`);
  }
  return value.replace(/\/$/, "");
};

const mainBaseUrl = requiredUrl("E2E_MAIN_ARTIFACT_URL");
const aiBaseUrl = requiredUrl("E2E_AI_ARTIFACT_URL");

const securityHeaders = [
  "content-security-policy",
  "permissions-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy"
] as const;

const expectSecurityHeaders = async (response: APIResponse) => {
  const headers = response.headers();
  for (const name of securityHeaders) {
    expect(headers[name], `${response.url()} missing ${name}`).toBeTruthy();
  }
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
};

const watchBrowserFailures = (page: Page) => {
  const browserErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  return () => {
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
    expect(serverErrors, serverErrors.join("\n")).toEqual([]);
  };
};

test.describe("separate main and AI web artifacts", () => {
  test("main happy path keeps the policy questionnaire interactive", async ({
    page
  }) => {
    const expectNoFailures = watchBrowserFailures(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const response = await page.goto(mainBaseUrl);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle("赔了么 - 牛马身价预评估");
    await expect(page.getByText("AI 深度分析版")).toHaveCount(0);
    await page.getByRole("button", { name: "上海", exact: true }).click();
    await expect(page.locator(".composer input[type=month]")).toBeVisible();
    expectNoFailures();
  });

  test("AI happy path renders its own shell and main-site link", async ({ page }) => {
    const expectNoFailures = watchBrowserFailures(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const response = await page.goto(aiBaseUrl);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle("赔了么 AI - 离职补偿深度分析");
    await expect(page.getByText("AI 深度分析版", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "把材料、金额和风险一次讲清楚" })
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "政策测算" })).toHaveAttribute(
      "href",
      "https://peileme.art"
    );
    await expect(page.getByRole("button", { name: "上海", exact: true })).toHaveCount(
      0
    );
    expectNoFailures();
  });

  test("both images proxy API and retain SPA/admin routes after refresh", async ({
    page
  }) => {
    for (const baseUrl of [mainBaseUrl, aiBaseUrl]) {
      const health = await page.request.get(`${baseUrl}/api/health`);
      expect(health.status()).toBe(200);
      await expectSecurityHeaders(health);

      const deepLink = await page.goto(`${baseUrl}/history/e2e-refresh`);
      expect(deepLink?.status()).toBe(200);
      await expect(page.locator("#root")).not.toBeEmpty();

      const admin = await page.goto(`${baseUrl}/admin`);
      expect(admin?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: "赔了么管理后台" })).toBeVisible();
      await expect(page.getByRole("button", { name: "管理员登录" })).toBeVisible();
    }
  });

  test("HTML, static assets, API and static 404 retain security headers", async ({
    page
  }) => {
    for (const baseUrl of [mainBaseUrl, aiBaseUrl]) {
      const html = await page.request.get(baseUrl);
      expect(html.status()).toBe(200);
      await expectSecurityHeaders(html);

      const htmlSource = await html.text();
      const assetPath = htmlSource.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
      expect(assetPath, `${baseUrl} did not expose a built asset`).toBeTruthy();
      const asset = await page.request.get(`${baseUrl}${assetPath}`);
      expect(asset.status()).toBe(200);
      await expectSecurityHeaders(asset);

      const missingAsset = await page.request.get(
        `${baseUrl}/assets/definitely-missing-e2e.js`
      );
      expect(missingAsset.status()).toBe(404);
      await expectSecurityHeaders(missingAsset);

      const missingApi = await page.request.get(`${baseUrl}/api/definitely-missing-e2e`);
      expect(missingApi.status()).toBe(404);
      await expectSecurityHeaders(missingApi);
    }
  });

  test("a refresh session created on main is accepted by the AI site", async ({
    page
  }) => {
    const target = `dual-artifact-${Date.now()}@peileme.test`;
    const origin = new URL(mainBaseUrl).origin;
    const sent = await page.request.post(`${mainBaseUrl}/api/auth/send-code`, {
      headers: { Origin: origin },
      data: { target, purpose: "register" }
    });
    expect(sent.status()).toBe(201);
    const { debugCode } = (await sent.json()) as { debugCode?: string };
    expect(debugCode).toMatch(/^\d{6}$/);

    const registered = await page.request.post(`${mainBaseUrl}/api/auth/register`, {
      headers: { Origin: origin },
      data: {
        target,
        code: debugCode,
        password: "DualArtifact123",
        displayName: "双站验收用户"
      }
    });
    expect(registered.status()).toBe(201);

    const meResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/me") && response.status() === 200
    );
    await page.goto(aiBaseUrl);
    await meResponse;
    await expect(page.getByText("AI 深度分析版", { exact: true })).toBeVisible();
  });
});
