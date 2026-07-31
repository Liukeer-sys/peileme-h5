import { expect, test, type Browser, type Page } from "@playwright/test";

const mainUrl = process.env.E2E_MAIN_BASE_URL;
const aiUrl = process.env.E2E_AI_BASE_URL;
const adminEmail = process.env.E2E_ADMIN_EMAIL;
const adminPassword = process.env.E2E_ADMIN_PASSWORD;

const requireEnvironment = () => {
  if (!mainUrl || !aiUrl) {
    throw new Error(
      "E2E_MAIN_BASE_URL and E2E_AI_BASE_URL are required"
    );
  }
};

const assertHealthyChannel = async (
  page: Page,
  url: string,
  title: string,
  visibleCopy: string
) => {
  const serverErrors: string[] = [];
  page.on("pageerror", (error) => serverErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  const headers = response!.headers();
  expect(headers["content-security-policy"]).toContain(
    "default-src 'self'"
  );
  expect(headers["permissions-policy"]).toContain("camera=()");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
  expect(headers["referrer-policy"]).toBe(
    "strict-origin-when-cross-origin"
  );
  await expect(page).toHaveTitle(title);
  await expect(page.getByText(visibleCopy, { exact: false }).first())
    .toBeVisible();
  const health = await page.evaluate(async () => {
    const result = await fetch("/api/health");
    return {
      statusCode: result.status,
      body: (await result.json()) as {
        status: string;
        database: boolean;
      }
    };
  });
  expect(health).toEqual({
    statusCode: 200,
    body: expect.objectContaining({
      status: "healthy",
      database: true
    })
  });
  expect(serverErrors).toEqual([]);
};

const loginThroughChannel = async (browser: Browser, url: string) => {
  if (!adminEmail || !adminPassword) {
    throw new Error(
      "E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required"
    );
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${url}/admin/task9-deep-link`);
    await expect(
      page.getByText("请使用管理员账号登录。", { exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "管理员登录" }).click();
    const dialog = page.getByRole("dialog", { name: "登录赔了么" });
    await dialog.getByRole("button", { name: "密码登录" }).click();
    await dialog.getByLabel("邮箱 / 手机号").fill(adminEmail);
    await dialog.getByLabel("密码").fill(adminPassword);
    await dialog.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "经营概览" })
    ).toBeVisible();
    await expect(page.getByText("超级管理员", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /政策规则/ }).click();
    await expect(
      page.getByRole("heading", { name: "规则版本", exact: true })
    ).toBeVisible();
  } finally {
    await context.close();
  }
};

test.describe("local dual web Compose topology", () => {
  test("serves isolated main and AI HTML through one healthy API", async ({
    browser
  }) => {
    requireEnvironment();
    const mainContext = await browser.newContext();
    const aiContext = await browser.newContext();
    try {
      await assertHealthyChannel(
        await mainContext.newPage(),
        mainUrl!,
        "赔了么 - 牛马身价预评估",
        "赔了么"
      );
      await assertHealthyChannel(
        await aiContext.newPage(),
        aiUrl!,
        "赔了么 AI - 离职补偿深度分析",
        "AI 深度分析版"
      );
    } finally {
      await mainContext.close();
      await aiContext.close();
    }
  });

  test("logs the same seeded administrator in through both web proxies", async ({
    browser
  }) => {
    requireEnvironment();
    await loginThroughChannel(browser, mainUrl!);
    await loginThroughChannel(browser, aiUrl!);
  });
});
