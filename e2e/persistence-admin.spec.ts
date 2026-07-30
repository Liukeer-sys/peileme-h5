import { expect, test } from "@playwright/test";

const userEmail = process.env.E2E_USER_EMAIL;
const userPassword = process.env.E2E_USER_PASSWORD;
const userButtonName = process.env.E2E_USER_BUTTON_NAME || "生产走查";
const adminEmail = process.env.E2E_ADMIN_EMAIL || "admin@peileme.art";
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const inviteCode = process.env.E2E_INVITE_CODE;

test("生产持久化、私有下载与管理后台回查", async ({ page, browser }) => {
  test.skip(
    !userEmail || !userPassword || !adminPassword || !inviteCode,
    "需要 E2E_USER_EMAIL、E2E_USER_PASSWORD、E2E_ADMIN_PASSWORD、E2E_INVITE_CODE"
  );
  const browserErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "密码登录" }).click();
  await page.getByLabel("邮箱 / 手机号").fill(userEmail!);
  await page.getByLabel("密码", { exact: true }).fill(userPassword!);
  await page.getByRole("dialog").getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: userButtonName })).toBeVisible();

  await page.getByRole("button", { name: userButtonName }).click();
  const inviteInput = page.getByPlaceholder("输入邀请码");
  await inviteInput.fill("INVALID-E2E");
  await page.getByRole("button", { name: "兑换" }).click();
  await expect(page.locator(".account-message")).toContainText("邀请码无效");
  if ((await page.getByText("✓ 案例法条包").count()) === 0) {
    await inviteInput.fill(inviteCode!);
    await page.getByRole("button", { name: "兑换" }).click();
    await expect(page.locator(".account-message")).toContainText("案例法条包");
  }
  await expect(page.getByText("✓ 案例法条包")).toBeVisible();
  await expect(page.getByText("✓ 离职证据包")).toBeVisible();
  await expect(page.getByText("✓ 文件签署分析")).toBeVisible();
  await expect(page.getByText(/上海 · 已完成/).first()).toBeVisible();
  const userUpload = page
    .getByRole("article")
    .filter({ hasText: "e2e-agreement.pdf" })
    .first();
  await expect(userUpload).toBeVisible();
  const [userDownloadResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/api/uploads/") &&
        response.url().endsWith("/download")
    ),
    userUpload.getByRole("button", { name: "下载", exact: true }).click()
  ]);
  expect(userDownloadResponse.status()).toBe(200);
  expect(userDownloadResponse.headers()["content-disposition"]).toContain(
    "e2e-agreement.pdf"
  );
  expect((await userDownloadResponse.body()).byteLength).toBeGreaterThan(0);
  await page.locator(".account-close").click();

  await page.reload();
  await expect(page.getByRole("button", { name: userButtonName })).toBeVisible();
  if (userEmail!.toLowerCase() !== adminEmail.toLowerCase()) {
    await page.goto("/admin");
    await expect(page.getByText("当前账号没有管理权限。")).toBeVisible();
  }

  const adminContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 }
  });
  const adminPage = await adminContext.newPage();
  const adminErrors: string[] = [];
  adminPage.on("console", (message) => {
    if (message.type() === "error") adminErrors.push(message.text());
  });
  adminPage.on("pageerror", (error) => adminErrors.push(error.message));
  await adminPage.goto("/admin");
  await adminPage.getByRole("button", { name: "管理员登录" }).click();
  await adminPage.getByRole("button", { name: "密码登录" }).click();
  await adminPage.getByLabel("邮箱 / 手机号").fill(adminEmail);
  await adminPage.getByLabel("密码", { exact: true }).fill(adminPassword!);
  await adminPage.getByRole("dialog").getByRole("button", { name: "登录", exact: true }).click();
  await expect(adminPage.getByRole("heading", { name: "经营概览" })).toBeVisible();

  await adminPage.getByRole("button", { name: /用户管理/ }).click();
  await expect(adminPage.getByText(userEmail!, { exact: true })).toBeVisible();
  await adminPage.getByRole("button", { name: /测算记录/ }).click();
  await expect(adminPage.getByText("上海", { exact: true }).first()).toBeVisible();
  await adminPage.getByRole("button", { name: /材料管理/ }).click();
  const uploadRow = adminPage
    .getByRole("row")
    .filter({ hasText: "e2e-agreement.pdf" })
    .first();
  await expect(uploadRow).toBeVisible();
  const [adminDownloadResponse] = await Promise.all([
    adminPage.waitForResponse(
      (response) =>
        response.url().includes("/api/admin/uploads/") &&
        response.url().endsWith("/download")
    ),
    uploadRow.getByRole("button", { name: "下载", exact: true }).click()
  ]);
  expect(adminDownloadResponse.status()).toBe(200);
  expect(adminDownloadResponse.headers()["content-disposition"]).toContain(
    "e2e-agreement.pdf"
  );
  expect((await adminDownloadResponse.body()).byteLength).toBeGreaterThan(0);
  await adminPage.getByRole("button", { name: /埋点统计/ }).click();
  await expect(adminPage.getByText("assessment_completed", { exact: true })).toBeVisible();
  await adminPage.getByRole("button", { name: /审计日志/ }).click();
  await expect(adminPage.getByText("upload.download", { exact: true }).first()).toBeVisible();
  await adminPage.getByRole("button", { name: /系统状态/ }).click();
  await expect(adminPage.getByText("已配置", { exact: true }).first()).toBeVisible();
  await adminPage.screenshot({
    path: "test-results/production-admin-system.png",
    fullPage: true
  });

  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  expect(serverErrors, serverErrors.join("\n")).toEqual([]);
  expect(adminErrors, adminErrors.join("\n")).toEqual([]);
  await adminContext.close();
});
