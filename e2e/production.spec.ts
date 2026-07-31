import { expect, test, type Page } from "@playwright/test";

const baseUrl = process.env.E2E_BASE_URL;
const userEmail = process.env.E2E_USER_EMAIL;
const userPassword = process.env.E2E_USER_PASSWORD;
const userButtonName = process.env.E2E_USER_BUTTON_NAME || "核心验收";

const sendInput = async (page: Page, label: string, value: string) => {
  await page.getByLabel(label).fill(value);
  await page.getByRole("button", { name: "发送", exact: true }).click();
};

test("生产移动端完整测算链路", async ({ page }) => {
  test.skip(
    !baseUrl || !userEmail || !userPassword,
    "需要 E2E_BASE_URL、E2E_USER_EMAIL、E2E_USER_PASSWORD"
  );
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
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/");
  await expect(page).toHaveTitle("赔了么 - 牛马身价预评估");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登录赔了么" });
  await dialog.getByRole("button", { name: "密码登录" }).click();
  await dialog.getByLabel("邮箱 / 手机号").fill(userEmail!);
  await dialog.getByLabel("密码", { exact: true }).fill(userPassword!);
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: userButtonName, exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "上海", exact: true }).click();
  await sendInput(page, "入职日期", "2020-01-01");
  await sendInput(page, "解除日期", "2026-07-01");
  await page
    .getByRole("button", { name: "基本双休，很少加班", exact: true })
    .click();
  await sendInput(page, "税前基础月工资（元）", "15000");
  await page
    .getByRole("button", { name: "没有年终奖", exact: true })
    .click();
  await page.getByRole("button", { name: /单位要辞退我/ }).click();
  await page
    .getByRole("button", { name: /我没错.*客观原因要辞退我/ })
    .click();
  await page
    .getByRole("button", { name: /说我没能力干这份工作/ })
    .click();
  await page.getByRole("button", { name: "是", exact: true }).click();
  await page.getByRole("button", { name: /先大吃特吃一顿/ }).click();
  await page
    .getByRole("checkbox", { name: /我已按工资条或流水逐月核对/ })
    .check();
  const minimumWage = page.getByLabel("当地最低月工资（元）");
  if (await minimumWage.isVisible()) await minimumWage.fill("2690");
  const averageWage = page.getByLabel("当地上年度职工月平均工资（元）");
  if (await averageWage.isVisible()) await averageWage.fill("12307");
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();

  const result = page.getByRole("region", { name: "政策测算结果" });
  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toBeVisible();
  await expect(result).toContainText(/规则版本 v\d+/);
  await expect(result).toContainText("完整计算公式");
  await expect(page.getByRole("link", { name: /查看官方来源/ }).first())
    .toBeVisible();
  await page.screenshot({
    path: "test-results/production-mobile-result.png",
    fullPage: true
  });
  expect(serverErrors, serverErrors.join("\n")).toEqual([]);
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
});
