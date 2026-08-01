import { expect, test, type Page } from "@playwright/test";

const aiBaseUrl = process.env.E2E_AI_BASE_URL?.trim().replace(/\/$/, "");
const userEmail = process.env.E2E_USER_EMAIL;
const userPassword = process.env.E2E_USER_PASSWORD;

const requiredEnvironment = () => {
  if (!aiBaseUrl || !userEmail || !userPassword) {
    throw new Error(
      "E2E_AI_BASE_URL, E2E_USER_EMAIL and E2E_USER_PASSWORD are required"
    );
  }
};

const sendInput = async (page: Page, label: string, value: string) => {
  await page.getByLabel(label).fill(value);
  await page.getByRole("button", { name: "发送", exact: true }).click();
};

test("AI 站内完成政策测算、未确认拦截、历史与登录态连续链路", async ({ page }) => {
  requiredEnvironment();
  const browserErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(aiBaseUrl!);
  await page.getByRole("link", { name: "政策测算", exact: true }).click();
  await expect(page).toHaveURL(`${aiBaseUrl}/policy`);
  await page.reload();
  await expect(page.getByText("和 AI 分析共享账号与历史", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "登录", exact: true }).click();
  const login = page.getByRole("dialog", { name: "登录赔了么" });
  await login.getByRole("button", { name: "密码登录" }).click();
  await login.getByLabel("邮箱 / 手机号").fill(userEmail!);
  await login.getByLabel("密码", { exact: true }).fill(userPassword!);
  await login.getByRole("button", { name: "登录", exact: true }).click();
  await expect(login).toBeHidden();

  await page.getByRole("button", { name: "上海", exact: true }).click();
  await sendInput(page, "入职日期", "2020-01-01");
  await sendInput(page, "解除日期", "2026-07-01");
  await page.getByRole("button", { name: "基本双休，很少加班", exact: true }).click();
  await sendInput(page, "税前基础月工资（元）", "15000");
  await page.getByRole("button", { name: "没有年终奖", exact: true }).click();
  await page.getByRole("button", { name: /单位要辞退我/ }).click();
  await page.getByRole("button", { name: /我没错.*客观原因要辞退我/ }).click();
  await page.getByRole("button", { name: /说我没能力干这份工作/ }).click();
  await page.getByRole("button", { name: "是", exact: true }).click();
  await page.getByRole("button", { name: /先大吃特吃一顿/ }).click();

  const calculate = page.getByRole("button", { name: "生成政策测算" });
  await expect(calculate).toBeDisabled();
  await page.getByRole("checkbox", { name: /我已按工资条或流水逐月核对/ }).check();
  await expect(calculate).toBeEnabled();
  const [calculation] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/api/policy/calculate") &&
      response.request().method() === "POST"
    ),
    calculate.click()
  ]);
  expect(calculation.status()).toBe(201);
  await expect(page.getByRole("heading", { name: /测算结果/ })).toBeVisible();

  await page.getByRole("button", { name: /历史/ }).first().click();
  const account = page.getByRole("dialog");
  await expect(account.getByText(/政策测算历史/)).toBeVisible();
  await account.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("link", { name: "AI 深度分析", exact: true }).click();
  await expect(page).toHaveURL(`${aiBaseUrl}/`);
  await expect(page.getByRole("heading", { name: "离职补偿深度分析" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "离职补偿深度分析" })).toBeVisible();
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  expect(serverErrors, serverErrors.join("\n")).toEqual([]);
});
