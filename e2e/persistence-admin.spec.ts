import { expect, test } from "@playwright/test";

const aiBaseUrl = process.env.E2E_AI_BASE_URL?.trim().replace(/\/$/, "");
const userEmail = process.env.E2E_USER_EMAIL;
const userPassword = process.env.E2E_USER_PASSWORD;
const userButtonName =
  process.env.E2E_AI_USER_BUTTON_NAME ||
  process.env.E2E_USER_BUTTON_NAME ||
  "生产走查";
const adminEmail = process.env.E2E_ADMIN_EMAIL || "admin@peileme.art";
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const expectNotifierConfigured =
  process.env.E2E_EXPECT_NOTIFIER_CONFIGURED !== "false";

test("AI 站材料持久化、私有下载与管理后台回查", async ({ page, browser }) => {
  test.skip(
    !aiBaseUrl || !userEmail || !userPassword || !adminPassword,
    "需要 E2E_AI_BASE_URL、E2E_USER_EMAIL、E2E_USER_PASSWORD、E2E_ADMIN_PASSWORD"
  );
  expect(userEmail!.toLowerCase()).not.toBe(adminEmail.toLowerCase());
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

  const login = async (email: string, password: string) => {
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "密码登录" }).click();
    await page.getByLabel("邮箱 / 手机号").fill(email);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "登录", exact: true })
      .click();
  };

  await page.goto(aiBaseUrl!);
  await login(userEmail!, userPassword!);
  await expect(page.getByRole("button", { name: userButtonName })).toBeVisible();

  await page.getByRole("button", { name: userButtonName }).click();
  const uploadInput = page.locator("#ai-document-upload-input");
  const uploadButton = page.getByRole("button", { name: "上传并保存" });
  await page.locator(".account-close").focus();
  await page.keyboard.press("Tab");
  await expect(uploadInput).toBeFocused();
  await expect(
    page.getByRole("link", { name: "进入 AI 管理后台 →" })
  ).toHaveCount(0);

  const pendingPrivateName = "user-a-private-not-submitted.pdf";
  await uploadInput.setInputFiles({
    name: pendingPrivateName,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nprivate pending file\n%%EOF")
  });
  await expect(uploadButton).toBeEnabled();
  await page.locator(".account-close").click();
  await page.getByRole("button", { name: userButtonName }).click();
  expect(
    await uploadInput.evaluate(
      (input: HTMLInputElement) => input.files?.length ?? -1
    )
  ).toBe(0);
  await expect(uploadButton).toBeDisabled();

  await uploadInput.setInputFiles({
    name: pendingPrivateName,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nprivate pending file\n%%EOF")
  });
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await login(adminEmail, adminPassword!);
  await page.locator(".ai-top-actions button").click();
  expect(
    await uploadInput.evaluate(
      (input: HTMLInputElement) => input.files?.length ?? -1
    )
  ).toBe(0);
  await expect(uploadButton).toBeDisabled();
  await expect(page.getByText(pendingPrivateName, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "退出登录" }).click();
  await login(userEmail!, userPassword!);
  await expect(page.getByRole("button", { name: userButtonName })).toBeVisible();
  await page.getByRole("button", { name: userButtonName }).click();

  await uploadInput.setInputFiles({
    name: "unsupported-e2e.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("unsupported")
  });
  const [rejectedUpload] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/uploads") &&
        response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "上传并保存" }).click()
  ]);
  expect(rejectedUpload.status()).toBe(400);
  await expect(page.locator(".account-message")).toContainText("仅支持");

  const uploadName = `e2e-ai-agreement-${Date.now()}.pdf`;
  await uploadInput.setInputFiles({
    name: uploadName,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF")
  });
  const [uploadResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/uploads") &&
        response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "上传并保存" }).click()
  ]);
  expect(uploadResponse.status()).toBe(201);
  await expect(page.locator(".account-message")).toContainText("材料已安全保存");
  await expect(page.locator('[data-product-sku="AI_DOCUMENT_REVIEW"]')).toBeVisible();

  const userUpload = page
    .getByRole("article")
    .filter({ hasText: uploadName })
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
    uploadName
  );
  expect(Number(userDownloadResponse.headers()["content-length"])).toBeGreaterThan(0);
  await page.getByRole("button", { name: "退出登录" }).click();
  await login(adminEmail, adminPassword!);
  await page.locator(".ai-top-actions button").click();
  await expect(
    page.getByRole("article").filter({ hasText: uploadName })
  ).toHaveCount(0);
  await page.getByRole("button", { name: "退出登录" }).click();
  await login(userEmail!, userPassword!);
  await expect(page.getByRole("button", { name: userButtonName })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: userButtonName })).toBeVisible();
  await page.getByRole("button", { name: userButtonName }).click();
  const reloadedUpload = page
    .getByRole("article")
    .filter({ hasText: uploadName })
    .first();
  await expect(reloadedUpload).toBeVisible();
  const [reloadedDownloadResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/api/uploads/") &&
        response.url().endsWith("/download")
    ),
    reloadedUpload.getByRole("button", { name: "下载", exact: true }).click()
  ]);
  expect(reloadedDownloadResponse.status()).toBe(200);
  expect(reloadedDownloadResponse.headers()["content-disposition"]).toContain(
    uploadName
  );
  await expect(
    page.getByRole("link", { name: "进入 AI 管理后台 →" })
  ).toHaveCount(0);
  await page.locator(".account-close").click();
  await page.goto(`${aiBaseUrl}/admin`);
  await expect(page.getByText("当前账号没有管理权限。")).toBeVisible();

  const adminContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 }
  });
  const adminPage = await adminContext.newPage();
  const adminErrors: string[] = [];
  const adminServerErrors: string[] = [];
  adminPage.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      adminErrors.push(message.text());
    }
  });
  adminPage.on("pageerror", (error) => adminErrors.push(error.message));
  adminPage.on("response", (response) => {
    if (response.status() >= 500) {
      adminServerErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  await adminPage.goto(`${aiBaseUrl}/admin`);
  await adminPage.getByRole("button", { name: "管理员登录" }).click();
  await adminPage.getByRole("button", { name: "密码登录" }).click();
  await adminPage.getByLabel("邮箱 / 手机号").fill(adminEmail);
  await adminPage.getByLabel("密码", { exact: true }).fill(adminPassword!);
  await adminPage
    .getByRole("dialog")
    .getByRole("button", { name: "登录", exact: true })
    .click();
  await expect(adminPage.getByRole("heading", { name: "经营概览" })).toBeVisible();

  await adminPage.getByRole("button", { name: /用户管理/ }).click();
  await expect(adminPage.getByText(userEmail!, { exact: true })).toBeVisible();
  await adminPage.getByRole("button", { name: /材料管理/ }).click();
  const uploadRow = adminPage.getByRole("row").filter({ hasText: uploadName }).first();
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
  expect(adminDownloadResponse.headers()["content-disposition"]).toContain(uploadName);
  expect(Number(adminDownloadResponse.headers()["content-length"])).toBeGreaterThan(0);
  await adminPage.getByRole("button", { name: /审计日志/ }).click();
  await expect(
    adminPage.getByText("upload.download", { exact: true }).first()
  ).toBeVisible();
  await adminPage.getByRole("button", { name: /系统状态/ }).click();
  await expect(adminPage.getByText("healthy", { exact: true })).toBeVisible();
  if (expectNotifierConfigured) {
    await expect(
      adminPage.getByText("已配置", { exact: true }).first()
    ).toBeVisible();
  } else {
    await expect(
      adminPage.getByText("待配置", { exact: true }).first()
    ).toBeVisible();
    await expect(adminPage.getByText("true", { exact: true })).toBeVisible();
  }
  await adminPage.screenshot({
    path: "test-results/production-ai-admin-system.png",
    fullPage: true
  });

  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  expect(serverErrors, serverErrors.join("\n")).toEqual([]);
  expect(adminErrors, adminErrors.join("\n")).toEqual([]);
  expect(adminServerErrors, adminServerErrors.join("\n")).toEqual([]);
  await adminContext.close();
});
