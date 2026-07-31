import { expect, test, type Page } from "@playwright/test";

const mainBaseUrl = process.env.E2E_MAIN_BASE_URL?.trim().replace(/\/$/, "");
const aiBaseUrl = process.env.E2E_AI_BASE_URL?.trim().replace(/\/$/, "");
const adminEmail = process.env.E2E_ADMIN_EMAIL;
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const targetUserEmail = process.env.E2E_TARGET_USER_EMAIL || process.env.E2E_USER_EMAIL;

const requiredEnvironment = () => {
  if (!mainBaseUrl || !aiBaseUrl || !adminEmail || !adminPassword || !targetUserEmail) {
    throw new Error(
      "E2E_MAIN_BASE_URL, E2E_AI_BASE_URL, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD and E2E_TARGET_USER_EMAIL are required"
    );
  }
};

const watchRuntime = (page: Page) => {
  const browserErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });
  return () => {
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
    expect(serverErrors, serverErrors.join("\n")).toEqual([]);
  };
};

const loginAdmin = async (page: Page, baseUrl: string) => {
  await page.goto(`${baseUrl}/admin`);
  await page.getByRole("button", { name: "管理员登录" }).click();
  const dialog = page.getByRole("dialog", { name: "登录赔了么" });
  await dialog.getByRole("button", { name: "密码登录" }).click();
  await dialog.getByLabel("邮箱 / 手机号").fill(adminEmail!);
  await dialog.getByLabel("密码", { exact: true }).fill(adminPassword!);
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "经营概览" })).toBeVisible();
};

const visitAndRefresh = async (
  page: Page,
  tabs: ReadonlyArray<readonly [string, string]>
) => {
  for (const [tab, heading] of tabs) {
    await page.getByRole("button", { name: new RegExp(tab) }).click();
    await expect(page.getByRole("heading", { level: 1, name: tab })).toBeVisible();
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    await page.getByRole("button", { name: "刷新数据" }).click();
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }
};

const baseTabs = [
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

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.beforeAll(requiredEnvironment);

test("主站后台逐导航刷新、产品隔离和退出按钮", async ({ page }) => {
  const expectNoRuntimeFailures = watchRuntime(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginAdmin(page, mainBaseUrl!);
  await visitAndRefresh(page, baseTabs);
  await page.getByRole("button", { name: /用户管理/ }).click();
  await expect(page.getByLabel("政策测算首次次数")).toBeVisible();
  await expect(page.getByText("AI 离职分析", { exact: true })).toHaveCount(0);
  await expect(page.getByText("AI 文件审查", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page).toHaveURL(`${mainBaseUrl}/`);
  expectNoRuntimeFailures();
});

test("AI 后台首次权益、人工补发、账号状态角色和邀请码全部 Happy/Unhappy", async ({
  page
}) => {
  const expectNoRuntimeFailures = watchRuntime(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await loginAdmin(page, aiBaseUrl!);
  await visitAndRefresh(page, [
    ...baseTabs.slice(0, 6),
    ["材料管理", "用户材料"],
    ...baseTabs.slice(6)
  ]);

  await page.getByRole("button", { name: /用户管理/ }).click();
  const firstUseCard = page.getByRole("region", { name: "首次权益配置" });
  for (const label of ["AI 离职分析", "AI 文件审查"]) {
    const setting = firstUseCard.locator(".admin-entitlement-setting").filter({ hasText: label });
    const input = setting.getByLabel(`${label}首次次数`);
    const original = Number(await input.inputValue());
    await input.fill("0");
    await expect(setting.getByRole("button", { name: "保存" })).toBeDisabled();
    const temporary = original >= 100 ? original - 1 : original + 1;
    await input.fill(String(temporary));
    await setting.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("status")).toContainText(`${label}首次权益已保存`);
    await input.fill(String(original));
    await setting.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("status")).toContainText(`${label}首次权益已保存`);
  }

  let userRow = page.getByRole("row").filter({ hasText: targetUserEmail! }).first();
  await expect(userRow).toBeVisible();
  await userRow.getByRole("button", { name: "发放次数" }).click();
  const grantCard = page.getByRole("region", { name: "发放使用次数" });
  await grantCard.getByLabel("发放权益类型").selectOption("AI_SEVERANCE_ANALYSIS");
  await grantCard.getByLabel("发放次数").fill("0");
  await grantCard.getByLabel("发放原因").fill("生产验收补发");
  await expect(grantCard.getByRole("button", { name: "确认发放" })).toBeDisabled();
  await grantCard.getByLabel("发放次数").fill("1");
  await grantCard.getByLabel("权益到期时间").fill("2025-01-01T00:00");
  await grantCard.getByRole("button", { name: "确认发放" }).click();
  await expect(page.locator(".admin-error")).toContainText("到期时间必须晚于当前时间");
  await grantCard.getByLabel("权益到期时间").fill("2099-01-01T00:00");
  await grantCard.getByRole("button", { name: "确认发放" }).click();
  await expect(page.getByRole("status")).toContainText("发放 1 次AI 离职分析");

  userRow = page.getByRole("row").filter({ hasText: targetUserEmail! }).first();
  await userRow.getByRole("button", { name: "停用" }).click();
  userRow = page.getByRole("row").filter({ hasText: targetUserEmail! }).first();
  await expect(userRow.getByRole("button", { name: "启用" })).toBeVisible();
  await userRow.getByRole("button", { name: "启用" }).click();
  userRow = page.getByRole("row").filter({ hasText: targetUserEmail! }).first();
  await expect(userRow.getByRole("button", { name: "停用" })).toBeVisible();
  await userRow.getByRole("button", { name: "设为分析员" }).click();
  userRow = page.getByRole("row").filter({ hasText: targetUserEmail! }).first();
  await expect(userRow.getByRole("button", { name: "降为用户" })).toBeVisible();
  await userRow.getByRole("button", { name: "降为用户" }).click();
  userRow = page.getByRole("row").filter({ hasText: targetUserEmail! }).first();
  await expect(userRow.getByRole("button", { name: "设为分析员" })).toBeVisible();

  await page.getByRole("button", { name: /邀请码/ }).click();
  const inviteForm = page.locator(".admin-invite-form");
  const description = `后台逐按钮验收 ${Date.now()}`;
  await inviteForm.getByPlaceholder("用途备注，例如：首批内测用户").fill(description);
  await inviteForm.getByPlaceholder("可用次数").fill("100001");
  await inviteForm.getByRole("button", { name: "生成全功能邀请码" }).click();
  await expect(page.locator(".admin-error")).toBeVisible();
  await inviteForm.getByPlaceholder("可用次数").fill("2");
  await inviteForm.getByRole("button", { name: "生成全功能邀请码" }).click();
  let inviteRow = page.getByRole("row").filter({ hasText: description }).first();
  await expect(inviteRow).toBeVisible();
  await inviteRow.getByRole("button", { name: "停用" }).click();
  inviteRow = page.getByRole("row").filter({ hasText: description }).first();
  await expect(inviteRow.getByRole("button", { name: "启用" })).toBeVisible();
  await inviteRow.getByRole("button", { name: "启用" }).click();
  inviteRow = page.getByRole("row").filter({ hasText: description }).first();
  await expect(inviteRow.getByRole("button", { name: "停用" })).toBeVisible();

  await page.getByRole("button", { name: /系统状态/ }).click();
  await expect(page.getByRole("heading", { name: "AI 异步 Worker" })).toBeVisible();
  await expect(page.getByText("healthy", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page).toHaveURL(`${aiBaseUrl}/`);
  expectNoRuntimeFailures();
});
