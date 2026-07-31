import { expect, test, type APIResponse, type Page } from "@playwright/test";

const requiredValue = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the dual web artifact acceptance suite`);
  }
  return value;
};

const requiredUrl = (name: string) => requiredValue(name).replace(/\/$/, "");
const mainBaseUrl = requiredUrl("E2E_MAIN_ARTIFACT_URL");
const aiBaseUrl = requiredUrl("E2E_AI_ARTIFACT_URL");
const adminEmail = requiredValue("E2E_ADMIN_EMAIL");
const adminPassword = requiredValue("E2E_ADMIN_PASSWORD");
const userEmail = process.env.E2E_USER_EMAIL?.trim();
const userPassword = process.env.E2E_USER_PASSWORD;

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
    const uploadRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/(?:admin\/)?uploads(?:\/|$|\?)/.test(request.url())) {
        uploadRequests.push(request.url());
      }
    });
    await page.setViewportSize({ width: 390, height: 844 });

    const response = await page.goto(mainBaseUrl);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle("赔了么 - 牛马身价预评估");
    await expect(page.getByText("AI 深度分析版")).toHaveCount(0);
    await expect(page.getByText("已上传材料", { exact: true })).toHaveCount(0);
    await expect(page.getByText("材料管理", { exact: true })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    const shanghai = page.getByRole("button", { name: "上海", exact: true });
    if (await shanghai.isEnabled()) {
      await shanghai.click();
      await expect(page.locator(".composer input[type=date]")).toBeVisible();
    } else {
      await page.getByRole("button", { name: "选择全部省市" }).click();
      const regionDialog = page.getByRole("dialog", { name: "选择工作地区" });
      await expect(regionDialog).toBeVisible();
      await regionDialog.getByLabel("搜索省份或城市").fill("上海");
      await regionDialog.getByRole("button", { name: "关闭" }).click();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${mainBaseUrl}/admin`);
    await expect(page.getByRole("heading", { name: "赔了么管理后台" })).toBeVisible();
    await expect(page.getByText("材料管理", { exact: true })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await page.getByRole("button", { name: "管理员登录" }).click();
    await expect(
      page.getByText("保存历史测算、兑换邀请码并管理账号。", { exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "密码登录" }).click();
    await page.getByLabel("邮箱 / 手机号").fill(adminEmail);
    await page.getByLabel("密码", { exact: true }).fill(adminPassword);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "登录", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "经营概览" })).toBeVisible();

    const adminTabs = [
      ["经营概览", "转化漏斗"],
      ["政策规则", "规则版本"],
      ["区域参数", "区域参数清单"],
      ["公告设置", "公告编排"],
      ["用户管理", "用户清单"],
      ["测算记录", "测算记录"],
      ["邀请码", "邀请码清单"],
      ["埋点统计", "近 30 天埋点"],
      ["审计日志", "管理操作审计"],
      ["运行日志", "应用错误日志"],
      ["系统状态", "运行状态"]
    ] as const;
    for (const [label, contentHeading] of adminTabs) {
      await page.getByRole("button", { name: new RegExp(label) }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: label, exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: contentHeading, exact: false }).first()
      ).toBeVisible();
      await expect(page.locator("#ai-document-upload-input")).toHaveCount(0);
      await expect(page.locator(".ai-review-entry")).toHaveCount(0);
      await expect(page.locator(".upload-box")).toHaveCount(0);
      await expect(page.locator(".upload-history-item")).toHaveCount(0);
    }
    await expect(page.getByText("材料管理", { exact: true })).toHaveCount(0);
    await expect(page.getByText("已上传材料", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("登录后可安全管理你上传的材料", { exact: false })
    ).toHaveCount(0);
    expect(uploadRequests).toEqual([]);
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
    await page.getByRole("button", { name: "登录并开始分析" }).click();
    await expect(
      page.getByText("登录后可进行离职补偿分析、文件签署审查", { exact: false })
    ).toBeVisible();
    await page.getByRole("button", { name: "获取验证码" }).click();
    await expect(page.locator(".account-message")).toContainText(
      "请输入邮箱或中国大陆手机号"
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
    const origin = new URL(mainBaseUrl).origin;
    if (userEmail && userPassword) {
      const loggedIn = await page.request.post(`${mainBaseUrl}/api/auth/login`, {
        headers: { Origin: origin },
        data: { identifier: userEmail, password: userPassword }
      });
      expect(loggedIn.status()).toBe(200);
    } else {
      const target = `dual-artifact-${Date.now()}@peileme.test`;
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
    }

    const meResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/me") && response.status() === 200
    );
    await page.goto(aiBaseUrl);
    await meResponse;
    await expect(
      page.getByRole("heading", { name: "离职补偿深度分析" })
    ).toBeVisible();
  });
});
