import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const userEmail = process.env.E2E_USER_EMAIL;
const userPassword = process.env.E2E_USER_PASSWORD || "E2eUserPass123";
const adminEmail = process.env.E2E_ADMIN_EMAIL || "admin@peileme.art";
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const inviteCode = process.env.E2E_INVITE_CODE;
const requiredEnvironmentReady = Boolean(userEmail && adminPassword && inviteCode);

test("生产环境完整真实用户链路", async ({ page, browser }) => {
  test.skip(!requiredEnvironmentReady, "需要 E2E_USER_EMAIL、E2E_ADMIN_PASSWORD、E2E_INVITE_CODE");
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/");
  await expect(page).toHaveTitle(/赔了么/);
  await page.getByRole("button", { name: "上海", exact: true }).click();

  const monthInput = page.locator(".composer input[type=month]");
  await monthInput.fill("2020-01");
  await page.locator(".composer").getByRole("button", { name: "发送" }).click();
  await monthInput.fill("2026-07");
  await page.locator(".composer").getByRole("button", { name: "发送" }).click();

  await page.getByRole("button", { name: "双休，但工作日经常晚下班", exact: true }).click();
  const salaryInput = page.locator(".composer input").first();
  await salaryInput.fill("15000");
  await page.locator(".composer").getByRole("button", { name: "发送" }).click();
  await page.getByRole("button", { name: "2个月工资左右", exact: true }).click();
  await page.getByRole("button", { name: /完全没有了/ }).click();
  await page.getByRole("button", { name: /宅家躺到爽/ }).click();
  await page.getByRole("button", { name: "计算你的牛马身价" }).click();

  await expect(page.getByText("你的牛马身价（离职赔偿金）")).toBeVisible();
  await page.screenshot({
    path: "test-results/production-mobile-result.png",
    fullPage: false
  });

  await page.getByRole("button", { name: "解锁完整案例法条包" }).first().click();
  await page.getByRole("button", { name: "登录 / 注册" }).click();
  await page.getByRole("button", { name: "第一次来？注册账号" }).click();
  await page.getByLabel("邮箱 / 手机号").fill(userEmail!);
  await page.getByRole("button", { name: "获取验证码" }).click();
  const codeMessage = page.locator(".account-message");
  await expect(codeMessage).toContainText("开发验证码：");
  const code = (await codeMessage.textContent())?.match(/\d{6}/)?.[0];
  expect(code).toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6 位验证码").fill(code!);
  await page.getByLabel(/设置密码/).fill(userPassword);
  await page.getByLabel("称呼（可选）").fill("生产走查用户");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByRole("button", { name: "生产走查" })).toBeVisible();

  await page.getByRole("button", { name: "生产走查" }).click();
  const inviteInput = page.getByPlaceholder("输入邀请码");
  await inviteInput.fill("INVALID-E2E");
  await page.getByRole("button", { name: "兑换" }).click();
  await expect(page.locator(".account-message")).toContainText("邀请码无效");
  await inviteInput.fill(inviteCode!);
  await page.getByRole("button", { name: "兑换" }).click();
  await expect(page.locator(".account-message")).toContainText("案例法条包");
  await expect(page.getByText("✓ 离职证据包")).toBeVisible();
  await expect(page.getByText("✓ 文件签署分析")).toBeVisible();
  await expect(page.getByText(/上海 · 已完成/)).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();

  await expect(page.getByRole("button", { name: "下载案例法条包" })).toBeVisible();
  const fixture = path.join(currentDir, "fixtures", "e2e-agreement.pdf");
  await page.locator(".compact-upload input[type=file]").setInputFiles(fixture);
  await expect(page.getByText("材料已加密通道上传，并保存到你的账号。")).toBeVisible();
  await expect(page.getByText("已上传：e2e-agreement.pdf")).toBeVisible();

  await page.getByRole("button", { name: "生产走查" }).click();
  await expect(page.getByText("e2e-agreement.pdf")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("e2e-agreement.pdf");
  await page.getByRole("button", { name: "关闭" }).click();

  await page.reload();
  await expect(page.getByRole("button", { name: "生产走查" })).toBeVisible();
  await expect(page.getByText("你的牛马身价（离职赔偿金）")).toBeVisible();

  await page.goto("/admin");
  await expect(page.getByText("当前账号没有管理权限。")).toBeVisible();

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
  await adminPage.getByRole("button", { name: "登录", exact: true }).click();
  await expect(adminPage.getByRole("heading", { name: "经营概览" })).toBeVisible();

  await adminPage.getByRole("button", { name: /用户管理/ }).click();
  await expect(adminPage.getByText(userEmail!, { exact: true })).toBeVisible();
  await adminPage.getByRole("button", { name: /测算记录/ }).click();
  await expect(adminPage.getByText("上海", { exact: true }).first()).toBeVisible();
  await adminPage.getByRole("button", { name: /材料管理/ }).click();
  await expect(adminPage.getByText("e2e-agreement.pdf", { exact: true })).toBeVisible();
  const adminDownloadPromise = adminPage.waitForEvent("download");
  await adminPage.getByRole("button", { name: "下载", exact: true }).click();
  expect((await adminDownloadPromise).suggestedFilename()).toContain("e2e-agreement.pdf");
  await adminPage.getByRole("button", { name: /埋点统计/ }).click();
  await expect(adminPage.getByText("assessment_completed", { exact: true })).toBeVisible();
  await adminPage.getByRole("button", { name: /审计日志/ }).click();
  await expect(adminPage.getByText("invite.create", { exact: false }).first()).toBeVisible();
  await adminPage.getByRole("button", { name: /系统状态/ }).click();
  await expect(adminPage.getByText("已配置", { exact: true }).first()).toBeVisible();
  await adminPage.screenshot({
    path: "test-results/production-admin-system.png",
    fullPage: true
  });

  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  expect(adminErrors, adminErrors.join("\n")).toEqual([]);
  await adminContext.close();
});
