import { expect, test } from "@playwright/test";

const email = process.env.E2E_REGISTER_EMAIL;
const password = process.env.E2E_REGISTER_PASSWORD || "E2eRegisterPass123";

test("生产验证码注册与会话刷新", async ({ page }) => {
  test.skip(!email, "需要 E2E_REGISTER_EMAIL，且 API 临时启用 OTP_DEBUG");
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
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "第一次来？注册账号" }).click();
  await page.getByLabel("邮箱 / 手机号").fill(email!);
  await page.getByRole("button", { name: "获取验证码" }).click();
  const message = page.locator(".account-message");
  await expect(message).toContainText("开发验证码：");
  const code = (await message.textContent())?.match(/\d{6}/)?.[0];
  expect(code).toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6 位验证码").fill(code!);
  await page.getByLabel(/设置密码/).fill(password);
  await page.getByLabel("称呼（可选）").fill("注册链路验收");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByRole("button", { name: "注册链路" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "注册链路" })).toBeVisible();

  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  expect(serverErrors, serverErrors.join("\n")).toEqual([]);
});
